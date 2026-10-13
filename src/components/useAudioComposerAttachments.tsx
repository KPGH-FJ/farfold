import type { AudioSourceConfirmation } from "../runtime/audio_source_error";
import { useEffect, useRef, useState } from "react";
import {
  composerDrafts,
  newConversationChoice,
  type DraftAttachment,
} from "../runtime/drafts";
import { draftPersistence } from "../runtime/draft_storage";
import { watchDraftSave } from "../runtime/draft_save_notice";
import { createAudioInputTarget } from "../runtime/audio_input_draft";
import {
  AUDIO_INPUT as S,
  audioNameCandidate,
  hasAudioReviewSource,
  audioCapabilityNotice,
  audioInputFailure,
  localAudio,
  readAudioInput,
  type AudioCapture,
} from "../runtime/audio_input";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { AudioInputDetails } from "./AudioInputDetails";

type Target = ReturnType<typeof createAudioInputTarget>;
type Selection = { attachment: DraftAttachment; target: Target };
/** Audio uses the same attachment chips, modal and save/recovery workflow. */
export function useAudioComposerAttachments({
  draftKey,
  context,
  enabled,
  items,
  capability,
  onSaved,
}: {
  draftKey: string;
  context: string;
  enabled: boolean;
  items: readonly DraftAttachment[];
  capability?: boolean;
  onSaved?: (confirmation: AudioSourceConfirmation) => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [result, setResult] = useState<AudioCapture | null>(null);
  const [working, setWorking] = useState<"reading" | "confirming" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<DraftAttachment | null>(null);
  const ticket = useRef<Target | null>(null);
  const save = useRef<ReturnType<typeof watchDraftSave> | null>(null);
  const live = useRef({ draftKey, context, enabled });
  live.current = { draftKey, context, enabled };
  const close = () => {
    ticket.current?.retire();
    ticket.current = null;
    setSelection(null);
    setResult(null);
    setWorking(null);
    setError(null);
  };
  useEffect(() => {
    close();
    setSaved(null);
    save.current?.retire();
    return () => {
      ticket.current?.retire();
      ticket.current = null;
      save.current?.retire();
    };
  }, [draftKey, context, enabled]);
  useEffect(() => {
    if (selection && !selection.target.isCurrent()) close();
  }, [items, selection]);
  const read = async (attachment: DraftAttachment) => {
    if (
      !enabled ||
      ticket.current ||
      !attachment.uri ||
      !hasAudioReviewSource(attachment)
    )
      return;
    if (attachment.mimeType !== "audio/wav") {
      setError(S.unsupported);
      return;
    }
    const owns = () =>
      live.current.enabled &&
      live.current.draftKey === draftKey &&
      live.current.context === context;
    let target: Target;
    try {
      target = createAudioInputTarget(draftKey, attachment, owns);
    } catch (reason) {
      setError(audioInputFailure(reason));
      return;
    }
    ticket.current = target;
    save.current?.retire();
    setSaved(null);
    setSelection({ attachment, target });
    setResult(null);
    setError(null);
    setWorking("reading");
    const task = readAudioInput(attachment.uri);
    draftPersistence.trackAttachment(task);
    try {
      const value = await task;
      if (ticket.current === target && target.isCurrent()) {
        setResult(value);
        setWorking(null);
      }
    } catch (reason) {
      if (ticket.current !== target) return;
      if (target.isCurrent()) {
        setError(audioInputFailure(reason));
        setWorking(null);
      } else close();
    }
  };
  const confirm = async () => {
    if (!selection || !result || working || !selection.target.isCurrent())
      return;
    const target = selection.target;
    setWorking("confirming");
    setError(null);
    try {
      await draftPersistence.flush();
      if (ticket.current !== target || !target.isCurrent()) return;
      const task = readAudioInput(selection.attachment.uri!, result.file);
      draftPersistence.trackAttachment(task);
      const fresh = await task;
      if (fresh.data !== result.data) throw new Error(S.changed);
      if (ticket.current !== target || !target.apply(fresh)) return;
      const applied = composerDrafts
        .read(draftKey)
        .attachments.find((a) => a.id === selection.attachment.id)!;
      ticket.current = null;
      setSelection(null);
      setResult(null);
      setWorking(null);
      const generation = composerDrafts.generation(draftKey);
      const choice = JSON.stringify(newConversationChoice);
      const notice = watchDraftSave(
        draftPersistence.revision(),
        () =>
          live.current.enabled &&
          live.current.draftKey === draftKey &&
          live.current.context === context &&
          ticket.current === null &&
          composerDrafts.generation(draftKey) === generation &&
          (draftKey !== "new" ||
            JSON.stringify(newConversationChoice) === choice) &&
          composerDrafts.read(draftKey).attachments.includes(applied) &&
          !composerDrafts.read(draftKey).sendPending &&
          !composerDrafts.read(draftKey).pendingConversation &&
          !applied.loading,
        () => {
          if (save.current !== notice) return;
          save.current = null;
          setSaved(applied);
          setError(null);
          onSaved?.({ draftKey, attachment: selection.attachment, applied });
        },
      );
      save.current = notice;
      notice.check();
      try {
        await draftPersistence.flush();
        notice.check();
      } catch {
        if (notice.isCurrent()) setError(S.saveFailed);
      }
    } catch (reason) {
      if (ticket.current !== target) return;
      if (target.isCurrent()) {
        setError(audioInputFailure(reason));
        setWorking(null);
      } else close();
    }
  };
  return {
    action: (item: DraftAttachment) =>
      item.audioClassificationFailed ? (
        <small role="status">{S.classificationFailed}</small>
      ) : item.kind === "audio" ||
        audioNameCandidate(item.name, item.mimeType) ? (
        <>
          <small className="document-input-state">
            {item.kind === "file"
              ? S.filePosition
              : item.localAudio
                ? draftPersistence.isSaved(draftPersistence.revision())
                  ? S.approved
                  : draftPersistence.snapshot().error
                    ? S.saveFailed
                    : S.awaitingSave
                : item.data
                  ? S.sourceUnknown
                  : S.approvalRequired}
          </small>
          <button
            type="button"
            className="document-input-action"
            disabled={
              !enabled ||
              !!working ||
              !hasAudioReviewSource(item) ||
              items.some((a) => a.loading)
            }
            onClick={() => void read(item)}
          >
            {item.localAudio ? S.reread : S.read}
          </button>
        </>
      ) : null,
    dialog: (
      <>
        {saved && items.includes(saved) && (
          <p role="status" className="composer-command-hint">
            {S.saved}
          </p>
        )}
        {!selection && error && (
          <p role="alert" className="composer-command-hint">
            {error}
          </p>
        )}
        {selection && (
          <WorkspaceDialog title={S.title} onClose={close}>
            <div className="workspace-dialog-body">
              <p>{selection.attachment.name}</p>
              <p>{S.scope}</p>
              <p>{S.formats}</p>
              {audioCapabilityNotice(capability) && (
                <p role="status">{audioCapabilityNotice(capability)}</p>
              )}
              {working && (
                <p role="status">
                  {working === "reading" ? S.reading : S.confirming}
                </p>
              )}
              {result && <AudioInputDetails audio={localAudio(result)} />}
              {error && (
                <p role="alert" className="ac-error">
                  {error}
                </p>
              )}
            </div>
            <footer>
              <button type="button" className="btn btn-ghost" onClick={close}>
                {S.cancel}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!result || !!working}
                onClick={() => void confirm()}
              >
                {S.confirm}
              </button>
            </footer>
          </WorkspaceDialog>
        )}
      </>
    ),
  };
}
