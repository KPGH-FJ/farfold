import type { ComposerDraft, DraftAttachment } from "./drafts";
import {
  DocumentInputError,
  type ApprovedDocumentText,
} from "./document_input_types";

/** Only a failed source check; never persist or include this in prompt blocks. */
export class DocumentSourceError extends DocumentInputError {
  readonly attachmentId: string;
  readonly previous: ApprovedDocumentText;
  constructor(
    readonly original: DocumentInputError,
    readonly attachment: DraftAttachment,
  ) {
    super(original.code);
    this.message = original.message;
    this.name = original.name;
    this.attachmentId = attachment.id;
    this.previous = attachment.documentText!;
  }
}

export function documentSourceError(
  error: unknown,
  attachment: DraftAttachment,
): unknown {
  return error instanceof DocumentInputError &&
    ["changed", "sourceUnknown", "recoveryRequired"].includes(error.code) &&
    attachment.documentText
    ? new DocumentSourceError(error, attachment)
    : error;
}

export interface DocumentSourceConfirmation {
  draftKey: string;
  attachment: DraftAttachment;
  applied: DraftAttachment;
  approved: ApprovedDocumentText;
}
export interface DocumentSourceNotice {
  draftKey: string;
  errorContext: string;
  error: DocumentSourceError;
}

export function resolvedDocumentSourceNotice(
  notice: DocumentSourceNotice | null,
  draftKey: string,
  errorContext: string,
  confirmation: DocumentSourceConfirmation,
  draft: ComposerDraft,
): boolean {
  if (!notice) return false;
  const failed = notice.error;
  return (
    notice.draftKey === draftKey &&
    notice.errorContext === errorContext &&
    confirmation.draftKey === draftKey &&
    failed.attachment === confirmation.attachment &&
    failed.attachmentId === confirmation.attachment.id &&
    failed.previous === confirmation.attachment.documentText &&
    confirmation.approved !== failed.previous &&
    confirmation.approved.local !== null &&
    !draft.sendPending &&
    !draft.pendingConversation &&
    draft.attachments.some(
      (item) =>
        item === confirmation.applied &&
        item.id === failed.attachmentId &&
        item.documentText === confirmation.approved &&
        !item.loading,
    )
  );
}
