import { useSyncExternalStore } from "react";
import { worktreeManagement } from "../runtime/worktree_management";
import { worktrees } from "../runtime/worktrees";
import { WORKTREE_STRINGS as S } from "../runtime/worktree_strings";
import { WorktreeDialog } from "./WorktreeDialog";

/** Outside DraftStartup's editable/inert subtree; queries/cancel stay reachable. */
export function WorktreeManagementHost() {
  const request = useSyncExternalStore(
    worktreeManagement.subscribe,
    worktreeManagement.snapshot,
    worktreeManagement.snapshot,
  );
  const state = useSyncExternalStore(
    worktrees.subscribe,
    worktrees.snapshot,
    worktrees.snapshot,
  );
  return (
    <>
      {state.operationId && (
        <button
          type="button"
          className="btn worktree-reopen"
          onClick={(event) => {
            if (
              !worktreeManagement.snapshot() &&
              worktrees.snapshot().operationId === state.operationId
            )
              worktreeManagement.open({
                cwd: null,
                target: null,
                returnFocusRef: { current: event.currentTarget },
              });
          }}
        >
          {S.reopen}
        </button>
      )}
      {request && (
        <WorktreeDialog
          key={request.key}
          cwd={request.cwd}
          target={request.target}
          returnFocusRef={request.returnFocusRef}
          onClose={() => worktreeManagement.close(request)}
        />
      )}
    </>
  );
}
