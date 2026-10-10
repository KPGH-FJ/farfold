import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { worktrees } from "../runtime/worktrees";
import type {
  WorktreeArchive,
  WorktreeRemoveInspection,
  WorktreeReply,
} from "../runtime/worktree_types";
import {
  WORKTREE_STRINGS as S,
  worktreeBlockerReasons,
  worktreeFailureMessage,
} from "../runtime/worktree_strings";
const M = S.removal;
/** Each mount owns the two explicit decisions; status can advance, never create, permission. */
export function WorktreeRemovalReview({
  archive,
  current,
  onClose,
}: {
  archive: WorktreeArchive;
  current: () => boolean;
  onClose: () => void;
}) {
  const state = useSyncExternalStore(
    worktrees.subscribe,
    worktrees.snapshot,
    worktrees.snapshot,
  );
  const owner = useRef({}).current,
    live = useRef(false),
    working = useRef(false);
  const [inspection, setInspection] = useState<WorktreeRemoveInspection | null>(
      null,
    ),
    [reading, setReading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [firstAck, setFirstAck] = useState(false),
    [ack, setAck] = useState<WorktreeReply | null>(null),
    [submitted, setSubmitted] = useState(false),
    [busy, setBusy] = useState(false),
    [attempt, setAttempt] = useState(0);
  const latest = useRef({
    archive,
    current,
    inspection,
    firstAck,
    ack,
    op: state.operation,
    submitted,
  });
  latest.current = {
    archive,
    current,
    inspection,
    firstAck,
    ack,
    op: state.operation,
    submitted,
  };
  const owns = () => {
    if (
      !live.current ||
      latest.current.archive !== archive ||
      !latest.current.current()
    )
      return false;
    return live.current && latest.current.archive === archive;
  };
  useEffect(() => {
    live.current = true;
    let disposed = false;
    setReading(true);
    setInspection(null);
    setError(null);
    setFirstAck(false);
    setAck(null);
    latest.current.inspection = null;
    latest.current.firstAck = false;
    latest.current.ack = null;
    void Promise.resolve()
      .then(() =>
        disposed || !owns() ? null : worktrees.inspectRemoval(archive),
      )
      .then((value) => {
        if (value && !disposed && owns()) setInspection(value);
      })
      .catch((reason) => {
        if (!disposed && owns()) setError(worktreeFailureMessage(reason));
      })
      .finally(() => {
        if (!disposed) setReading(false);
      });
    return () => {
      disposed = true;
      live.current = false;
      worktrees.withdrawRemoval(owner);
    };
  }, [archive, attempt, owner]);
  const prepare = async () => {
    const view = inspection;
    if (
      !owns() ||
      working.current ||
      latest.current.submitted ||
      !view ||
      latest.current.inspection !== view ||
      !latest.current.firstAck ||
      view.blockers.length ||
      view.impact.unsent
    )
      return;
    working.current = true;
    latest.current.submitted = true;
    setSubmitted(true);
    setBusy(true);
    setError(null);
    try {
      await worktrees.prepareRemoval(view, owner, owns);
    } catch (reason) {
      if (owns()) setError(worktreeFailureMessage(reason));
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  };
  const op = state.operation;
  const canConfirm =
    !!op && submitted && worktrees.canConfirmRemoval(owner, op);
  const confirm = async () => {
    const shown = op;
    if (
      !owns() ||
      working.current ||
      !shown ||
      latest.current.op !== shown ||
      latest.current.ack !== shown ||
      !worktrees.canConfirmRemoval(owner, shown)
    )
      return;
    // Consume this checkbox before any observable callback or IPC. It never transfers to a new receipt.
    latest.current.ack = null;
    setAck(null);
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await worktrees.confirmRemoval(owner, shown);
    } catch (reason) {
      if (owns()) setError(worktreeFailureMessage(reason));
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  };
  const recovery =
    op?.kind === "operation" && op.action === "remove"
      ? op.recovery
      : undefined;
  return (
    <section
      className="worktree-operation worktree-removal"
      aria-label={M.title}
    >
      <h3>{M.title}</h3>
      {error && <p role="alert">{error}</p>}
      {!submitted ? (
        <>
          <h4>{M.firstStep}</h4>
          <p>{M.prepareNote}</p>
          {reading && <p role="status">{S.loading}</p>}
          {inspection && (
            <>
              <dl className="worktree-paths">
                <dt>{S.recycleOriginal}</dt>
                <dd>{inspection.originalPath}</dd>
                <dt>{S.recycleRetained}</dt>
                <dd>{inspection.retainedPath}</dd>
              </dl>
              <p>{S.relatedConversations(inspection.impact.conversations)}</p>
              <p>{M.localNote}</p>
              <details>
                <summary>{S.details}</summary>
                <p>{M.roots(inspection.roots.count)}</p>
                <p>
                  {S.materialSummary(
                    inspection.content.entries,
                    inspection.content.bytes,
                  )}
                </p>
                <p>{S.externalNote}</p>
              </details>
              {inspection.blockers.length || inspection.impact.unsent ? (
                <div role="status">
                  <p>{S.recycleBlocked}</p>
                  <ul>
                    {worktreeBlockerReasons(
                      inspection.blockers,
                      inspection.impact.unsent,
                    ).map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <label className="worktree-confirm">
                  <input
                    type="checkbox"
                    checked={firstAck}
                    disabled={busy}
                    onChange={(e) => {
                      if (
                        owns() &&
                        !working.current &&
                        !latest.current.submitted
                      ) {
                        latest.current.firstAck = e.currentTarget.checked;
                        setFirstAck(e.currentTarget.checked);
                      }
                    }}
                  />
                  {S.externalStopped}
                </label>
              )}
            </>
          )}
          <div className="worktree-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                busy ||
                reading ||
                !inspection ||
                !firstAck ||
                !!inspection.blockers.length ||
                inspection.impact.unsent
              }
              onClick={() => void prepare()}
            >
              {M.prepare}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || reading}
              onClick={() => {
                if (owns() && !working.current && !latest.current.submitted)
                  setAttempt((n) => n + 1);
              }}
            >
              {S.recycleRetry}
            </button>
          </div>
        </>
      ) : (
        <>
          <h4>{M.secondStep}</h4>
          {recovery && (
            <>
              <p>{canConfirm ? M.prepared : M.recoveryNote}</p>
              <dl className="worktree-paths">
                <dt>{S.recycleRetained}</dt>
                <dd>{recovery.retainedPath}</dd>
                <dt>{M.path}</dt>
                <dd>{recovery.path}</dd>
                <dt>{S.branch}</dt>
                <dd>{recovery.branch ?? S.currentCommit}</dd>
              </dl>
              <p>{M.summary(recovery.bundleBytes)}</p>
              <p>{M.confirmNote}</p>
              <p>{M.branchNote}</p>
              <details>
                <summary>{M.hashes}</summary>
                <dl className="worktree-paths">
                  <dt>{M.bundleHash}</dt>
                  <dd>{recovery.bundleSha256}</dd>
                  <dt>{M.manifestHash}</dt>
                  <dd>{recovery.manifestSha256}</dd>
                  <dt>{M.rootsHash}</dt>
                  <dd>{recovery.rootsSha256}</dd>
                </dl>
              </details>
            </>
          )}
          {!canConfirm && (
            <p role="status">
              {op?.kind === "operation" && op.action === "remove"
                ? op.state === "unknown"
                  ? M.unknown
                  : op.state === "ready"
                    ? M.ready
                    : op.state === "failed"
                      ? M.failed
                      : op.state === "cancelled"
                        ? M.cancelled
                        : op.state === "prepared"
                          ? M.revoked
                          : M.phases[op.removalPhase]
                : M.unknown}
            </p>
          )}
          {canConfirm && (
            <div
              key="separate-deletion-confirmation"
              className="worktree-delete-confirmation"
            >
              <label className="worktree-confirm">
                <input
                  type="checkbox"
                  checked={ack === op}
                  disabled={busy}
                  onChange={(e) => {
                    if (
                      owns() &&
                      !working.current &&
                      latest.current.op === op &&
                      worktrees.canConfirmRemoval(owner, op!)
                    ) {
                      latest.current.ack = e.currentTarget.checked ? op : null;
                      setAck(latest.current.ack);
                    }
                  }}
                />
                {M.confirmAck}
              </label>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy || ack !== op}
                onClick={() => void confirm()}
              >
                {M.confirm}
              </button>
            </div>
          )}
        </>
      )}
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          if (live.current && latest.current.archive === archive) {
            live.current = false;
            worktrees.withdrawRemoval(owner);
            if (latest.current.archive === archive) onClose();
          }
        }}
      >
        {S.recycleCancel}
      </button>
    </section>
  );
}
