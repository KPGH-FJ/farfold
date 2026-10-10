import { beforeEach, expect, it, vi } from "vitest";
import fixture from "./fixtures/storage-restore-v1.json";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset();
});
const entries = fixture["unsentWork.v1"].feedback["fixture-thread"];
function initial(
  entry: (typeof entries)["area.pdf"] | (typeof entries)["area.png"],
) {
  return {
    ...structuredClone(fixture["unsentWork.v1"]),
    composers: {
      "session:fixture-thread": {
        text: "existing\n",
        attachments: [],
        sendPending: true,
      },
    },
    feedback: {
      "fixture-thread": {
        opinion: { ...structuredClone(entry), text: "  exact opinion\n" },
      },
    },
  };
}
it.each([entries["area.png"], entries["area.pdf"]])(
  "takes $anchor.kind once and cold reloads without losing pending work or sending",
  async (entry) => {
    let disk: unknown = initial(entry);
    h.invoke.mockImplementation(async (name, input) => {
      if (name === "settings_get") return structuredClone(disk);
      if (name === "settings_set") {
        disk = structuredClone(input.value);
        return;
      }
      throw Error("unexpected IPC");
    });
    const d = await import("./drafts");
    await d.draftPersistence.load();
    const [key, opinion] = Object.entries(
      d.fileFeedbackDrafts.entries("fixture-thread"),
    )[0];
    const { fileFeedbackText } = await import("./feedback_strings");
    const queue = structuredClone(d.draftQueues.read("fixture-thread"));
    expect(
      d.fileFeedbackDrafts.take(
        "fixture-thread",
        key,
        fileFeedbackText(opinion),
      ),
    ).toBe(true);
    expect(
      d.fileFeedbackDrafts.take(
        "fixture-thread",
        key,
        fileFeedbackText(opinion),
      ),
    ).toBe(false);
    await d.draftPersistence.flush();
    vi.resetModules();
    const cold = await import("./drafts");
    await cold.draftPersistence.load();
    const composer = cold.composerDrafts.read("session:fixture-thread");
    expect(composer.text).toContain("existing\n");
    expect(composer.text).toContain("  exact opinion\n");
    expect(composer.text).toContain("显示画面左上角");
    expect(composer.text).toContain("位置未重新核对");
    expect(composer.sendPending).toBe(true);
    expect(cold.draftQueues.read("fixture-thread")).toEqual(queue);
    expect(cold.fileFeedbackDrafts.entries("fixture-thread")).toEqual({});
    expect(
      h.invoke.mock.calls.every((c) =>
        ["settings_get", "settings_set"].includes(c[0]),
      ),
    ).toBe(true);
  },
);
it("stores coordinate-only opinions and retains separate versions without frame or body", async () => {
  let disk: unknown = initial(entries["area.pdf"]);
  h.invoke.mockImplementation(async (name, input) => {
    if (name === "settings_get") return structuredClone(disk);
    if (name === "settings_set") disk = structuredClone(input.value);
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  const original = Object.values(
    d.fileFeedbackDrafts.entries("fixture-thread"),
  )[0];
  d.fileFeedbackDrafts.update("fixture-thread", original.path, {
    ...original,
    text: "",
  });
  d.fileFeedbackDrafts.update("fixture-thread", original.path, {
    ...original,
    contentId: `disk:${JSON.stringify([original.path, "v2", "b".repeat(64)])}`,
  });
  await d.draftPersistence.flush();
  vi.resetModules();
  const cold = await import("./drafts");
  await cold.draftPersistence.load();
  const saved = Object.values(
    cold.fileFeedbackDrafts.entries("fixture-thread"),
  );
  expect(saved).toHaveLength(2);
  expect(saved.find((e) => e.contentId === original.contentId)?.text).toBe("");
  expect(
    saved.every(
      (e) => JSON.stringify(e.anchor) === JSON.stringify(original.anchor),
    ),
  ).toBe(true);
  expect(
    JSON.stringify((disk as ReturnType<typeof initial>).feedback),
  ).not.toMatch(/"(frame|preview|data|pixels|verified|sourceText|drawOwner)":/);
});
it("invalid cold anchor blocks load and cannot overwrite unread storage", async () => {
  const disk = initial(entries["area.pdf"]);
  Object.assign(disk.feedback["fixture-thread"].opinion.anchor, {
    verified: true,
  });
  h.invoke.mockResolvedValue(disk);
  const d = await import("./drafts");
  await expect(d.draftPersistence.load()).rejects.toThrow();
  d.composerDrafts.update("new", () => ({ text: "local", attachments: [] }));
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(h.invoke.mock.calls.every((c) => c[0] === "settings_get")).toBe(true);
});
it("failed save keeps original coordinate opinion recoverable on disk", async () => {
  const disk = initial(entries["area.pdf"]);
  h.invoke.mockImplementation(async (name) => {
    if (name === "settings_get") return structuredClone(disk);
    throw "FARFOLD_STORAGE:full:fixture";
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  const [key, entry] = Object.entries(
    d.fileFeedbackDrafts.entries("fixture-thread"),
  )[0];
  const { fileFeedbackText } = await import("./feedback_strings");
  d.fileFeedbackDrafts.take("fixture-thread", key, fileFeedbackText(entry));
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(d.draftPersistence.snapshot().error).not.toBeNull();
  vi.resetModules();
  const cold = await import("./drafts");
  await cold.draftPersistence.load();
  expect(
    Object.values(cold.fileFeedbackDrafts.entries("fixture-thread"))[0],
  ).toEqual(entry);
  expect(cold.composerDrafts.read("session:fixture-thread").text).toBe(
    "existing\n",
  );
});
