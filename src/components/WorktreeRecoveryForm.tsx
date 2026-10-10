import { useEffect, useRef, useState } from "react";
import { chooseDirectory } from "../runtime/dialogs";
import { worktrees } from "../runtime/worktrees";
import type { WorktreeRecovery } from "../runtime/worktree_types";
import {
  WORKTREE_STRINGS as S,
  worktreeFailureMessage,
} from "../runtime/worktree_strings";
export function WorktreeRecoveryForm({
  recovery,
  current,
  onClose,
}: {
  recovery: WorktreeRecovery;
  current: () => boolean;
  onClose: () => void;
}) {
  const [parent, setParent] = useState(""),
    [directory, setDirectory] = useState(""),
    [busy, setBusy] = useState(false),
    [submitted, setSubmitted] = useState(false),
    [error, setError] = useState<string | null>(null);
  const live = useRef(false),
    working = useRef(false),
    state = useRef({ recovery, current, parent, directory, submitted });
  state.current = { recovery, current, parent, directory, submitted };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const owns = () => {
    if (
      !live.current ||
      state.current.recovery !== recovery ||
      !state.current.current()
    )
      return false;
    return live.current && state.current.recovery === recovery;
  };
  const valid =
    Boolean(parent) &&
    Boolean(directory.trim()) &&
    !/[\\/\0]/.test(directory) &&
    ![".", ".."].includes(directory);
  const choose = async () => {
    if (!owns() || working.current || state.current.submitted) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      const path = await chooseDirectory(parent || undefined);
      if (path && owns()) setParent(path);
    } catch (e) {
      if (owns()) setError(worktreeFailureMessage(e));
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  };
  const restore = async () => {
    if (
      !owns() ||
      working.current ||
      state.current.submitted ||
      !valid ||
      state.current.parent !== parent ||
      state.current.directory !== directory
    )
      return;
    working.current = true;
    state.current.submitted = true;
    setSubmitted(true);
    setBusy(true);
    setError(null);
    try {
      await worktrees.recover(recovery, parent, directory, owns);
    } catch (e) {
      if (owns()) setError(worktreeFailureMessage(e));
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  };
  return (
    <section
      className="worktree-operation worktree-create"
      aria-label={S.recovery.title}
    >
      <h3>{S.recovery.title}</h3>
      <p>{S.recovery.note}</p>
      <p>{S.recovery.independent}</p>
      <p className="worktree-path">{recovery.path}</p>
      <label>
        {S.parent}
        <button
          type="button"
          className="btn btn-ghost worktree-path"
          disabled={busy || submitted}
          onClick={() => void choose()}
        >
          {parent || S.selectParent}
        </button>
      </label>
      <label>
        {S.directory}
        <input
          value={directory}
          maxLength={255}
          disabled={busy || submitted}
          onChange={(e) => {
            if (owns() && !working.current && !state.current.submitted)
              setDirectory(e.currentTarget.value);
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {submitted && <p role="status">{S.recovery.requested}</p>}
      <div className="worktree-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!valid || busy || submitted}
          onClick={() => void restore()}
        >
          {S.recovery.confirm}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            if (live.current && state.current.recovery === recovery) {
              live.current = false;
              onClose();
            }
          }}
        >
          {S.close}
        </button>
      </div>
    </section>
  );
}
