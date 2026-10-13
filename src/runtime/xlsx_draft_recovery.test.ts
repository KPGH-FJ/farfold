import { beforeEach, expect, it, vi } from "vitest";
import {
  workbookAttachment,
  workbookBlock,
  approvedWorkbook,
} from "./xlsx_draft.test-support";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset();
});
function snapshot() {
  return {
    version: 1,
    composers: {
      new: {
        text: "pending question",
        attachments: [workbookAttachment()],
        sendPending: true,
        queueEdit: { index: 0, original: [workbookBlock()] },
        pendingConversation: {
          agentId: "chosen",
          cwd: "/owned",
          nativeSessionId: "known",
          service: { id: "selected", model: "kept" },
          serviceRevision: "r1",
        },
      },
    },
    choice: { agentId: "chosen", cwd: "/owned", service: null, config: {} },
    feedback: {},
    queues: { old: { blocks: [[workbookBlock()]], uncertainIndex: 0 } },
  };
}
it("persists full workbook text/ordered hidden scope through cold pending recovery and uncertainty without connecting or sending", async () => {
  let disk = snapshot();
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "settings_get") return structuredClone(disk);
    if (command === "settings_set") disk = structuredClone(args.value);
    return null;
  });
  const first = await import("./drafts");
  await first.draftPersistence.load();
  expect(first.composerDrafts.read("new")).toMatchObject({
    sendPending: true,
    attachments: [{ documentText: approvedWorkbook(), recovered: true }],
    pendingConversation: { service: { id: "selected", model: "kept" } },
  });
  first.composerDrafts.update("new", (draft) => ({
    ...draft,
    text: "later question",
  }));
  await first.draftPersistence.flush();
  expect(disk.composers.new.attachments[0].documentText).toEqual(
    approvedWorkbook(),
  );
  expect(disk.composers.new.attachments[0]).not.toHaveProperty("recovered");
  vi.resetModules();
  const cold = await import("./drafts");
  await cold.draftPersistence.load();
  expect(cold.composerDrafts.read("new")).toMatchObject({
    text: "later question",
    attachments: [{ documentText: approvedWorkbook(), recovered: true }],
    sendPending: true,
  });
  expect(cold.composerDrafts.read("new").queueEdit?.original).toEqual([
    workbookBlock(),
  ]);
  expect(cold.draftQueues.read("old")?.uncertainIndex).toBe(0);
  expect(
    h.invoke.mock.calls.every(([command]) =>
      ["settings_get", "settings_set"].includes(command),
    ),
  ).toBe(true);
});
it.each([
  "unknownMode",
  "repeatedSheet",
  "mixedDocx",
  "uncountedWarning",
  "queueScope",
])(
  "malformed workbook %s makes recovery fail without clearing input or overwriting stored data",
  async (kind) => {
    const disk = snapshot(),
      local = disk.composers.new.attachments[0].documentText!.local;
    if (local?.format !== "xlsx") throw new Error("fixture format");
    if (kind === "unknownMode")
      Object.assign(local.scope, { mode: "viewport" });
    if (kind === "repeatedSheet")
      local.scope.sheetIds.push(local.scope.sheetIds[0]);
    if (kind === "mixedDocx") Object.assign(local, { imageReferences: 0 });
    if (kind === "uncountedWarning")
      Object.assign(local, {
        warnings: [{ code: "externalContent", count: 2 }],
        partial: true,
        partialSelected: true,
      });
    if (kind === "queueScope")
      Object.assign(disk.queues.old.blocks[0][0].localDocumentText!, {
        scope: { mode: "all-saved-cells", sheetIds: [] },
      });
    const before = structuredClone(disk);
    h.invoke.mockResolvedValue(disk);
    const drafts = await import("./drafts");
    await expect(drafts.draftPersistence.load()).rejects.toThrow();
    expect(drafts.draftPersistence.snapshot().ready).toBe(false);
    expect(drafts.composerDrafts.read("new").text).toBe("");
    expect(drafts.draftQueues.read("old")).toBeNull();
    drafts.composerDrafts.update("new", () => ({
      text: "new local input",
      attachments: [],
    }));
    await expect(drafts.draftPersistence.flush()).rejects.toThrow();
    expect(disk).toEqual(before);
    expect(
      h.invoke.mock.calls.every(([command]) => command === "settings_get"),
    ).toBe(true);
  },
);
it("retains null-source workbook history over conversion limit as user text while whole unsent budget still blocks oversized saving", async () => {
  const disk = snapshot(),
    retained = "H".repeat(256 * 1024 + 1);
  disk.composers.new.attachments[0].documentText = {
    text: retained,
    local: null,
  };
  h.invoke.mockResolvedValue(disk);
  const drafts = await import("./drafts");
  await drafts.draftPersistence.load();
  expect(drafts.composerDrafts.read("new").attachments[0]).toMatchObject({
    documentText: { text: retained, local: null },
    recovered: true,
  });
  drafts.composerDrafts.update("new", (draft) => ({
    ...draft,
    text: "X".repeat(32 * 1024 * 1024),
  }));
  await expect(drafts.draftPersistence.flush()).rejects.toThrow();
  expect(drafts.draftPersistence.snapshot().error).not.toBeNull();
  expect(
    h.invoke.mock.calls.every(([command]) => command === "settings_get"),
  ).toBe(true);
  expect(disk.composers.new.attachments[0].documentText.text).toBe(retained);
});
