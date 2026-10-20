import {
  composerDrafts,
  newConversationChoice,
  type ComposerDraft,
  type DraftAttachment,
} from "./drafts";
import { draftPersistence } from "./draft_storage";
import {
  AudioInputError,
  localAudio,
  addAudioBytes,
  type AudioCapture,
} from "./audio_input";
import { localResourcePath } from "./file_delivery";

/** One explicit audio review, bound to the unchanged draft and selected target. */
export function createAudioInputTarget(
  key: string,
  attachment: DraftAttachment,
  owns: () => boolean,
) {
  const generation = composerDrafts.generation(key);
  const choice = JSON.stringify(newConversationChoice);
  let current: ComposerDraft = composerDrafts.read(key);
  let selected = attachment;
  let retired = false;
  let mutating = false;
  let offDraft = () => {};
  let offStorage = () => {};
  const savingReads = new Set<() => void>();
  const releaseSavingReads = () => {
    for (const finish of savingReads) finish();
  };
  const isCurrent = () =>
    !retired &&
    owns() &&
    draftPersistence.snapshot().ready &&
    !draftPersistence.snapshot().error &&
    !draftPersistence.snapshot().interactionLocked &&
    composerDrafts.generation(key) === generation &&
    (key !== "new" || JSON.stringify(newConversationChoice) === choice) &&
    composerDrafts.read(key) === current &&
    current.attachments.includes(selected) &&
    !current.sendPending &&
    !current.pendingConversation;
  const retire = () => {
    if (retired) return;
    retired = true;
    releaseSavingReads();
    offDraft();
    offStorage();
    if (
      composerDrafts.read(key).attachments.includes(selected) &&
      selected.loading
    )
      composerDrafts.update(key, (draft) => ({
        ...draft,
        attachments: draft.attachments.map((item) =>
          item === selected ? attachment : item,
        ),
      }));
  };
  if (
    !isCurrent() ||
    (attachment.kind !== "audio" && attachment.kind !== "file") ||
    !attachment.uri ||
    current.attachments.some((a) => a.loading)
  )
    throw new AudioInputError("changed");
  mutating = true;
  composerDrafts.update(key, (draft) => {
    selected = { ...attachment, loading: true };
    current = {
      ...draft,
      attachments: draft.attachments.map((item) =>
        item === attachment ? selected : item,
      ),
    };
    return current;
  });
  mutating = false;
  const observe = () => {
    if (!mutating && !isCurrent()) retire();
  };
  offDraft = composerDrafts.subscribe(observe);
  offStorage = draftPersistence.subscribe(observe);
  return {
    isCurrent,
    retire,
    /** Only an active review contributes pending input to saving. The caller
     * still awaits the actual read, whose native permit is never released here. */
    trackRead(task: Promise<unknown>) {
      const waiting = new Promise<void>((resolve) => {
        const finish = () => {
          savingReads.delete(finish);
          resolve();
        };
        if (!retired) savingReads.add(finish);
        // Always consume the real outcome, including already retired reviews.
        void task.then(finish, finish);
        if (retired) finish();
      });
      draftPersistence.trackAttachment(waiting);
    },
    apply(capture: AudioCapture): boolean {
      if (
        !isCurrent() ||
        localResourcePath(attachment.uri ?? "") !== capture.file.path
      )
        return false;
      current.attachments.reduce(
        (total, item) =>
          addAudioBytes(
            total,
            item === selected || item.kind !== "audio"
              ? 0
              : (item.localAudio?.file.size ?? 0),
          ),
        capture.file.size,
      );
      retired = true;
      releaseSavingReads();
      offDraft();
      offStorage();
      composerDrafts.update(key, (draft) => ({
        ...draft,
        attachments: draft.attachments.map((item) =>
          item === selected
            ? {
                ...item,
                kind: "audio",
                content: undefined,
                data: capture.data,
                mimeType: capture.mimeType,
                localAudio: localAudio(capture),
                loading: false,
                recovered: false,
                audioClassificationFailed: undefined,
              }
            : item,
        ),
      }));
      return true;
    },
  };
}
