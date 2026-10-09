import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset();
});
const path = "/work/source.md",
  contentId = `disk:${JSON.stringify([path, "original", "b".repeat(64)])}`;
const opinion = {
  path,
  contentId,
  text: "  exact opinion\n",
  selection: null,
  scope: "file" as const,
  anchor: {
    kind: "text-range" as const,
    byteStart: 6,
    byteEnd: 16,
    startLine: 2,
    endLine: 2,
  },
};
const baseline = () => ({
  version: 1,
  composers: {
    "session:a": {
      text: "existing",
      attachments: [
        { id: "file", kind: "file", name: "a.md", uri: "file:///a.md" },
      ],
      sendPending: true,
      queueEdit: {
        index: 0,
        original: [{ type: "text", text: "queued original" }],
      },
    },
  },
  choice: { agentId: null, cwd: null, service: null, config: {} },
  feedback: {
    a: {
      saved: opinion,
      other: {
        ...opinion,
        contentId: `disk:${JSON.stringify([path, "other", "c".repeat(64)])}`,
        text: "other version",
      },
    },
    b: { saved: opinion },
  },
  queues: {
    a: { blocks: [[{ type: "text", text: "queued" }]], uncertainIndex: 0 },
  },
});

it("cold restores only historical coordinates then moves one exact opinion without sending or dropping attachments/queue/edit/pending", async () => {
  let disk: unknown = baseline();
  h.invoke.mockImplementation(async (name, input) => {
    if (name === "settings_get") return structuredClone(disk);
    if (name === "settings_set") disk = structuredClone(input.value);
    else throw new Error("unexpected IPC");
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  const [key, entry] = Object.entries(d.fileFeedbackDrafts.entries("a")).find(
    ([, v]) => v.contentId === contentId,
  )!;
  const before = structuredClone(d.composerDrafts.read("session:a")),
    queue = structuredClone(d.draftQueues.read("a"));
  const { fileFeedbackText } = await import("./feedback_strings");
  expect(d.fileFeedbackDrafts.take("a", key, fileFeedbackText(entry))).toBe(
    true,
  );
  expect(d.fileFeedbackDrafts.take("a", key, fileFeedbackText(entry))).toBe(
    false,
  );
  await d.draftPersistence.flush();
  expect(d.composerDrafts.read("session:a")).toEqual({
    ...before,
    text: expect.stringContaining(opinion.text),
  });
  expect(d.draftQueues.read("a")).toEqual(queue);
  expect(Object.values(d.fileFeedbackDrafts.entries("a"))).toHaveLength(1);
  expect(Object.values(d.fileFeedbackDrafts.entries("b"))).toEqual([opinion]);
  expect(
    h.invoke.mock.calls.every(([name]) =>
      ["settings_get", "settings_set"].includes(name),
    ),
  ).toBe(true);
  vi.resetModules();
  const cold = await import("./drafts");
  await cold.draftPersistence.load();
  expect(cold.composerDrafts.read("session:a").text).toContain(
    "位置未重新核对",
  );
  expect(cold.composerDrafts.read("session:a").sendPending).toBe(true);
  expect(Object.values(cold.fileFeedbackDrafts.entries("b"))[0]).toEqual(
    opinion,
  );
});

it("keeps a range-only draft and distinct versions across cold reload without persisting source text", async () => {
  let disk: unknown = baseline();
  h.invoke.mockImplementation(async (name, input) => {
    if (name === "settings_get") return structuredClone(disk);
    if (name === "settings_set") disk = structuredClone(input.value);
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  d.fileFeedbackDrafts.update("a", path, { ...opinion, text: "" });
  await d.draftPersistence.flush();
  vi.resetModules();
  const cold = await import("./drafts");
  await cold.draftPersistence.load();
  expect(cold.fileFeedbackDrafts.read("a", path, contentId)).toEqual({
    ...opinion,
    text: "",
  });
  expect(Object.values(cold.fileFeedbackDrafts.entries("a"))).toHaveLength(2);
  expect(JSON.stringify(disk)).not.toMatch(
    /"(quote|verified|sourceText|byteContent)":/,
  );
});

it("refuses a future text anchor atomically and cannot overwrite the unread saved snapshot", async () => {
  const disk = baseline();
  disk.feedback.a.saved = {
    ...opinion,
    anchor: { ...opinion.anchor, fresh: true },
  } as typeof opinion;
  h.invoke.mockResolvedValue(disk);
  const d = await import("./drafts");
  await expect(d.draftPersistence.load()).rejects.toThrow();
  expect(d.fileFeedbackDrafts.entries("a")).toEqual({});
  expect(d.composerDrafts.read("session:a").text).toBe("");
  d.composerDrafts.update("new", () => ({ text: "local", attachments: [] }));
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(h.invoke.mock.calls.every(([name]) => name === "settings_get")).toBe(
    true,
  );
});

it("a failed snapshot save retains the joined input in memory and exact old opinion on disk for cold recovery", async () => {
  const disk = baseline();
  h.invoke.mockImplementation(async (name) => {
    if (name === "settings_get") return structuredClone(disk);
    throw "FARFOLD_STORAGE:full:fixture";
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  const [key, entry] = Object.entries(d.fileFeedbackDrafts.entries("a")).find(
    ([, v]) => v.contentId === contentId,
  )!;
  const { fileFeedbackText } = await import("./feedback_strings");
  d.fileFeedbackDrafts.take("a", key, fileFeedbackText(entry));
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(d.composerDrafts.read("session:a").text).toContain(opinion.text);
  expect(d.draftPersistence.snapshot().error).not.toBeNull();
  expect(disk.feedback.a.saved).toEqual(opinion);
  vi.resetModules();
  const cold = await import("./drafts");
  await cold.draftPersistence.load();
  expect(cold.fileFeedbackDrafts.read("a", path, contentId).anchor).toEqual(
    opinion.anchor,
  );
  expect(cold.composerDrafts.read("session:a").text).toBe("existing");
});
