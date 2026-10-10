import { useRef } from "react";
import { WORKTREE_STRINGS as S } from "../runtime/worktree_strings";
import {
  worktreeManagement,
  type WorkLocationIntent,
} from "../runtime/worktree_management";

/** Alongside the existing ordinary-folder action; no Agent or send calls. */
export function WorkLocationPicker({
  cwd,
  disabled,
  begin,
}: {
  cwd: string | null;
  disabled: boolean;
  begin: () => WorkLocationIntent | null;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const latest = useRef({ cwd, disabled, begin });
  latest.current = { cwd, disabled, begin };
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="btn btn-ghost"
        aria-label={S.title}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => {
          if (latest.current.disabled) return;
          const intent = latest.current.begin();
          if (intent)
            worktreeManagement.open({
              cwd: latest.current.cwd,
              target: intent,
              returnFocusRef: trigger,
            });
        }}
      >
        {S.title}
      </button>
    </>
  );
}
