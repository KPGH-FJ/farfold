// Exercise the production picker -> preparation -> blocks -> common drain.
// Only the native boundary is synthetic; no file, Agent or application is run.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DraftAttachment } from "./drafts";
import type { PromptBlock } from "./session_types";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("./audio_input", async (original) => ({
  ...(await original<typeof import("./audio_input")>()),
  selectedAudioCandidate: vi.fn().mockResolvedValue(null),
}));

let drafts: typeof import("./drafts");
let attachments: typeof import("./draft_attachments");
let picker: typeof import("./composer_attachment_import");
const sent: PromptBlock[][] = [];
let checks: { uri: string; embed: boolean }[] = [];
let snapshots: unknown[] = [];
let serial = 0;
beforeEach(async () => {
  vi.resetModules();
  sent.length = 0;
  checks = [];
  snapshots = [];
  h.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "settings_get") return null;
    if (command === "settings_set") {
      snapshots.push(structuredClone(args.value));
      return null;
    }
    if (command === "draft_attachment_image") return null;
    if (command === "project_file_read") return "selection-time text";
    if (command === "draft_attachment_check") {
      checks.push(structuredClone(args));
      return args.embed ? `fresh text ${checks.length}` : null;
    }
    if (command === "session_prompt") {
      sent.push(structuredClone(args.content));
      return { status: "accepted" };
    }
    return [];
  });
  drafts = await import("./drafts");
  attachments = await import("./draft_attachments");
  picker = await import("./composer_attachment_import");
  await drafts.draftPersistence.load();
});
afterEach(async () => {
  await drafts.draftPersistence.flush();
  vi.restoreAllMocks();
});
async function dispatch(blocks: PromptBlock[]) {
  const { archiveActivity } = await import("./archive_activity");
  vi.spyOn(archiveActivity, "begin").mockResolvedValue();
  vi.spyOn(archiveActivity, "finish").mockResolvedValue();
  const { threads } = await import("./sessions");
  const state = threads.markOpenFailed(
    `delivery-${++serial}`,
    "chosen",
    "/owned",
    `id-${serial}`,
    "fixture",
  );
  state.openError = null;
  state.workEnabled = true;
  const result = await threads.send(state.key, blocks);
  return { state, result };
}
async function prepareAndDispatch(embed: boolean) {
  const draft = drafts.composerDrafts.read("new");
  const prepared = await attachments.prepareDraftAttachments(
    draft.attachments,
    embed,
  );
  const blocks = attachments.attachmentPromptBlocks(
    draft.text,
    prepared,
    embed,
  );
  return { prepared, blocks, ...(await dispatch(blocks)) };
}
const chosen = (name: string) => ({
  id: name,
  kind: "file" as const,
  name,
  uri: `file:///owned/${name}`,
});

it.each([false, true])(
  "keeps four ordinary Office/PDF picks as exact links with embedded text capability %s",
  async (embed) => {
    const paths = ["pptx", "pdf", "xlsx", "docx"].map(
      (extension) => `/owned/current.${extension}`,
    );
    await picker.addPickedAttachments("new", paths, false, vi.fn());
    expect(drafts.composerDrafts.read("new").attachments).toEqual(
      paths.map((path) =>
        expect.objectContaining({
          uri: `file://${path}`,
          deliveryMode: "location",
        }),
      ),
    );
    const result = await prepareAndDispatch(embed);
    expect(result.result).toEqual({ status: "accepted" });
    expect(checks).toEqual(
      [...paths, ...paths].map((path) => ({
        uri: `file://${path}`,
        embed: false,
      })),
    );
    expect(sent).toEqual([
      paths.map((path) => ({
        type: "resource_link",
        name: path.split("/").pop(),
        uri: `file://${path}`,
      })),
    ]);
    expect(JSON.stringify(sent)).not.toContain("deliveryMode");
  },
);

it("does not silently turn an ordinary text-file pick into an embedded body", async () => {
  await picker.addPickedAttachments(
    "new",
    ["/owned/plain.txt"],
    false,
    vi.fn(),
  );
  const { result } = await prepareAndDispatch(true);
  expect(result.status).toBe("accepted");
  expect(checks).toEqual([
    { uri: "file:///owned/plain.txt", embed: false },
    { uri: "file:///owned/plain.txt", embed: false },
  ]);
  expect(sent).toEqual([
    [
      {
        type: "resource_link",
        name: "plain.txt",
        uri: "file:///owned/plain.txt",
      },
    ],
  ]);
});

it("keeps an @ text choice explicit and refreshes it again at the common dispatch boundary", async () => {
  await picker.addPickedAttachments(
    "new",
    ["/owned/notes.txt"],
    false,
    vi.fn(),
    {
      cwd: "/owned",
      path: "notes.txt",
      embed: true,
    },
  );
  expect(drafts.composerDrafts.read("new").attachments[0]).toMatchObject({
    deliveryMode: "text",
    content: "selection-time text",
  });
  const { result } = await prepareAndDispatch(true);
  expect(result.status).toBe("accepted");
  expect(checks).toEqual([
    { uri: "file:///owned/notes.txt", embed: true },
    { uri: "file:///owned/notes.txt", embed: true },
  ]);
  expect(sent).toEqual([
    [
      {
        type: "resource",
        resource: {
          uri: "file:///owned/notes.txt",
          mimeType: "text/plain",
          text: "fresh text 2",
        },
      },
    ],
  ]);
});

it("does not downgrade explicit text after capability loss or a failed file read", async () => {
  await picker.addPickedAttachments(
    "new",
    ["/owned/notes.txt"],
    false,
    vi.fn(),
    {
      cwd: "/owned",
      path: "notes.txt",
      embed: false,
    },
  );
  const text = drafts.composerDrafts.read("new").attachments[0];
  const original = structuredClone(text);
  expect(text).toMatchObject({ deliveryMode: "text", content: undefined });
  await expect(
    attachments.prepareDraftAttachments([text], false),
  ).rejects.toThrow();
  expect(() => attachments.attachmentPromptBlocks("", [text], false)).toThrow();
  expect(checks).toEqual([]);
  expect(sent).toEqual([]);
  h.invoke.mockImplementation(async (command) => {
    if (command === "draft_attachment_check") throw { code: "unsupportedText" };
    return null;
  });
  await expect(
    attachments.prepareDraftAttachments([text], true),
  ).rejects.toThrow("不能直接作为文字发送");
  expect(sent).toEqual([]);
  expect(text).toEqual(original);
});

it("does not turn a missing text-check body into a location fallback or accept stale cached text", async () => {
  const text: DraftAttachment = {
    ...chosen("notes.txt"),
    deliveryMode: "text",
    content: "stale",
  };
  h.invoke.mockResolvedValue(null);
  await expect(
    attachments.prepareDraftAttachments([text], true),
  ).rejects.toThrow();
  expect(() =>
    attachments.attachmentPromptBlocks(
      "",
      [{ ...text, content: undefined }],
      true,
    ),
  ).toThrow();
  expect(text.content).toBe("stale");
  expect(sent).toEqual([]);
});

it("retains an @ text choice after its selection-time read fails and does not create a link fallback", async () => {
  const implementation = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "project_file_read")
      throw new Error("synthetic read failure");
    if (command === "draft_attachment_check") throw { code: "unsupportedText" };
    return implementation(command, args);
  });
  await picker.addPickedAttachments(
    "new",
    ["/owned/no-text.bin"],
    false,
    vi.fn(),
    {
      cwd: "/owned",
      path: "no-text.bin",
      embed: true,
    },
  );
  const draft = drafts.composerDrafts.read("new");
  expect(draft.attachments[0]).toMatchObject({
    deliveryMode: "text",
    content: undefined,
  });
  await expect(prepareAndDispatch(true)).rejects.toThrow(
    "不能直接作为文字发送",
  );
  expect(drafts.composerDrafts.read("new")).toBe(draft);
  expect(sent).toEqual([]);
});

it("retains both delivery markers across persistence without retaining automatically read text", async () => {
  drafts.composerDrafts.update("new", () => ({
    text: "keep",
    attachments: [
      {
        ...chosen("location.txt"),
        deliveryMode: "location",
        content: "do not persist location body",
      },
      {
        ...chosen("text.txt"),
        deliveryMode: "text",
        content: "do not persist text body",
      },
      chosen("legacy.txt"),
    ] as DraftAttachment[],
  }));
  await drafts.draftPersistence.flush();
  const snapshot = snapshots.at(-1);
  expect(JSON.stringify(snapshot)).not.toContain("do not persist");
  const restored = drafts
    .parseDraftSnapshot(snapshot)!
    .composers.find(([key]) => key === "new")![1];
  expect(
    restored.attachments.map(
      (item) =>
        (item as DraftAttachment & { deliveryMode?: string }).deliveryMode,
    ),
  ).toEqual(["location", "text", undefined]);
  expect(
    restored.attachments.every(
      (item) => item.recovered && item.content === undefined,
    ),
  ).toBe(true);
  const prepared = await attachments.prepareDraftAttachments(
    restored.attachments,
    true,
  );
  expect(
    attachments
      .attachmentPromptBlocks("", prepared, true)
      .map((block) => block.type),
  ).toEqual(["resource_link", "resource", "resource"]);
  // Exercise the parser through a fresh actual persistence load as well.
  vi.resetModules();
  const beforeLoad = h.invoke.mock.calls.length;
  const implementation = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation(async (command, args) =>
    command === "settings_get"
      ? structuredClone(snapshot)
      : implementation(command, args),
  );
  const cold = await import("./drafts");
  await cold.draftPersistence.load();
  expect(
    cold.composerDrafts
      .read("new")
      .attachments.map((item) => item.deliveryMode),
  ).toEqual(["location", "text", undefined]);
  expect(
    cold.composerDrafts
      .read("new")
      .attachments.every(
        (item) => item.recovered && item.content === undefined,
      ),
  ).toBe(true);
  expect(
    h.invoke.mock.calls.slice(beforeLoad).map(([command]) => command),
  ).toEqual(["settings_get"]);
  expect(sent).toEqual([]);
});

it.each(["blob", true, null, { mode: "location" }])(
  "rejects unknown delivery semantics at ordinary restore: %j",
  (deliveryMode) => {
    expect(() =>
      drafts.parseDraftSnapshot({
        version: 1,
        composers: {
          new: {
            text: "keep",
            attachments: [{ ...chosen("saved.txt"), deliveryMode }],
          },
        },
        choice: { agentId: null, cwd: null, service: null, config: {} },
        feedback: {},
        queues: {},
        activity: {},
      }),
    ).toThrow();
    expect(checks).toEqual([]);
    expect(sent).toEqual([]);
  },
);

it("does not let a reviewed document bypass rejection of unknown file delivery semantics", async () => {
  const { documentAttachment } = await import("./docx_draft.test-support");
  const document = {
    ...documentAttachment(),
    deliveryMode: "blob",
  } as unknown as DraftAttachment;
  expect(() =>
    attachments.attachmentPromptBlocks("", [document], true),
  ).toThrow();
  const before = h.invoke.mock.calls.length;
  await expect(
    attachments.prepareDraftAttachments([document], true),
  ).rejects.toThrow();
  expect(h.invoke.mock.calls.slice(before)).toEqual([]);
  expect(sent).toEqual([]);
});

it("preserves legacy unmarked files without guessing whether their original entry was picker or @", async () => {
  const legacy = { ...chosen("legacy.txt"), content: "old cached text" };
  expect(
    attachments.attachmentPromptBlocks(
      "",
      await attachments.prepareDraftAttachments([legacy], true),
      true,
    )[0],
  ).toMatchObject({ type: "resource", resource: { text: "fresh text 1" } });
  expect(
    attachments.attachmentPromptBlocks(
      "",
      await attachments.prepareDraftAttachments([legacy], false),
      false,
    )[0],
  ).toMatchObject({ type: "resource_link" });
  expect(legacy.content).toBe("old cached text");
});

it("retains queued block type through editing, uncertain input recovery, saving and fresh dispatch", async () => {
  const original: PromptBlock[] = [
    { type: "resource_link", name: "same.txt", uri: "file:///owned/same.txt" },
    {
      type: "resource",
      resource: {
        uri: "file:///owned/same.txt",
        mimeType: "text/plain",
        text: "old queue text",
      },
    },
  ];
  const { startQueueEditor, queueEditorKey } = await import("./queue_edit");
  const { keepPromptAsDraft } = await import("./uncertain_prompt");
  startQueueEditor("owned-queue", 0, original);
  const edit = drafts.composerDrafts.read(queueEditorKey("owned-queue"));
  expect(
    edit.attachments.map(
      (item) =>
        (item as DraftAttachment & { deliveryMode?: string }).deliveryMode,
    ),
  ).toEqual(["location", "text"]);
  expect(edit.attachments.every((item) => item.content === undefined)).toBe(
    true,
  );
  const recovered = keepPromptAsDraft({ text: "", attachments: [] }, original);
  expect(
    recovered.attachments.map(
      (item) =>
        (item as DraftAttachment & { deliveryMode?: string }).deliveryMode,
    ),
  ).toEqual(["location", "text"]);
  drafts.composerDrafts.update("new", () => recovered);
  await drafts.draftPersistence.flush();
  const parsed = drafts.parseDraftSnapshot(snapshots.at(-1))!;
  const restored = parsed.composers.find(([key]) => key === "new")![1];
  const prepared = await attachments.prepareDraftAttachments(
    restored.attachments,
    true,
  );
  const blocks = attachments.attachmentPromptBlocks("", prepared, true);
  expect(blocks.map((block) => block.type)).toEqual([
    "resource_link",
    "resource",
  ]);
  expect((await dispatch(blocks)).result.status).toBe("accepted");
  expect(sent[0].map((block) => block.type)).toEqual([
    "resource_link",
    "resource",
  ]);
  expect(sent[0][1]).toMatchObject({ resource: { text: "fresh text 4" } });
  expect(original[1]).toMatchObject({ resource: { text: "old queue text" } });
});

it.each(["unreadable", "checkPending", "checkBusy"])(
  "stops a newly located file at the real common drain after %s without dispatch or a text fallback",
  async (code) => {
    const selected: DraftAttachment = {
      ...chosen("only-location.bin"),
      deliveryMode: "location",
    };
    const prepared = await attachments.prepareDraftAttachments(
      [selected],
      true,
    );
    const blocks = attachments.attachmentPromptBlocks("", prepared, true);
    const before = structuredClone(blocks);
    const implementation = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (command, args) => {
      if (command === "draft_attachment_check") throw { code };
      return implementation(command, args);
    });
    const { state, result } = await dispatch(blocks);
    expect(result).toEqual({ status: "rejected", reason: "failed" });
    expect(sent).toEqual([]);
    expect(state.queued).toEqual([before]);
    expect(state.queuePaused).toBe("failed");
    expect(state.items.some((item) => item.kind === "user")).toBe(false);
    expect(selected).not.toHaveProperty("content");
  },
);

it("keeps explicit text queued after a later native capability rejection without retry or link conversion", async () => {
  const text: DraftAttachment = {
    ...chosen("notes.txt"),
    deliveryMode: "text",
  };
  const prepared = await attachments.prepareDraftAttachments([text], true);
  const blocks = attachments.attachmentPromptBlocks("", prepared, true);
  const implementation = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_prompt") {
      sent.push(structuredClone(args.content));
      return { status: "rejected", reason: "embedded_context_unsupported" };
    }
    return implementation(command, args);
  });
  const { state, result } = await dispatch(blocks);
  expect(result).toEqual({
    status: "rejected",
    reason: "embedded_context_unsupported",
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual([
    {
      type: "resource",
      resource: { uri: text.uri, mimeType: "text/plain", text: "fresh text 2" },
    },
  ]);
  expect(state.queued).toEqual([blocks]);
  expect(state.queuePaused).toBe("unavailable");
  await Promise.resolve();
  expect(sent).toHaveLength(1);
  expect(state.items.some((item) => item.kind === "user")).toBe(false);
});
