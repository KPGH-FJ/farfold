import { beforeEach, expect, it, vi } from "vitest";
import { approvedPdf, PDF_URI } from "./pdf_document.test-support";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset();
});
function snapshot() {
  const approved = approvedPdf();
  const block = {
    type: "resource" as const,
    resource: { uri: PDF_URI, mimeType: "text/plain", text: approved.text },
    localDocumentText: approved.local,
  };
  return {
    version: 1,
    composers: {
      new: {
        text: "pending PDF question",
        attachments: [
          {
            id: "pdf",
            kind: "file" as const,
            name: "complete.pdf",
            uri: PDF_URI,
            documentText: approved,
          },
        ],
        sendPending: true,
        queueEdit: { index: 0, original: [block] },
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
    queues: { old: { blocks: [[block]], uncertainIndex: 0 } },
  };
}
it("cold storage retains full known PDF scope in pending/uncertain input without connecting, rereading or sending", async () => {
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
    attachments: [{ documentText: approvedPdf(), recovered: true }],
    pendingConversation: { service: { model: "kept" } },
  });
  first.composerDrafts.update("new", (draft) => ({
    ...draft,
    text: "later text",
  }));
  await first.draftPersistence.flush();
  expect(disk.composers.new.attachments[0].documentText).toEqual(approvedPdf());
  expect(disk.composers.new.attachments[0]).not.toHaveProperty("recovered");
  vi.resetModules();
  const cold = await import("./drafts");
  await cold.draftPersistence.load();
  expect(cold.composerDrafts.read("new")).toMatchObject({
    text: "later text",
    attachments: [{ documentText: approvedPdf(), recovered: true }],
    sendPending: true,
  });
  expect(cold.composerDrafts.read("new").queueEdit?.original).toEqual(
    disk.composers.new.queueEdit.original,
  );
  expect(cold.draftQueues.read("old")?.uncertainIndex).toBe(0);
  expect(
    h.invoke.mock.calls.every(([command]) =>
      ["settings_get", "settings_set"].includes(command),
    ),
  ).toBe(true);
});
it.each(["prefix", "notPartial", "notSelected", "mixedFormat", "queueConsent"])(
  "malformed stored PDF %s rejects whole recovery without replacing stored input",
  async (kind) => {
    const disk = snapshot();
    const local = disk.composers.new.attachments[0].documentText.local;
    if (local?.format !== "pdf") throw new Error("format");
    if (kind === "prefix") local.scope.readPageNumbers.pop();
    if (kind === "notPartial") Object.assign(local, { partial: false });
    if (kind === "notSelected") local.partialSelected = false;
    if (kind === "mixedFormat") Object.assign(local, { imageReferences: 0 });
    if (kind === "queueConsent")
      Object.assign(disk.queues.old.blocks[0][0].localDocumentText!, {
        scope: { ...local.scope, includePossiblyInvisibleText: false },
      });
    const before = structuredClone(disk);
    h.invoke.mockResolvedValue(disk);
    const drafts = await import("./drafts");
    await expect(drafts.draftPersistence.load()).rejects.toThrow();
    expect(drafts.draftPersistence.snapshot().ready).toBe(false);
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
it("retains unknown PDF text beyond conversion budget but blocks oversized whole unsent persistence", async () => {
  const disk = snapshot();
  const retained = "H".repeat(256 * 1024 + 1);
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
it("new PDF approval remains in memory after failed saving and never starts a request", async () => {
  h.invoke.mockResolvedValue(null);
  const drafts = await import("./drafts");
  const { createDocumentInputTarget } = await import("./document_input_draft");
  await drafts.draftPersistence.load();
  const key = "pdf-new-save-failure";
  drafts.composerDrafts.update(key, () => ({
    text: "keep original question",
    attachments: [
      { id: "pdf-new", kind: "file", name: "complete.pdf", uri: PDF_URI },
    ],
  }));
  const chip = drafts.composerDrafts.read(key).attachments[0];
  const target = createDocumentInputTarget(key, chip, () => true);
  const approved = approvedPdf();
  h.invoke.mockImplementation(async (command) => {
    if (command === "settings_set") throw new Error("unit disk unavailable");
    return null;
  });
  expect(target.apply(approved)).toBe(true);
  expect(target.apply(approved)).toBe(false);
  await expect(drafts.draftPersistence.flush()).rejects.toThrow();
  expect(drafts.composerDrafts.read(key)).toMatchObject({
    text: "keep original question",
    attachments: [{ documentText: approved, loading: false, recovered: false }],
  });
  expect(drafts.draftPersistence.snapshot().error).not.toBeNull();
  expect(
    h.invoke.mock.calls.every(([command]) =>
      ["settings_get", "settings_set"].includes(command),
    ),
  ).toBe(true);
});
it("remove/readd of the same PDF path and ID revokes the late scope-confirmed target", async () => {
  h.invoke.mockResolvedValue(null);
  const drafts = await import("./drafts");
  const { createDocumentInputTarget } = await import("./document_input_draft");
  await drafts.draftPersistence.load();
  const key = "pdf-late-aba",
    chip = {
      id: "same-pdf",
      kind: "file" as const,
      name: "complete.pdf",
      uri: PDF_URI,
    };
  drafts.composerDrafts.update(key, () => ({
    text: "keep",
    attachments: [chip],
  }));
  const target = createDocumentInputTarget(key, chip, () => true);
  drafts.composerDrafts.update(key, (draft) => ({ ...draft, attachments: [] }));
  const newer = { ...chip, loading: true };
  drafts.composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: [newer],
  }));
  expect(target.signal.aborted).toBe(true);
  expect(target.apply(approvedPdf())).toBe(false);
  target.retire();
  expect(drafts.composerDrafts.read(key).attachments[0]).toBe(newer);
  expect(newer).not.toHaveProperty("documentText");
  expect(
    h.invoke.mock.calls.every(([command]) =>
      ["settings_get", "settings_set"].includes(command),
    ),
  ).toBe(true);
});
