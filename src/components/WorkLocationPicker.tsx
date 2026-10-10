import { useEffect, useRef, useState } from "react";
import { WORKTREE_STRINGS as S } from "../runtime/worktree_strings";
import { WorktreeDialog, type WorkLocationIntent } from "./WorktreeDialog";

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
  const [target, setTarget] = useState<WorkLocationIntent | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const latest = useRef({ disabled, begin });
  latest.current = { disabled, begin };
  useEffect(() => {
    if (disabled) setTarget(null);
  }, [disabled]);
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
          if (intent) setTarget(intent);
        }}
      >
        {S.title}
      </button>
      {target && !disabled && (
        <WorktreeDialog
          cwd={cwd}
          target={target}
          returnFocusRef={trigger}
          onClose={() =>
            setTarget((current) => (current === target ? null : current))
          }
        />
      )}
    </>
  );
}
