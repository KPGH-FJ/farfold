import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset();
});
const path = "/work/retained.pdf",
  contentId = `disk:${JSON.stringify([path, "v1", "c".repeat(64)])}`;
const opinion = {
  path,
  contentId,
  text: "fixed page opinion",
  selection: null,
  scope: "file" as const,
  anchor: { kind: "pdf-page" as const, page: 2, pageCount: 7 },
};
const baseline = () => ({
  version: 1,
  composers: {
    "session:a": {
      text: "existing draft",
      attachments: [
        { id: "file", kind: "file", name: "notes.md", uri: "file:///notes.md" },
      ],
      sendPending: true,
    },
  },
  choice: { agentId: null, cwd: null, service: null, config: {} },
  feedback: { a: { saved: { ...opinion, anchor: { ...opinion.anchor } } } },
  queues: {
    a: {
      blocks: [[{ type: "text", text: "queued input" }]],
      uncertainIndex: 0,
    },
  },
});
it("restores the exact page/version, moves it into one composer snapshot and preserves queue/attachments without sending", async () => {
  let disk: unknown = baseline();
  h.invoke.mockImplementation(async (name, input) => {
    if (name === "settings_get") return disk;
    if (name === "settings_set") disk = structuredClone(input.value);
    else if (name !== "settings_get") throw new Error("unexpected IPC");
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  const entries = d.fileFeedbackDrafts.entries("a"),
    key = Object.keys(entries)[0];
  expect(entries[key]).toEqual(opinion);
  const attachment = d.composerDrafts.read("session:a").attachments[0];
  const queue = d.draftQueues.read("a");
  const { fileFeedbackText } = await import("./feedback_strings");
  expect(
    d.fileFeedbackDrafts.take("a", key, fileFeedbackText(entries[key])),
  ).toBe(true);
  await d.draftPersistence.flush();
  expect(d.composerDrafts.read("session:a")).toMatchObject({
    text: expect.stringContaining("第 2 / 7 页"),
    sendPending: true,
  });
  expect(d.composerDrafts.read("session:a").attachments[0]).toBe(attachment);
  expect(d.draftQueues.read("a")).toEqual(queue);
  expect(d.fileFeedbackDrafts.entries("a")).toEqual({});
  expect(
    h.invoke.mock.calls.every(([name]) =>
      ["settings_get", "settings_set"].includes(name),
    ),
  ).toBe(true);
  vi.resetModules();
  const restored = await import("./drafts");
  await restored.draftPersistence.load();
  expect(restored.composerDrafts.read("session:a").text).toContain(
    "fixed page opinion",
  );
  expect(restored.fileFeedbackDrafts.entries("a")).toEqual({});
});
it("preserves page-only selection and old/new version drafts in persisted settings", async () => {
  let disk: unknown = baseline();
  h.invoke.mockImplementation(async (name, input) => {
    if (name === "settings_get") return disk;
    if (name === "settings_set") disk = structuredClone(input.value);
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  const newId = `disk:${JSON.stringify([path, "v2", "d".repeat(64)])}`;
  d.fileFeedbackDrafts.update("a", path, {
    ...opinion,
    text: "",
    contentId: newId,
    anchor: { kind: "pdf-page", page: 1, pageCount: 2 },
  });
  await d.draftPersistence.flush();
  vi.resetModules();
  const restored = await import("./drafts");
  await restored.draftPersistence.load();
  expect(Object.values(restored.fileFeedbackDrafts.entries("a"))).toHaveLength(
    2,
  );
  expect(restored.fileFeedbackDrafts.read("a", path, newId).anchor).toEqual({
    kind: "pdf-page",
    page: 1,
    pageCount: 2,
  });
  expect(restored.fileFeedbackDrafts.read("a", path, contentId).text).toBe(
    opinion.text,
  );
});
it("rejects a future page-anchor shape atomically and never overwrites the unread snapshot", async () => {
  const disk = baseline();
  Object.assign(disk.feedback.a.saved.anchor, { region: [0, 0, 1, 1] });
  h.invoke.mockResolvedValue(disk);
  const d = await import("./drafts");
  await expect(d.draftPersistence.load()).rejects.toThrow();
  expect(d.fileFeedbackDrafts.entries("a")).toEqual({});
  expect(d.composerDrafts.read("session:a").text).toBe("");
  d.composerDrafts.update("new", () => ({
    text: "new local text",
    attachments: [],
  }));
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(h.invoke.mock.calls.every(([name]) => name === "settings_get")).toBe(
    true,
  );
});
it("a failed move save keeps composer content in memory and the old page opinion on disk for recovery", async () => {
  const disk = baseline();
  h.invoke.mockImplementation(async (name) => {
    if (name === "settings_get") return disk;
    throw "FARFOLD_STORAGE:full:fixture";
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  const key = Object.keys(d.fileFeedbackDrafts.entries("a"))[0];
  d.fileFeedbackDrafts.take("a", key, "fixed moved opinion");
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(d.draftPersistence.snapshot().error).not.toBeNull();
  expect(d.composerDrafts.read("session:a").text).toContain(
    "fixed moved opinion",
  );
  expect(disk.feedback.a.saved.anchor.page).toBe(2);
});
