import { useRef, useState } from "react";
import type { PreparationDraftTarget } from "../runtime/draft_preparation";
import { WORKTREE_PREPARATION_STRINGS as S } from "../runtime/worktree_preparation_strings";
import { WorktreePreparationDialog } from "./WorktreePreparationDialog";

export function WorktreePreparationControl({
  disabled,
  begin,
}: {
  disabled: boolean;
  begin: () => PreparationDraftTarget | null;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [target, setTarget] = useState<PreparationDraftTarget | null>(null);
  const latest = useRef({ disabled, begin, target });
  latest.current = { disabled, begin, target };
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="btn btn-ghost"
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => {
          if (latest.current.disabled) return;
          const next = latest.current.begin();
          if (next) setTarget(next);
        }}
      >
        {S.open}
      </button>
      {target && (
        <WorktreePreparationDialog
          target={target}
          returnFocusRef={trigger}
          onClose={() => {
            // An old save/close must never dismiss a later preparation window.
            if (latest.current.target === target) setTarget(null);
          }}
        />
      )}
    </>
  );
}
