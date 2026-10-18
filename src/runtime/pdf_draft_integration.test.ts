import { beforeEach, expect, it, vi } from "vitest";
import { approvedPdf, PDF_URI } from "./pdf_document.test-support";
import type { DraftAttachment } from "./drafts";
import type { PromptBlock } from "./session_types";
const h = vi.hoisted(() => ({ invoke: vi.fn(), verify: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./document_input", () => ({ verifyDocumentInput: h.verify }));
import {
  attachmentPromptBlocks,
  prepareDraftAttachments,
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
import { normalizeMessageAttachment } from "./message_attachments";
import { composerDrafts } from "./drafts";
import { startQueueEditor, queueEditorKey } from "./queue_edit";
import { keepPromptAsDraft } from "./uncertain_prompt";
import { DocumentInputError } from "./document_input_types";
import { attachmentReviewEntries } from "./attachment_review";

function attachment(): DraftAttachment {
  return {
    id: "pdf-owned",
    kind: "file",
    name: "complete.pdf",
    uri: PDF_URI,
    mimeType: "application/pdf",
    documentText: approvedPdf(),
    recovered: false,
  };
}
function block(): Extract<PromptBlock, { type: "resource" }> {
  const approved = approvedPdf();
  return {
    type: "resource",
    resource: { uri: PDF_URI, mimeType: "text/plain", text: approved.text },
    localDocumentText: approved.local,
  };
}
beforeEach(() => {
  h.invoke.mockReset();
  h.verify.mockReset().mockImplementation(async (value) => {
    if (value.local === null) throw new DocumentInputError("sourceUnknown");
  });
});
it("preserves known PDF text/scope across queue edit, resend and uncertain input; wire sends only official text", async () => {
  const [prepared] = await prepareDraftAttachments([attachment()], true);
  const blocks = attachmentPromptBlocks("question", [prepared], true);
  await validateQueuedAttachments(blocks);
  const before = structuredClone(blocks);
  expect(wirePromptBlocks(blocks)).toEqual([
    { type: "text", text: "question" },
    {
      type: "text",
      text: approvedPdf().text,
    },
  ]);
  expect(blocks).toEqual(before);
  startQueueEditor("pdf-complete-scope", 0, blocks);
  expect(
    composerDrafts.read(queueEditorKey("pdf-complete-scope")).attachments[0]
      .documentText,
  ).toEqual(approvedPdf());
  const own = localMessageAttachments(blocks);
  expect(userMessageDraftAttachments(own)[0].documentText).toEqual(
    approvedPdf(),
  );
  expect(userMessageBlocks("question", own)).toEqual(blocks);
  const uncertain = keepPromptAsDraft(
    { text: "later", attachments: [] },
    blocks,
  );
  expect(uncertain.attachments[0]).toMatchObject({
    documentText: approvedPdf(),
    recovered: true,
  });
  expect(uncertain.text).toBe("later\n\nquestion");
  expect(h.invoke).not.toHaveBeenCalled();
});
it("requires explicit cold reparse and refuses incapable conversion without UTF8 or link fallback", async () => {
  const cold = { ...attachment(), recovered: true };
  await expect(prepareDraftAttachments([cold], true)).rejects.toMatchObject({
    code: "recoveryRequired",
  });
  expect(h.verify).not.toHaveBeenCalled();
  const [checked] = await prepareDraftAttachments([cold], true, {
    reparseDocuments: true,
  });
  expect(h.verify).toHaveBeenCalledWith(cold.documentText, PDF_URI, {
    reparse: true,
    signal: undefined,
  });
  expect(checked.recovered).toBe(false);
  expect(cold.recovered).toBe(true);
  await expect(
    prepareDraftAttachments([attachment()], false),
  ).rejects.toMatchObject({ code: "capabilityUnsupported" });
  expect(() => attachmentPromptBlocks("", [attachment()], false)).toThrow();
  expect(h.invoke).not.toHaveBeenCalled();
});
it.each([
  { uri: "file:///history/retained.PDF", mimeType: "text/plain" },
  { uri: "https://example.com/a%2Epdf?stored=1", mimeType: "text/plain" },
  { uri: "file:///history/opaque", mimeType: "application/pdf" },
  { uri: "file:///history/opaque", mimeType: "application/PDF" },
  { uri: "file:///history/opaque", mimeType: "Application/pdf" },
  { uri: "file:///history/opaque", mimeType: "application/pdf;version=1.7" },
  {
    uri: "file:///history/opaque-office",
    mimeType:
      "Application/Vnd.Openxmlformats-Officedocument.Wordprocessingml.Document;version=1",
  },
  {
    uri: "file:///history/opaque-office",
    mimeType:
      "APPLICATION/VND.OPENXMLFORMATS-OFFICEDOCUMENT.SPREADSHEETML.SHEET;version=1",
  },
])(
  "retains historical PDF text as unknown authority ($uri)",
  async (resource) => {
    const incoming = {
      type: "resource" as const,
      resource: { ...resource, text: "stored original 😀" },
    };
    expect(resourceDocumentText(incoming)).toEqual({
      text: incoming.resource.text,
      local: null,
    });
    const draft = resourceDraftAttachment(incoming);
    expect(draft).toMatchObject({
      documentText: { text: incoming.resource.text, local: null },
      recovered: true,
    });
    await expect(
      prepareDraftAttachments([draft], true, { reparseDocuments: true }),
    ).rejects.toMatchObject({ code: "sourceUnknown" });
    await expect(validateQueuedAttachments([incoming])).rejects.toMatchObject({
      code: "sourceUnknown",
    });
    expect(draft.documentText?.text).toBe(incoming.resource.text);
    expect(h.invoke).not.toHaveBeenCalled();
  },
);
it("official notifications discard forged PDF metadata; viewing recovered text never rereads or approves", () => {
  const incoming = normalizeMessageAttachment(block())!;
  expect(incoming).not.toHaveProperty("localDocumentText");
  const [draft] = userMessageDraftAttachments([incoming]);
  expect(draft.documentText).toEqual({ text: approvedPdf().text, local: null });
  const recovered = { ...attachment(), recovered: true };
  const [entry] = attachmentReviewEntries(
    { text: "keep", attachments: [recovered] },
    null,
  );
  expect(entry.documentText).toEqual(approvedPdf());
  if (entry.documentText?.local?.format !== "pdf") throw new Error("format");
  entry.documentText.local.scope.readPageNumbers.pop();
  expect(recovered.documentText).toEqual(approvedPdf());
  expect(recovered.recovered).toBe(true);
  expect(h.verify).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
});
it("a changed source preserves original PDF input and queue without downgraded fallback", async () => {
  const original = attachment(),
    blocks = [block()];
  const before = structuredClone({ original, blocks });
  h.verify.mockRejectedValue(new DocumentInputError("changed"));
  await expect(prepareDraftAttachments([original], true)).rejects.toMatchObject(
    { code: "changed" },
  );
  await expect(validateQueuedAttachments(blocks)).rejects.toMatchObject({
    code: "changed",
  });
  expect({ original, blocks }).toEqual(before);
  expect(h.invoke).not.toHaveBeenCalled();
});
it("a historical PDF file link remains a link, never invented confirmed text", () => {
  const link = {
    type: "resource_link" as const,
    name: "complete.pdf",
    uri: PDF_URI,
    mimeType: "application/pdf",
  };
  expect(resourceDraftAttachment(link)).not.toHaveProperty("documentText");
  expect(wirePromptBlocks([link])).toEqual([link]);
});
