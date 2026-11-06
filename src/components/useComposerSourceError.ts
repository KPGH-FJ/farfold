import {
  AudioSourceError,
  resolvedAudioSourceNotice,
  type AudioSourceConfirmation,
  type AudioSourceNotice,
} from "../runtime/audio_source_error";
import { useEffect, useRef, useState } from "react";
import { composerDrafts, type DraftAttachment } from "../runtime/drafts";
import { DraftSaveError } from "../runtime/draft_storage";
import {
  draftTextSaveOwner,
  watchDraftSave,
} from "../runtime/draft_save_notice";
import {
  DocumentSourceError,
  resolvedDocumentSourceNotice,
  type DocumentSourceConfirmation,
  type DocumentSourceNotice,
} from "../runtime/document_source_error";
import { toUiNotice, type UiNotice } from "../runtime/ui_error";
import { STRINGS } from "../runtime/strings";

type ImageImportNotice = {
  draftKey: string;
  errorContext: string;
  generation: number;
  id: string;
  message: string;
};

/** A notice belongs to its failed input, independently of editable draft text. */
export function useComposerSourceError(
  draftKey: string,
  errorContext: string,
  attachments: readonly DraftAttachment[],
) {
  const [sendError, updateError] = useState<UiNotice | null>(null);
  const [imageImportNotices, setImageImportNotices] = useState<
    ImageImportNotice[]
  >([]);
  const generation = composerDrafts.generation(draftKey);
  const source = useRef<DocumentSourceNotice | null>(null);
  const audioSource = useRef<AudioSourceNotice | null>(null);
  const save = useRef<ReturnType<typeof watchDraftSave> | null>(null);
  const context = useRef({ draftKey, errorContext });
  context.current = { draftKey, errorContext };
  const setSendError = (notice: UiNotice | null) => {
    save.current?.retire();
    save.current = null;
    source.current = null;
    audioSource.current = null;
    updateError(notice);
  };
  useEffect(() => {
    setSendError(null);
    setImageImportNotices([]);
    return () => {
      save.current?.retire();
      save.current = null;
    };
  }, [draftKey, errorContext]);
  return {
    sendError,
    setSendError,
    imageImportMessage: imageImportNotices.find(
      (notice) =>
        notice.draftKey === draftKey &&
        notice.errorContext === errorContext &&
        notice.generation === generation &&
        attachments.some((attachment) => attachment.id === notice.id),
    )?.message,
    reportImport(message: string, failedImageId?: string) {
      const current = context.current;
      if (
        current.draftKey !== draftKey ||
        current.errorContext !== errorContext ||
        composerDrafts.generation(draftKey) !== generation
      )
        return;
      if (failedImageId === undefined) {
        setSendError({ message });
        return;
      }
      const live = new Set(
        composerDrafts.read(draftKey).attachments.map(({ id }) => id),
      );
      if (!live.has(failedImageId)) return;
      setImageImportNotices((previous) => [
        { draftKey, errorContext, generation, id: failedImageId, message },
        ...previous.filter(
          (notice) => notice.id !== failedImageId && live.has(notice.id),
        ),
      ]);
    },
    setSendFailure(error: unknown) {
      save.current?.retire();
      save.current = null;
      audioSource.current =
        error instanceof AudioSourceError
          ? { draftKey, errorContext, error }
          : null;
      source.current =
        error instanceof DocumentSourceError
          ? { draftKey, errorContext, error }
          : null;
      updateError(toUiNotice(error, STRINGS.repair.sendFailed));
      if (error instanceof DraftSaveError) {
        const notice = watchDraftSave(
          error.revision,
          draftTextSaveOwner(
            draftKey,
            () =>
              context.current.draftKey === draftKey &&
              context.current.errorContext === errorContext,
          ),
          () => {
            if (save.current === notice) setSendError(null);
          },
        );
        save.current = notice;
        notice.check();
      }
    },
    audioSaved(confirmation: AudioSourceConfirmation) {
      const current = context.current;
      if (
        resolvedAudioSourceNotice(
          audioSource.current,
          current.draftKey,
          current.errorContext,
          confirmation,
          composerDrafts.read(current.draftKey),
        )
      )
        setSendError(null);
    },
    documentSaved(confirmation: DocumentSourceConfirmation) {
      const current = context.current;
      if (
        resolvedDocumentSourceNotice(
          source.current,
          current.draftKey,
          current.errorContext,
          confirmation,
          composerDrafts.read(current.draftKey),
        )
      )
        setSendError(null);
    },
  };
}
