import { composerDrafts, newConversationChoice } from "./drafts";
import { draftPersistence } from "./draft_storage";

/** One transient notice for an exact input; neither authority nor stored data. */
export function watchDraftSave(
  revision: number,
  owns: () => boolean,
  saved: () => void,
) {
  let active = true;
  let offDraft = () => {};
  let offStorage = () => {};
  const isCurrent = () => active && owns();
  const retire = () => {
    if (!active) return;
    active = false;
    offDraft();
    offStorage();
  };
  const check = () => {
    if (!isCurrent()) retire();
    else if (draftPersistence.isSaved(revision)) {
      retire();
      saved();
    }
  };
  // Draft removal and same-object re-addition revoke synchronously, including
  // changes made before React can render. Initial check follows owner install.
  offDraft = composerDrafts.subscribe(check);
  offStorage = draftPersistence.subscribe(check);
  return { isCurrent, check, retire };
}

/** Ordinary text edits continue the same input; other replacements retire it. */
export function draftTextSaveOwner(draftKey: string, owns: () => boolean) {
  let current = composerDrafts.read(draftKey);
  const generation = composerDrafts.generation(draftKey);
  const choice = JSON.stringify(newConversationChoice);
  return () => {
    if (
      !owns() ||
      composerDrafts.generation(draftKey) !== generation ||
      (draftKey === "new" && JSON.stringify(newConversationChoice) !== choice)
    )
      return false;
    const next = composerDrafts.read(draftKey);
    if (next === current) return true;
    if (
      next.text === current.text ||
      next.attachments !== current.attachments ||
      next.sendPending !== current.sendPending ||
      next.queueEdit !== current.queueEdit ||
      next.pendingConversation !== current.pendingConversation ||
      next.savedChoice !== current.savedChoice
    )
      return false;
    current = next;
    return true;
  };
}
