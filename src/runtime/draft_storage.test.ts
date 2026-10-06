import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
beforeEach(() => {
  vi.resetModules();
  mock.invoke.mockReset();
});

const saved = () => ({
  version: 1,
  composers: {
    new: {
      text: "keep this",
      attachments: [
        {
          id: "f",
          name: "notes.md",
          kind: "file",
          uri: "file:///notes.md",
          content: "stale",
        },
      ],
      sendPending: true,
    },
  },
  choice: {
    agentId: "a",
    cwd: "/work",
    service: { id: "service", model: "model", revision: "r" },
    config: { thought_level: "high" },
  },
  feedback: {
    a: {
      "/notes.md": { text: "shorten", selection: { side: "after", line: 2 } },
    },
  },
  queues: {
    a: { blocks: [[{ type: "text", text: "waiting" }]], uncertainIndex: 0 },
  },
});

it("restores user drafts, choices, file feedback and paused queue without dispatching or trusting old attachment contents", async () => {
  mock.invoke.mockResolvedValue(saved());
  const d = await import("./drafts");
  await d.draftPersistence.load();
  expect(d.composerDrafts.read("new")).toMatchObject({
    text: "keep this",
    sendPending: true,
  });
  expect(d.composerDrafts.read("new").attachments[0]).toMatchObject({
    recovered: true,
  });
  expect(d.composerDrafts.read("new").attachments[0].content).toBeUndefined();
  expect(d.newConversationChoice.service?.id).toBe("service");
  expect(d.fileFeedbackDrafts.read("a", "/notes.md").selection?.line).toBe(2);
  expect(d.hasUnsentWork("a")).toBe(true);
  expect(d.draftQueues.read("a")?.uncertainIndex).toBe(0);
  expect(mock.invoke.mock.calls.map(([name]) => name)).toEqual([
    "settings_get",
  ]);
});

it("does not overwrite unread, corrupt, or newer-format saved content", async () => {
  mock.invoke.mockResolvedValue({ ...saved(), version: 2 });
  const d = await import("./drafts");
  await expect(d.draftPersistence.load()).rejects.toThrow();
  d.composerDrafts.update("new", () => ({ text: "new", attachments: [] }));
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(
    mock.invoke.mock.calls.every(([name]) => name === "settings_get"),
  ).toBe(true);
});

it("round-trips range and unfinished location feedback without replacing legacy opinions or queued work", async () => {
  mock.invoke.mockResolvedValue(saved());
  const d = await import("./drafts");
  await d.draftPersistence.load();
  const queue = structuredClone(d.draftQueues.read("a"));
  d.fileFeedbackDrafts.update("a", "/notes.md", {
    text: "range opinion",
    selection: { side: "before", line: 2, endLine: 4 },
    lineInput: { side: "before", text: "2–4" },
    contentId: "range-version",
    scope: "fragment",
  });
  d.fileFeedbackDrafts.update("a", "/notes.md", {
    text: "unfinished location opinion",
    selection: null,
    lineInput: { side: "after", text: "8–" },
    contentId: "unfinished-version",
    scope: "fragment",
  });
  await d.draftPersistence.flush();
  const written = mock.invoke.mock.calls
    .filter(([name]) => name === "settings_set")
    .at(-1)![1].value;
  vi.resetModules();
  mock.invoke.mockResolvedValue(written);
  const restored = await import("./drafts");
  await restored.draftPersistence.load();
  expect(Object.keys(restored.fileFeedbackDrafts.entries("a"))).toHaveLength(3);
  expect(
    Object.values(restored.fileFeedbackDrafts.entries("a")),
  ).toContainEqual(
    expect.objectContaining({
      text: "shorten",
      selection: { side: "after", line: 2 },
    }),
  );
  expect(
    restored.fileFeedbackDrafts.read("a", "/notes.md", "range-version"),
  ).toMatchObject({
    selection: { side: "before", line: 2, endLine: 4 },
    lineInput: { side: "before", text: "2–4" },
  });
  expect(
    restored.fileFeedbackDrafts.read("a", "/notes.md", "unfinished-version"),
  ).toMatchObject({
    text: "unfinished location opinion",
    selection: null,
    lineInput: { side: "after", text: "8–" },
  });
  expect(restored.draftQueues.read("a")).toEqual(queue);
  expect(restored.composerDrafts.read("new").text).toBe("keep this");
});

it("migrates an old path-only opinion without attaching its line to a new version, and preserves both across restart", async () => {
  const legacy = saved();
  mock.invoke.mockImplementation(async (command) =>
    command === "settings_get" ? legacy : undefined,
  );
  const d = await import("./drafts");
  await d.draftPersistence.load();
  expect(d.fileFeedbackDrafts.read("a", "/notes.md", "new-content").text).toBe(
    "",
  );
  d.fileFeedbackDrafts.update("a", "/notes.md", {
    text: "new version opinion",
    contentId: "new-content",
    scope: "fragment",
    selection: { side: "before", line: 1 },
  });
  await d.draftPersistence.flush();
  const written = structuredClone(
    mock.invoke.mock.calls
      .filter(([name]) => name === "settings_set")
      .at(-1)![1].value,
  );
  const entries = Object.values(written.feedback.a);
  expect(entries).toHaveLength(2);
  expect(entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "/notes.md",
        text: "shorten",
        selection: { side: "after", line: 2 },
      }),
      expect.objectContaining({
        path: "/notes.md",
        contentId: "new-content",
        text: "new version opinion",
        scope: "fragment",
      }),
    ]),
  );
  expect(written).not.toHaveProperty("items");
  vi.resetModules();
  mock.invoke.mockImplementation(async (command) =>
    command === "settings_get" ? written : undefined,
  );
  const restored = await import("./drafts");
  await restored.draftPersistence.load();
  expect(Object.keys(restored.fileFeedbackDrafts.entries("a"))).toHaveLength(2);
  expect(
    restored.fileFeedbackDrafts.read("a", "/notes.md", "new-content"),
  ).toMatchObject({
    text: "new version opinion",
    selection: { side: "before", line: 1 },
  });
  expect(restored.unsentConversationKeys()).toContain("a");
});

it("moves exactly one version into its existing draft in a single save snapshot, retaining other versions and failed saves", async () => {
  let fail = false;
  mock.invoke.mockImplementation(async (command) => {
    if (command === "settings_get") return null;
    if (fail) throw new Error("disk full");
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  d.composerDrafts.update("session:a", () => ({
    text: "original",
    attachments: [],
  }));
  for (const contentId of ["v1", "v2"])
    d.fileFeedbackDrafts.update("a", "/notes.md", {
      text: contentId,
      selection: null,
      contentId,
      scope: "fragment",
    });
  await d.draftPersistence.flush();
  mock.invoke.mockClear();
  fail = true;
  expect(
    d.fileFeedbackDrafts.take(
      "a",
      d.fileFeedbackKey("/notes.md", "v1"),
      "reviewed v1",
    ),
  ).toBe(true);
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(d.composerDrafts.read("session:a").text).toBe(
    "original\n\nreviewed v1",
  );
  expect(d.fileFeedbackDrafts.read("a", "/notes.md", "v2").text).toBe("v2");
  expect(
    d.fileFeedbackDrafts.take(
      "a",
      d.fileFeedbackKey("/notes.md", "v1"),
      "duplicate",
    ),
  ).toBe(false);
  fail = false;
  await d.draftPersistence.flush();
  const written = mock.invoke.mock.calls
    .filter(([name]) => name === "settings_set")
    .at(-1)![1].value;
  expect(written.composers["session:a"].text).toBe("original\n\nreviewed v1");
  expect(Object.values(written.feedback.a)).toEqual([
    expect.objectContaining({ text: "v2" }),
  ]);
  expect(
    mock.invoke.mock.calls.every(([name]) => name === "settings_set"),
  ).toBe(true);
});

it("reports only existing conversation identities with drafts, opinions, queue edits or queued messages", async () => {
  mock.invoke.mockResolvedValue(null);
  const d = await import("./drafts");
  await d.draftPersistence.load();
  d.composerDrafts.update("new", () => ({ text: "global", attachments: [] }));
  d.composerDrafts.update("session:message", () => ({
    text: "message",
    attachments: [],
  }));
  d.composerDrafts.update("queue-edit:editing", () => ({
    text: "changed",
    attachments: [],
    queueEdit: { index: 0, original: [{ type: "text", text: "original" }] },
  }));
  d.fileFeedbackDrafts.update("opinion", "/file", {
    text: "review",
    selection: null,
    contentId: "v1",
  });
  d.draftQueues.write("queued", [[{ type: "text", text: "later" }]], null);
  expect(d.unsentConversationKeys().sort()).toEqual([
    "editing",
    "message",
    "opinion",
    "queued",
  ]);
  await d.draftPersistence.flush();
});

it("serializes writes and retains a newer edit while the older save is in flight", async () => {
  let finish!: () => void;
  const written: unknown[] = [];
  mock.invoke.mockImplementation(async (name, input) => {
    if (name === "settings_get") return null;
    written.push(input.value);
    if (written.length === 1)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  d.composerDrafts.update("new", () => ({ text: "first", attachments: [] }));
  await vi.waitFor(() => expect(written).toHaveLength(1));
  d.composerDrafts.update("new", () => ({ text: "second", attachments: [] }));
  finish();
  await d.draftPersistence.flush();
  expect(written).toHaveLength(2);
  expect(written[1]).toMatchObject({ composers: { new: { text: "second" } } });
});

it("keeps unsaved content visible and retries the newest value after a failed save", async () => {
  let failing = true;
  mock.invoke.mockImplementation(async (name) => {
    if (name === "settings_get") return null;
    if (failing) throw new Error("disk full");
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  d.composerDrafts.update("new", () => ({ text: "keep", attachments: [] }));
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(d.composerDrafts.read("new").text).toBe("keep");
  failing = false;
  await d.draftPersistence.flush();
  expect(d.draftPersistence.snapshot().error).toBeNull();
});

it("stores only user input, not transient tests or cached file body; queue snapshots do not share mutable references", async () => {
  mock.invoke.mockResolvedValue(null);
  const d = await import("./drafts");
  await d.draftPersistence.load();
  d.composerDrafts.update("prepare:test", () => ({
    text: "probe",
    attachments: [],
  }));
  d.composerDrafts.update("new", () => ({
    text: "",
    attachments: [
      { id: "f", kind: "file", name: "n", uri: "file:///n", content: "old" },
    ],
  }));
  d.draftQueues.write("a", [[{ type: "text", text: "pending" }]], null);
  const first = d.draftQueues.read("a")!;
  first.blocks.length = 0;
  expect(d.draftQueues.read("a")?.blocks).toHaveLength(1);
  await d.draftPersistence.flush();
  const latest = mock.invoke.mock.calls
    .filter(([name]) => name === "settings_set")
    .at(-1)![1].value;
  expect(latest.composers["prepare:test"]).toBeUndefined();
  expect(latest.composers.new.attachments[0].content).toBeUndefined();
});

it("does not persist or restore an image preview check, while retaining its source and unsent data", async () => {
  mock.invoke.mockResolvedValue(null);
  const d = await import("./drafts");
  await d.draftPersistence.load();
  const checked = {
    data: "kept image bytes",
    mimeType: "image/png",
    uri: "file:///own.png",
  };
  const attachment = {
    id: "image",
    kind: "image" as const,
    name: "own.png",
    ...checked,
    imageChecked: checked,
  };
  d.composerDrafts.update("new", () => ({
    text: "Keep",
    attachments: [attachment],
  }));
  await d.draftPersistence.flush();
  const latest = mock.invoke.mock.calls
    .filter(([name]) => name === "settings_set")
    .at(-1)![1].value;
  expect(latest.composers.new.attachments[0]).not.toHaveProperty(
    "imageChecked",
  );
  latest.composers.new.attachments[0].imageChecked = checked;
  mock.invoke.mockResolvedValue(latest);
  vi.resetModules();
  const restored = await import("./drafts");
  await restored.draftPersistence.load();
  const image = restored.composerDrafts.read("new").attachments[0]!;
  expect(image).toMatchObject({ ...checked, recovered: true });
  expect(image).not.toHaveProperty("imageChecked");
});

it("persists and restores a first-message native target without restoring any transcript", async () => {
  const target = {
    agentId: "a",
    cwd: "/work",
    nativeSessionId: "native-unknown",
    service: { id: "api", model: "chosen" },
    serviceRevision: "revision",
  };
  mock.invoke.mockImplementation(async (name) =>
    name === "settings_get" ? null : undefined,
  );
  const first = await import("./drafts");
  await first.draftPersistence.load();
  first.composerDrafts.update("new", () => ({
    text: "unconfirmed input",
    attachments: [],
    sendPending: true,
    pendingConversation: target,
  }));
  await first.draftPersistence.flush();
  const written = mock.invoke.mock.calls
    .filter(([name]) => name === "settings_set")
    .at(-1)![1].value;
  expect(written.composers.new.pendingConversation).toEqual(target);
  expect(written.composers.new).not.toHaveProperty("items");
  vi.resetModules();
  mock.invoke.mockResolvedValue(written);
  const restored = await import("./drafts");
  await restored.draftPersistence.load();
  expect(restored.composerDrafts.read("new")).toMatchObject({
    text: "unconfirmed input",
    sendPending: true,
    pendingConversation: target,
  });
});

it("waits for an unfinished pasted image before allowing the final save to complete", async () => {
  mock.invoke.mockResolvedValue(null);
  const d = await import("./drafts");
  await d.draftPersistence.load();
  let read!: () => void;
  const reading = new Promise<void>((resolve) => {
    read = resolve;
  }).then(() => {
    d.composerDrafts.update("new", () => ({
      text: "",
      attachments: [
        {
          id: "image",
          kind: "image",
          name: "pasted.png",
          data: "actual-image-bytes",
          mimeType: "image/png",
        },
      ],
    }));
  });
  d.draftPersistence.trackAttachment(reading);
  d.composerDrafts.update("new", () => ({
    text: "",
    attachments: [
      { id: "image", kind: "image", name: "pasted.png", loading: true },
    ],
  }));
  let done = false;
  const flush = d.draftPersistence.flush().then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(done).toBe(false);
  expect(
    mock.invoke.mock.calls.filter(([name]) => name === "settings_set"),
  ).toHaveLength(0);
  read();
  await flush;
  const writes = mock.invoke.mock.calls.filter(
    ([name]) => name === "settings_set",
  );
  expect(writes.at(-1)?.[1].value.composers.new.attachments[0].data).toBe(
    "actual-image-bytes",
  );
});

it("rejects same-version unsent extensions before an edit can overwrite the original value", async () => {
  const original = {
    ...saved(),
    future: { text: "retain unknown unsent data" },
  };
  let disk: unknown = structuredClone(original);
  mock.invoke.mockImplementation(async (command, input) => {
    if (command === "settings_get") return structuredClone(disk);
    if (command === "settings_set") disk = structuredClone(input.value);
  });
  const d = await import("./drafts");
  const reading = await Promise.allSettled([d.draftPersistence.load()]);
  d.composerDrafts.update("new", () => ({
    text: "local edit",
    attachments: [],
  }));
  const flushing = await Promise.allSettled([d.draftPersistence.flush()]);
  expect(reading[0].status).toBe("rejected");
  expect(flushing[0].status).toBe("rejected");
  expect(d.draftPersistence.snapshot().ready).toBe(false);
  expect(
    mock.invoke.mock.calls.every(([command]) => command === "settings_get"),
  ).toBe(true);
  expect(disk).toEqual(original);
  expect(d.composerDrafts.read("new").text).toBe("local edit");
  disk = saved();
  await d.draftPersistence.load();
  await d.draftPersistence.flush();
  expect(d.draftPersistence.snapshot().ready).toBe(true);
  expect(d.composerDrafts.read("new").text).toBe("local edit");
  expect(d.newConversationChoice.service).toEqual(saved().choice.service);
  expect(d.draftQueues.read("a")).toEqual(saved().queues.a);
});

it("does not write local unsent edits when reading fails and retains them through explicit retry", async () => {
  const original = saved();
  let disk: unknown = structuredClone(original);
  let failRead = true;
  mock.invoke.mockImplementation(async (command, input) => {
    if (command === "settings_get") {
      if (failRead) throw new Error("fixture read failed");
      return structuredClone(disk);
    }
    if (command === "settings_set") disk = structuredClone(input.value);
  });
  const d = await import("./drafts");
  await expect(d.draftPersistence.load()).rejects.toThrow();
  d.composerDrafts.update("new", () => ({
    text: "keep local edit",
    attachments: [],
  }));
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(d.draftPersistence.snapshot().ready).toBe(false);
  expect(
    mock.invoke.mock.calls.every(([command]) => command === "settings_get"),
  ).toBe(true);
  expect(disk).toEqual(original);
  failRead = false;
  await d.draftPersistence.load();
  await d.draftPersistence.flush();
  expect(d.composerDrafts.read("new").text).toBe("keep local edit");
  expect(disk).toMatchObject({
    composers: { new: { text: "keep local edit" } },
  });
});

it("loads an old unsent value without activity without writing, then preserves its work across save and restart", async () => {
  let disk: unknown = saved();
  mock.invoke.mockImplementation(async (command, input) => {
    if (command === "settings_get") return structuredClone(disk);
    if (command === "settings_set") disk = structuredClone(input.value);
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  expect(
    mock.invoke.mock.calls.every(([command]) => command === "settings_get"),
  ).toBe(true);
  expect(d.composerDrafts.read("new").text).toBe("keep this");
  expect(d.newConversationChoice.service).toEqual(saved().choice.service);
  expect(d.draftQueues.read("a")).toEqual(saved().queues.a);
  d.composerDrafts.update("new", (current) => ({
    ...current,
    text: "explicit edit",
  }));
  await d.draftPersistence.flush();
  expect(disk).toMatchObject({ activity: {} });
  vi.resetModules();
  const restored = await import("./drafts");
  await restored.draftPersistence.load();
  expect(restored.composerDrafts.read("new").text).toBe("explicit edit");
  expect(restored.newConversationChoice.service).toEqual(
    saved().choice.service,
  );
  expect(restored.draftQueues.read("a")).toEqual(saved().queues.a);
  expect(restored.fileFeedbackDrafts.read("a", "/notes.md").text).toBe(
    "shorten",
  );
});
