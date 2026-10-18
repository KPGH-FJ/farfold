import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), verify: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("./document_input", () => ({ verifyDocumentInput: h.verify }));
import {
  prepareDraftAttachments,
  attachmentPromptBlocks,
  validateQueuedAttachments,
} from "./draft_attachments";
import {
  localMessageAttachments,
  resourceDocumentText,
  resourceDraftAttachment,
  wirePromptBlocks,
} from "./prompt_blocks";
import {
  userMessageBlocks,
  userMessageDraftAttachments,
} from "./message_actions";
import { composerDrafts, draftPersistence, draftQueues } from "./drafts";
import { startQueueEditor, queueEditorKey } from "./queue_edit";
import { keepPromptAsDraft } from "./uncertain_prompt";
import { normalizeMessageAttachment } from "./message_attachments";
import {
  captureAttachmentReview,
  confirmAttachmentReview,
} from "./attachment_review";
import { threads } from "./sessions";
import { queuedAttachmentsNeedReview } from "./recovered_attachments";
import { DocumentInputError } from "./document_input_types";
import { DocumentSourceError } from "./document_source_error";
import {
  approvedWorkbook,
  workbookAttachment,
  workbookBlock,
  XLSX_URI,
} from "./xlsx_draft.test-support";

beforeEach(() => {
  h.invoke.mockReset();
  h.verify.mockReset().mockResolvedValue(undefined);
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  draftPersistence.lockInteraction(false);
});
afterEach(() => vi.restoreAllMocks());

it("keeps full text and ordered all-saved scope across queue editing, resend, new-message and uncertain input, whitelisting wire only", async () => {
  const attachment = workbookAttachment(),
    [prepared] = await prepareDraftAttachments([attachment], true);
  const blocks = attachmentPromptBlocks("question", [prepared], true);
  await validateQueuedAttachments(blocks);
  expect(wirePromptBlocks(blocks)).toEqual([
    { type: "text", text: "question" },
    {
      type: "text",
      text: attachment.documentText!.text,
    },
  ]);
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.verify).toHaveBeenCalledTimes(2);
  startQueueEditor("xlsx-preserve", 0, blocks);
  expect(
    composerDrafts.read(queueEditorKey("xlsx-preserve")).attachments[0]
      .documentText,
  ).toEqual(attachment.documentText);
  const ownMessage = localMessageAttachments(blocks);
  expect(userMessageDraftAttachments(ownMessage)[0].documentText).toEqual(
    attachment.documentText,
  );
  expect(userMessageBlocks("question", ownMessage)).toEqual(blocks);
  expect(
    keepPromptAsDraft({ text: "later", attachments: [] }, blocks)
      .attachments[0],
  ).toMatchObject({ documentText: attachment.documentText, recovered: true });
  expect(blocks[1]).toEqual(workbookBlock());
});

it("historical XLSX URI or MIME preserves all text with null source, refusing forged local authority and no binary UTF8/link fallback", async () => {
  const block = workbookBlock(),
    official = normalizeMessageAttachment(block)!;
  expect(official).not.toHaveProperty("localDocumentText");
  const restored = userMessageDraftAttachments([official])[0];
  expect(restored).toMatchObject({
    documentText: { text: block.resource.text, local: null },
    recovered: true,
  });
  const mimeOnly = {
    type: "resource" as const,
    resource: {
      uri: "file:///owned/opaque",
      text: "retained",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  };
  expect(resourceDocumentText(mimeOnly)).toEqual({
    text: "retained",
    local: null,
  });
  h.verify.mockRejectedValue(new DocumentInputError("sourceUnknown"));
  await expect(
    prepareDraftAttachments([restored], true, { reparseDocuments: true }),
  ).rejects.toBeInstanceOf(DocumentSourceError);
  await expect(
    validateQueuedAttachments(userMessageBlocks("retry", [official])),
  ).rejects.toMatchObject({ code: "sourceUnknown" });
  expect(h.invoke).not.toHaveBeenCalled();
  expect(restored.documentText?.text).toBe(block.resource.text);
  expect(() => attachmentPromptBlocks("question", [restored], true)).toThrow();
});

it("recovered known workbook cannot send until explicit review and missing capability does not downgrade it", async () => {
  const attachment = workbookAttachment(true),
    before = structuredClone(attachment);
  await expect(
    prepareDraftAttachments([attachment], true),
  ).rejects.toMatchObject({ code: "recoveryRequired" });
  await expect(
    prepareDraftAttachments([attachment], false, { reparseDocuments: true }),
  ).rejects.toMatchObject({ code: "capabilityUnsupported" });
  expect(h.verify).not.toHaveBeenCalled();
  const [checked] = await prepareDraftAttachments([attachment], true, {
    reparseDocuments: true,
  });
  expect(h.verify).toHaveBeenCalledWith(attachment.documentText, XLSX_URI, {
    reparse: true,
    signal: undefined,
  });
  expect(checked.documentText).toEqual(attachment.documentText);
  expect(checked.recovered).toBe(false);
  expect(attachment).toEqual(before);
  expect(h.invoke).not.toHaveBeenCalled();
});

let serial = 0;
function review() {
  const key = `xlsx-review-${++serial}`;
  draftQueues.write(key, [[workbookBlock()]], null);
  const state = threads.markOpenFailed(key, "chosen", "/owned", key, "fixture");
  state.openError = null;
  state.workEnabled = true;
  composerDrafts.update(`session:${key}`, () => ({
    text: "preserved",
    attachments: [workbookAttachment(true)],
  }));
  return captureAttachmentReview(`session:${key}`, state);
}
const keep = (value: ReturnType<typeof review>) =>
  new Set(value.entries.map((x) => x.id));
it("recovery exposes independent full retained text/scope for both sources, atomically reparses and pauses queues without sending", async () => {
  const value = review();
  expect(value.entries.map((x) => x.documentText)).toEqual([
    approvedWorkbook(),
    approvedWorkbook(),
  ]);
  expect(value.entries[0].documentText).not.toBe(
    value.draft.attachments[0].documentText,
  );
  expect(
    await confirmAttachmentReview(value, keep(value), true, () => true),
  ).toBe(true);
  expect(h.verify).toHaveBeenCalledTimes(2);
  expect(h.verify.mock.calls.every(([, , options]) => options.reparse)).toBe(
    true,
  );
  expect(value.thread!.queuePaused).toBe("stopped");
  expect(queuedAttachmentsNeedReview(value.thread!.queued[0])).toBe(false);
  expect(
    composerDrafts.read(value.draftKey).attachments[0].documentText,
  ).toEqual(approvedWorkbook());
  expect(h.invoke).not.toHaveBeenCalled();
});
it("typed source error reaches repair surface and a later queue failure clears no draft/queue barriers", async () => {
  const value = review(),
    original = new DocumentInputError("changed");
  h.verify.mockRejectedValueOnce(original);
  try {
    await confirmAttachmentReview(value, keep(value), true, () => true);
    throw new Error("unexpected pass");
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentSourceError);
    expect(error).toMatchObject({
      code: "changed",
      attachmentId: "owned-xlsx",
      previous: value.draft.attachments[0].documentText,
    });
  }
  h.verify.mockResolvedValueOnce(undefined).mockRejectedValueOnce(original);
  await expect(
    confirmAttachmentReview(value, keep(value), true, () => true),
  ).rejects.toBe(original);
  expect(composerDrafts.read(value.draftKey)).toBe(value.draft);
  expect(value.thread!.queued[0]).toBe(value.queue[0]);
  expect(queuedAttachmentsNeedReview(value.queue[0])).toBe(true);
  expect(h.invoke).not.toHaveBeenCalled();
});
it("late recovery completion after remove/re-add ABA does not clear a replacement chip or queue", async () => {
  const value = review();
  let finish!: () => void;
  h.verify.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const pending = confirmAttachmentReview(value, keep(value), true, () => true);
  composerDrafts.update(value.draftKey, (d) => ({ ...d, attachments: [] }));
  composerDrafts.update(value.draftKey, (d) => ({
    ...d,
    attachments: [workbookAttachment(true)],
  }));
  const replacement = composerDrafts.read(value.draftKey);
  finish();
  await expect(pending).rejects.toThrow("内容已变化");
  expect(composerDrafts.read(value.draftKey)).toBe(replacement);
  expect(value.thread!.queued[0]).toBe(value.queue[0]);
  expect(replacement.attachments[0].recovered).toBe(true);
  expect(h.invoke).not.toHaveBeenCalled();
});
it("historical unknown workbook recovery entry remains null source without acquiring remembered all-saved permission", () => {
  const value = review(),
    unknown = resourceDraftAttachment(
      {
        type: "resource",
        resource: {
          uri: XLSX_URI,
          mimeType: "text/plain",
          text: "OLD_HISTORY_BODY",
        },
      },
      { recovered: true },
    );
  composerDrafts.update(value.draftKey, () => ({
    text: "body",
    attachments: [unknown],
  }));
  const current = captureAttachmentReview(value.draftKey, value.thread);
  expect(current.entries[0].documentText).toEqual({
    text: "OLD_HISTORY_BODY",
    local: null,
  });
  expect(h.invoke).not.toHaveBeenCalled();
});
