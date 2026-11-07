import {
  composerDrafts,
  newConversationChoice,
  type ComposerDraft,
  type DraftAttachment,
} from "./drafts";
import { draftPersistence } from "./draft_storage";
import type { ApprovedDocumentText } from "./document_input_types";
import { DOCUMENT_INPUT_STRINGS as S } from "./document_input_strings";
import { localResourcePath } from "./file_delivery";

/** A transient selection in an existing unsent draft, never a send grant. */
export function createDocumentInputTarget(
  draftKey: string,
  attachment: DraftAttachment,
  owns: () => boolean,
) {
  const original = composerDrafts.read(draftKey);
  const generation = composerDrafts.generation(draftKey);
  const choice = JSON.stringify(newConversationChoice);
  const controller = new AbortController();
  let current: ComposerDraft = original;
  let selected: DraftAttachment = attachment;
  let retired = false;
  let mutating = false;
  let offDraft = () => {};
  let offStorage = () => {};
  const context = () =>
    !retired &&
    owns() &&
    draftPersistence.snapshot().ready &&
    !draftPersistence.snapshot().error &&
    !draftPersistence.snapshot().interactionLocked &&
    composerDrafts.generation(draftKey) === generation &&
    (draftKey !== "new" || JSON.stringify(newConversationChoice) === choice);
  const isCurrent = () =>
    context() &&
    composerDrafts.read(draftKey) === current &&
    current.attachments.includes(selected) &&
    !current.sendPending &&
    !current.pendingConversation;

  function retire() {
    if (retired) return;
    retired = true;
    offDraft();
    offStorage();
    controller.abort();
    // Clear only our exact chip; a removed/re-added file or another draft's
    // loading work is not ours, even if its path/text is equal.
    const value = composerDrafts.read(draftKey);
    if (value.attachments.includes(selected) && selected.loading)
      composerDrafts.update(draftKey, (draft) => ({
        ...draft,
        attachments: draft.attachments.map((item) =>
          item === selected ? attachment : item,
        ),
      }));
  }
  if (
    !isCurrent() ||
    attachment.kind !== "file" ||
    !attachment.uri ||
    original.attachments.some((item) => item.loading)
  ) {
    retired = true;
    controller.abort();
    throw new Error(S.changed);
  }
  // Publish our next identity before synchronous observers can see it.
  mutating = true;
  composerDrafts.update(draftKey, (draft) => {
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
  observe();
  return {
    signal: controller.signal,
    isCurrent,
    retire,
    apply(approved: ApprovedDocumentText): boolean {
      if (
        !isCurrent() ||
        approved.local === null ||
        localResourcePath(attachment.uri ?? "") !== approved.local.source.path
      )
        return false;
      // Retire before the synchronous draft publish; consume this selection
      // once and retain the reviewed text even when the later save fails.
      retired = true;
      offDraft();
      offStorage();
      composerDrafts.update(draftKey, (draft) => ({
        ...draft,
        attachments: draft.attachments.map((item) =>
          item === selected
            ? {
                ...item,
                deliveryMode: "text",
                documentText: approved,
                content: undefined,
                imageClassificationFailed: undefined,
                loading: false,
                recovered: false,
              }
            : item,
        ),
      }));
      return true;
    },
  };
}
