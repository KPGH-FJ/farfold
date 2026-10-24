import { useEffect, useRef, type MutableRefObject } from "react";
import {
  findWorkLocationGuidance,
  useWorkLocationGuidance,
} from "../runtime/archived_work_location";
import { worktrees } from "../runtime/worktrees";
import { ARCHIVED_WORK_LOCATION as S } from "../runtime/archived_work_location_strings";
import { WORKTREE_STRINGS as W } from "../runtime/worktree_strings";
import { ArchivedWorkLocationNotice } from "./ArchivedWorkLocationNotice";
import type { ComposerDraft } from "../runtime/drafts";
import { ErrorNotice } from "./ErrorNotice";

export class DraftArchiveBlockedError extends Error {}

/** Keep only this cwd's observed archive barrier; a backup alone never blocks. */
export function useDraftArchiveGuard(
  cwd: string | null,
  active: boolean,
  pendingFolderSend: MutableRefObject<unknown>,
) {
  // Shared subscription and read-only cold catalogue loading.
  useWorkLocationGuidance(cwd, active);
  const slot = useRef({ cwd, blocked: false });
  if (slot.current.cwd !== cwd) slot.current = { cwd, blocked: false };
  const owner = slot.current;
  const live = useRef({ owner, active });
  live.current = { owner, active };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const read = () => {
    const state = worktrees.snapshot();
    const guidance = findWorkLocationGuidance(state, cwd);
    const fresh = guidance?.kind === "archive";
    // A refresh does not erase a successfully received catalogue association.
    const retained = findWorkLocationGuidance(
      { ...state, loading: false, error: null },
      cwd,
    );
    if (fresh || retained?.kind === "archive") owner.blocked = true;
    else if (
      state.ready &&
      !state.loading &&
      !state.error &&
      !state.archives.some(
        (archive) =>
          findWorkLocationGuidance({ ...state, archives: [archive] }, cwd)
            ?.kind === "archive",
      )
    )
      owner.blocked = false;
    const checking = Boolean(cwd && !state.ready);
    return {
      blocked: owner.blocked || checking,
      fresh,
      message: owner.blocked
        ? W.draftArchiveUnconfirmed
        : state.error
          ? W.draftCatalogueFailed
          : W.draftCatalogueChecking,
      loading: state.loading,
    };
  };
  const { blocked, fresh, message, loading } = read();
  useEffect(() => {
    if (blocked) pendingFolderSend.current = null;
  }, [blocked, pendingFolderSend]);
  return {
    blocked,
    isBlocked: () => read().blocked,
    requireAvailable() {
      const value = read();
      if (value.blocked) {
        pendingFolderSend.current = null;
        throw new DraftArchiveBlockedError(
          value.fresh ? S.notice : value.message,
        );
      }
    },
    notice:
      !active || !blocked ? null : fresh ? (
        <ArchivedWorkLocationNotice
          cwd={cwd}
          active={active}
          message={S.notice}
        />
      ) : (
        <ErrorNotice message={message} role={loading ? "status" : "alert"}>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              if (
                mounted.current &&
                live.current.owner === owner &&
                live.current.active &&
                !worktrees.snapshot().loading
              )
                void worktrees.load();
            }}
          >
            {W.refresh}
          </button>
        </ErrorNotice>
      ),
  };
}

/** The folderless-send arm is valid only while this original content is unchanged. */
export function folderSendSignature(draft: ComposerDraft) {
  return JSON.stringify([
    draft.text,
    draft.attachments.map((item) => [
      item.kind,
      item.name,
      item.uri ?? "",
      item.deliveryMode ?? "",
      item.data?.length ?? 0,
    ]),
  ]);
}
