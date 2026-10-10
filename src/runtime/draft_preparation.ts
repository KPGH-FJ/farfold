import {
  composerDrafts,
  draftPersistence,
  newConversationChoice,
  type ComposerDraft,
} from "./drafts";
import { WORKTREE_PREPARATION_STRINGS as S } from "./worktree_preparation_strings";

export type PreparationAppendResult = "added-saved" | "added-unsaved" | "stale";
export type PreparationSaveResult = "saved" | "unsaved" | "stale";
export type PreparationDraftTarget = Readonly<{
  owner: object;
  cwd: string;
  isCurrent: () => boolean;
  appendOnce: (
    text: string,
    validate: () => Promise<void>,
  ) => Promise<PreparationAppendResult>;
  retrySave: () => Promise<PreparationSaveResult>;
  retire: () => void;
}>;

/** One transient intent; no session identity or durable preparation ledger. */
export function createPreparationDraftTarget(
  cwd: string,
  owns: () => boolean,
): PreparationDraftTarget {
  const original = composerDrafts.read("new");
  const generation = composerDrafts.generation("new");
  const choice = JSON.stringify(newConversationChoice);
  let retired = false;
  let consumed = false;
  let working = false;
  let inserted: ComposerDraft | null = null;
  const context = () => {
    const owned = owns();
    return (
      !retired &&
      owned &&
      !draftPersistence.snapshot().interactionLocked &&
      composerDrafts.generation("new") === generation &&
      JSON.stringify(newConversationChoice) === choice
    );
  };
  const isCurrent = () =>
    context() &&
    !consumed &&
    composerDrafts.read("new") === original &&
    !original.sendPending &&
    !original.pendingConversation &&
    !original.queueEdit &&
    !original.attachments.some((a) => a.loading);
  // Observe changes synchronously, including A -> B -> A before React renders.
  const unsubscribe = composerDrafts.subscribe(() => {
    if (!consumed && !isCurrent()) retire();
  });
  const unwatchStorage = draftPersistence.subscribe(() => {
    if (!context()) retire();
  });
  function retire() {
    retired = true;
    unsubscribe();
    unwatchStorage();
  }
  return Object.freeze({
    owner: Object.freeze({}),
    cwd,
    isCurrent,
    retire,
    async appendOnce(
      text: string,
      validate: () => Promise<void>,
    ): Promise<PreparationAppendResult> {
      if (working || !isCurrent() || !text.trim() || text.length > 32000)
        return "stale";
      working = true;
      try {
        try {
          await draftPersistence.flush();
        } catch {
          throw new Error(S.saveBeforeFailed);
        }
        if (!isCurrent()) return "stale";
        await validate();
        if (!isCurrent()) return "stale";
        // Consume before synchronous subscribers can re-enter appendOnce.
        consumed = true;
        unsubscribe();
        unwatchStorage();
        composerDrafts.update("new", (current) => {
          if (current !== original) return current;
          inserted = {
            ...current,
            text: current.text ? `${current.text}\n\n${text}` : text,
          };
          return inserted;
        });
        if (!inserted) return "stale";
        try {
          await draftPersistence.flush();
          return "added-saved";
        } catch {
          return "added-unsaved";
        }
      } finally {
        working = false;
      }
    },
    async retrySave(): Promise<PreparationSaveResult> {
      if (
        working ||
        !inserted ||
        !context() ||
        composerDrafts.read("new") !== inserted
      )
        return "stale";
      working = true;
      try {
        await draftPersistence.flush();
        return "saved";
      } catch {
        return context() && composerDrafts.read("new") === inserted
          ? "unsaved"
          : "stale";
      } finally {
        working = false;
      }
    },
  });
}
