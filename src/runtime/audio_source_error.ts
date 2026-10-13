import { AudioInputError } from "./audio_input";
import type { ComposerDraft, DraftAttachment } from "./drafts";

/** Transient ownership of a failed source check, never saved or sent. */
export class AudioSourceError extends AudioInputError {
  readonly attachmentId: string;
  readonly previous: DraftAttachment["localAudio"];
  readonly previousData: string | undefined;
  constructor(
    readonly original: AudioInputError,
    readonly attachment: DraftAttachment,
  ) {
    super(original.code);
    this.attachmentId = attachment.id;
    this.previous = attachment.localAudio;
    this.previousData = attachment.data;
  }
}
export function audioSourceError(
  error: unknown,
  attachment: DraftAttachment,
): unknown {
  return error instanceof AudioInputError &&
    ["changed", "sourceUnknown", "recoveryRequired", "unreadable"].includes(
      error.code,
    )
    ? new AudioSourceError(error, attachment)
    : error;
}
export interface AudioSourceConfirmation {
  draftKey: string;
  attachment: DraftAttachment;
  applied: DraftAttachment;
}
export interface AudioSourceNotice {
  draftKey: string;
  errorContext: string;
  error: AudioSourceError;
}
export function resolvedAudioSourceNotice(
  notice: AudioSourceNotice | null,
  draftKey: string,
  errorContext: string,
  confirmation: AudioSourceConfirmation,
  draft: ComposerDraft,
): boolean {
  if (!notice) return false;
  return (
    notice.draftKey === draftKey &&
    notice.errorContext === errorContext &&
    confirmation.draftKey === draftKey &&
    notice.error.attachment === confirmation.attachment &&
    notice.error.attachmentId === confirmation.attachment.id &&
    notice.error.previous === confirmation.attachment.localAudio &&
    notice.error.previousData === confirmation.attachment.data &&
    confirmation.applied.id === notice.error.attachmentId &&
    confirmation.applied.localAudio !== notice.error.previous &&
    confirmation.applied !== confirmation.attachment &&
    !!confirmation.applied.localAudio &&
    confirmation.applied.kind === "audio" &&
    !confirmation.applied.loading &&
    !draft.sendPending &&
    !draft.pendingConversation &&
    draft.attachments.includes(confirmation.applied)
  );
}
