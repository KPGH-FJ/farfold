import { expect, it } from "vitest";
import type { ComposerDraft, DraftAttachment } from "./drafts";
import {
  DocumentInputError,
  type ApprovedDocumentText,
} from "./document_input_types";
import {
  DocumentSourceError,
  documentSourceError,
  resolvedDocumentSourceNotice,
  type DocumentSourceConfirmation,
} from "./document_source_error";

function fixture() {
  const previous: ApprovedDocumentText = { text: "Original text", local: null };
  const attachment: DraftAttachment = {
    id: "original",
    kind: "file",
    uri: "file:///owned/source.docx",
    name: "source.docx",
    documentText: previous,
  };
  const approved: ApprovedDocumentText = {
    text: "Reviewed current text",
    local: {
      schema: 1,
      format: "docx",
      source: {
        root: "/owned",
        path: "/owned/source.docx",
        resolvedPath: "/owned/source.docx",
        name: "source.docx",
        size: 100,
        sha256: "a".repeat(64),
        version: "new",
      },
      textSha256: "b".repeat(64),
      utf8Bytes: 21,
      selection: "read-visible-text",
      partial: false,
      partialSelected: false,
      warnings: [],
      imageReferences: 0,
    },
  };
  const original = new DocumentInputError("sourceUnknown");
  const error = documentSourceError(
    original,
    attachment,
  ) as DocumentSourceError;
  const notice = { draftKey: "owned", errorContext: "context", error };
  const applied = { ...attachment, documentText: approved };
  const confirmation: DocumentSourceConfirmation = {
    draftKey: "owned",
    attachment,
    applied,
    approved,
  };
  const draft: ComposerDraft = {
    text: "Keep ordinary input",
    attachments: [applied],
  };
  const resolved = (
    next = confirmation,
    current = draft,
    key = "owned",
    context = "context",
  ) => resolvedDocumentSourceNotice(notice, key, context, next, current);
  return {
    original,
    error,
    attachment,
    approved,
    confirmation,
    draft,
    resolved,
  };
}

it("preserves the actual source error instance, message and code without altering the attachment", () => {
  const { original, error, attachment } = fixture();
  expect(error).toBeInstanceOf(DocumentInputError);
  expect(error.original).toBe(original);
  expect(error.message).toBe(original.message);
  expect(error.code).toBe(original.code);
  expect(error.attachment).toBe(attachment);
  expect(Object.keys(attachment)).not.toContain("error");
});

it.each(["capabilityUnsupported", "capabilityUnknown", "unreadable"] as const)(
  "does not classify %s as a source correction cleared by new approval",
  (code) => {
    const { attachment } = fixture();
    const error = new DocumentInputError(code);
    expect(documentSourceError(error, attachment)).toBe(error);
  },
);

it("leaves ordinary Agent errors intact even with identical display text", () => {
  const { attachment, original } = fixture();
  const other = new Error(original.message);
  expect(documentSourceError(other, attachment)).toBe(other);
});

it("resolves only the old failed input after its new approved object is actually installed", () => {
  const { resolved, confirmation, draft, attachment } = fixture();
  expect(resolved()).toBe(true);
  expect(resolved(confirmation, { ...draft, attachments: [attachment] })).toBe(
    false,
  );
  expect(resolved(confirmation, { ...draft, sendPending: true })).toBe(false);
  expect(
    resolved(confirmation, {
      ...draft,
      attachments: [{ ...draft.attachments[0], loading: true }],
    }),
  ).toBe(false);
});

it("same path/id/text remove-readd or another attachment cannot repair the original failure", () => {
  const { resolved, confirmation, attachment } = fixture();
  expect(resolved({ ...confirmation, attachment: { ...attachment } })).toBe(
    false,
  );
  expect(
    resolved({ ...confirmation, attachment: { ...attachment, id: "other" } }),
  ).toBe(false);
});

it("a stale context, different draft or no-longer-current approved object cannot clear the notice", () => {
  const { resolved, confirmation, approved, draft } = fixture();
  expect(resolved(confirmation, draft, "other")).toBe(false);
  expect(resolved(confirmation, draft, "owned", "new-context")).toBe(false);
  expect(resolved({ ...confirmation, draftKey: "other" })).toBe(false);
  expect(
    resolved(confirmation, {
      ...draft,
      attachments: [{ ...confirmation.applied }],
    }),
  ).toBe(false);
  expect(
    resolved(confirmation, {
      ...draft,
      attachments: [{ ...draft.attachments[0], documentText: { ...approved } }],
    }),
  ).toBe(false);
  expect(
    resolved({ ...confirmation, approved: { ...approved, local: null } }),
  ).toBe(false);
});
