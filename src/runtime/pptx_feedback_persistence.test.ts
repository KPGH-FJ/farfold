import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset();
});
const path = "/work/source.pptx";
const contentId = `disk:${JSON.stringify([path, "original", "b".repeat(64)])}`;
const opinion = {
  path,
  contentId,
  text: "  exact opinion\n",
  selection: null,
  scope: "file" as const,
  anchor: {
    kind: "pptx-slide" as const,
    part: "ppt/slides/slide3.xml",
    previewSlide: 2,
    previewSlideCount: 2,
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

it("cold restores only historical whole-slide coordinates and takes once without sending or dropping unrelated pending materials", async () => {
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
  const saved = cold.composerDrafts.read("session:a");
  expect(saved.text).toContain("整页幻灯片");
  expect(saved.text).toContain('文件内定位依据 "ppt/slides/slide3.xml"');
  expect(saved.text).toContain("当时预览第 2 / 2 页");
  expect(saved.text).toContain("位置未重新核对");
  expect(saved.sendPending).toBe(true);
  expect(Object.values(cold.fileFeedbackDrafts.entries("b"))[0]).toEqual(
    opinion,
  );
});

it("retains a coordinate-only opinion and distinct file versions without persisting body or live ownership", async () => {
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
  expect(
    JSON.stringify((disk as ReturnType<typeof baseline>).feedback),
  ).not.toMatch(
    /"(quote|verified|sourceText|capture|preview|blocks|stories|runs)":/,
  );
});

it("atomically refuses a future or mixed document anchor and cannot overwrite an unread cold snapshot", async () => {
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

it("failed saving leaves joined input in memory and the original document opinion recoverable on disk", async () => {
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
