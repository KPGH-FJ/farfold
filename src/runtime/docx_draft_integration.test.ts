import { beforeEach, afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), verify: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./document_input", () => ({ verifyDocumentInput: h.verify }));
import {
  attachmentPromptBlocks,
  prepareDraftAttachments,
  validateQueuedAttachments,
} from "./draft_attachments";
import { localMessageAttachments, wirePromptBlocks } from "./prompt_blocks";
import {
  userMessageBlocks,
  userMessageDraftAttachments,
} from "./message_actions";
import { composerDrafts } from "./drafts";
import { startQueueEditor, queueEditorKey } from "./queue_edit";
import { keepPromptAsDraft } from "./uncertain_prompt";
import { normalizeMessageAttachment } from "./message_attachments";
import {
  approvedDocument,
  documentAttachment,
  documentBlock,
  DOCX_URI,
} from "./docx_draft.test-support";

beforeEach(() => {
  h.invoke.mockReset();
  h.verify.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

it("retains exact approved bytes through prepare, queue edit, resend, new draft and unknown input; never UTF-8-reads binary DOCX", async () => {
  const attachment = documentAttachment();
  const [prepared] = await prepareDraftAttachments([attachment], true);
  const blocks = attachmentPromptBlocks("question", [prepared], true);
  await validateQueuedAttachments(blocks);
  const sent = wirePromptBlocks(blocks);
  expect(sent).toEqual([
    { type: "text", text: "question" },
    {
      type: "text",
      text: attachment.documentText!.text,
    },
  ]);
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.verify).toHaveBeenCalledTimes(2);
  expect(
    h.verify.mock.calls.every(
      ([approved, uri]) =>
        uri === DOCX_URI && approved.text === attachment.documentText!.text,
    ),
  ).toBe(true);
  startQueueEditor("docx-preserve", 0, blocks);
  const queueEdit = composerDrafts.read(queueEditorKey("docx-preserve"));
  expect(queueEdit.attachments[0].documentText).toEqual(
    attachment.documentText,
  );
  expect(queueEdit.queueEdit?.original).toEqual(blocks);
  const projected = localMessageAttachments(blocks);
  const resend = userMessageDraftAttachments(projected);
  expect(resend[0].documentText).toEqual(attachment.documentText);
  expect(userMessageBlocks("question", projected)).toEqual(blocks);
  const unknown = keepPromptAsDraft(
    { text: "later typing", attachments: [] },
    blocks,
  );
  expect(unknown.text).toBe("later typing\n\nquestion");
  expect(unknown.attachments[0]).toMatchObject({
    documentText: attachment.documentText,
    recovered: true,
  });
  expect(attachment.documentText).toEqual(approvedDocument());
});

it.each(["prepare", "dispatch"])(
  "a changed source rejects %s without replacing old text, reading UTF-8 or producing a link",
  async (route) => {
    const attachment = documentAttachment();
    const blocks = [documentBlock()];
    const oldAttachment = structuredClone(attachment),
      oldBlocks = structuredClone(blocks);
    h.verify.mockRejectedValue(new Error("source changed"));
    await expect(
      route === "prepare"
        ? prepareDraftAttachments([attachment], true)
        : validateQueuedAttachments(blocks),
    ).rejects.toThrow("source changed");
    expect(attachment).toEqual(oldAttachment);
    expect(blocks).toEqual(oldBlocks);
    expect(h.invoke).not.toHaveBeenCalled();
  },
);

it("requires explicit cold review to reparse; ordinary preparation cannot clear recovery or downgrade on missing capability", async () => {
  const attachment = documentAttachment(true);
  await expect(prepareDraftAttachments([attachment], true)).rejects.toThrow();
  expect(h.verify).not.toHaveBeenCalled();
  const [reviewed] = await prepareDraftAttachments([attachment], true, {
    reparseDocuments: true,
  });
  expect(h.verify).toHaveBeenCalledWith(attachment.documentText, DOCX_URI, {
    reparse: true,
    signal: undefined,
  });
  expect(reviewed).toMatchObject({
    documentText: attachment.documentText,
    recovered: false,
  });
  h.verify.mockClear();
  await expect(
    prepareDraftAttachments([documentAttachment()], false),
  ).rejects.toThrow();
  expect(() =>
    attachmentPromptBlocks("question", [documentAttachment()], false),
  ).toThrow();
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.verify).not.toHaveBeenCalled();
  expect(attachment.recovered).toBe(true);
});

it("official history keeps returned DOCX text without accepting forged local source authority", async () => {
  const resource = documentBlock();
  const incoming = normalizeMessageAttachment(resource)!;
  expect(incoming).not.toHaveProperty("localDocumentText");
  const [draft] = userMessageDraftAttachments([incoming]);
  expect(draft).toMatchObject({
    recovered: true,
    documentText: { text: resource.resource.text, local: null },
  });
  h.verify.mockImplementation(async (approved) => {
    if (approved.local === null) throw new Error("source unknown");
  });
  await expect(
    prepareDraftAttachments([draft], true, { reparseDocuments: true }),
  ).rejects.toThrow("source unknown");
  await expect(
    validateQueuedAttachments(userMessageBlocks("retry", [incoming])),
  ).rejects.toThrow("source unknown");
  expect(draft.documentText?.text).toBe(resource.resource.text);
  expect(h.invoke).not.toHaveBeenCalled();
});

it("wire whitelisting strips every local field, including arbitrary nested fields, without mutating durable queue metadata", () => {
  const block = documentBlock();
  const owned = [block];
  Object.assign(block, { arbitraryLocal: "never sent" });
  Object.assign(block.resource, { fileVersion: "never sent" });
  const before = structuredClone(owned);
  const wire = wirePromptBlocks(owned);
  expect(wire).toEqual([
    {
      type: "text",
      text: block.resource.text,
    },
  ]);
  expect(JSON.stringify(wire)).not.toContain("localDocumentText");
  expect(JSON.stringify(wire)).not.toContain("fileVersion");
  expect(owned).toEqual(before);
});
