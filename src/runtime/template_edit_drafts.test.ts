import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
const original = { id: "one", label: "检查", text: "检查当前变更" };
const edit = { ...original, text: "编辑未完成", original };
const saved = () => ({
  version: 1,
  composers: {},
  feedback: {},
  queues: {},
  choice: { agentId: null, cwd: null, service: null, config: {} },
});
beforeEach(() => {
  vi.resetModules();
  mock.invoke.mockReset();
});
it("restores a template editor without dispatching or populating conversation input", async () => {
  mock.invoke.mockResolvedValue({ ...saved(), templateEdits: edit });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  expect(d.templateEditDrafts.read()).toEqual(edit);
  expect(d.templateEditDrafts.snapshot()).toBe(d.templateEditDrafts.read());
  expect(d.composerDrafts.read("new").text).toBe("");
  expect(mock.invoke.mock.calls.map(([name]) => name)).toEqual([
    "settings_get",
  ]);
});
it("keeps legacy documents compatible and serializes new unsent edits through draft persistence", async () => {
  mock.invoke.mockImplementation(async (command) =>
    command === "settings_get" ? saved() : undefined,
  );
  const d = await import("./drafts");
  await d.draftPersistence.load();
  expect(d.templateEditDrafts.read()).toBeNull();
  const notify = vi.fn();
  d.templateEditDrafts.subscribe(notify);
  d.templateEditDrafts.update(edit);
  await d.draftPersistence.flush();
  expect(notify).toHaveBeenCalled();
  const value = mock.invoke.mock.calls
    .filter(([name]) => name === "settings_set")
    .at(-1)?.[1].value;
  expect(value.templateEdits).toEqual(edit);
  expect(value).toMatchObject(saved());
});
it("rejects the entire snapshot if the optional template editor is malformed", async () => {
  mock.invoke.mockResolvedValue({
    ...saved(),
    composers: { new: { text: "must not publish", attachments: [] } },
    templateEdits: { ...edit, original: { ...original, id: "other" } },
  });
  const d = await import("./drafts");
  await expect(d.draftPersistence.load()).rejects.toThrow();
  expect(d.composerDrafts.read("new").text).toBe("");
  expect(() => d.templateEditDrafts.update(edit)).toThrow();
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(
    mock.invoke.mock.calls.every(([name]) => name === "settings_get"),
  ).toBe(true);
});
it("retains edits after a failed draft write and never mutates them via caller references", async () => {
  mock.invoke.mockImplementation(async (command) => {
    if (command === "settings_get") return saved();
    throw new Error("failed");
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  const input = structuredClone(edit);
  d.templateEditDrafts.update(input);
  input.text = "external mutation";
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(d.templateEditDrafts.read()).toEqual(edit);
});
it("cannot replace unread edits or edit during a recovery interaction lock", async () => {
  mock.invoke.mockResolvedValue({ ...saved(), templateEdits: edit });
  const d = await import("./drafts");
  expect(() =>
    d.templateEditDrafts.update({ ...edit, text: "premature" }),
  ).toThrow();
  await d.draftPersistence.load();
  d.draftPersistence.lockInteraction(true);
  expect(() => d.templateEditDrafts.update(null)).toThrow();
  expect(d.templateEditDrafts.read()).toEqual(edit);
});
