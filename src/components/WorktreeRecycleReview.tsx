import { useEffect, useRef, useState } from "react";
import { worktrees } from "../runtime/worktrees";
import type {
  WorktreeArchive,
  WorktreeLocation,
  WorktreeRecycleAction,
  WorktreeRecycleInspection,
} from "../runtime/worktree_types";
import {
  WORKTREE_STRINGS as S,
  worktreeErrorMessage,
  worktreeFailureMessage,
} from "../runtime/worktree_strings";

export type WorktreeRecycleSelection = Readonly<{
  action: WorktreeRecycleAction;
  record: WorktreeLocation | WorktreeArchive;
}>;
/** The checkbox acknowledges outside usage; it cannot bypass receipt blockers. */
export function WorktreeRecycleReview({
  selection,
  current,
  onClose,
}: {
  selection: WorktreeRecycleSelection;
  current: () => boolean;
  onClose: () => void;
}) {
  const [inspection, setInspection] =
    useState<WorktreeRecycleInspection | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const latest = useRef({ selection, current, inspection, ack });
  latest.current = { selection, current, inspection, ack };
  const live = useRef(false),
    working = useRef(false),
    readingNow = useRef(false);
  const owns = () =>
    live.current &&
    latest.current.selection === selection &&
    latest.current.current();
  useEffect(() => {
    live.current = true;
    let disposed = false;
    readingNow.current = true;
    latest.current.inspection = null;
    latest.current.ack = false;
    setReading(true);
    setInspection(null);
    setAck(false);
    setError(null);
    void Promise.resolve()
      .then(() =>
        disposed || !owns()
          ? null
          : worktrees.inspectRecycle(selection.action, selection.record),
      )
      .then((value) => {
        if (value && !disposed && owns()) setInspection(value);
      })
      .catch((reason) => {
        if (!disposed && owns()) setError(worktreeFailureMessage(reason));
      })
      .finally(() => {
        if (!disposed) {
          readingNow.current = false;
          setReading(false);
        }
      });
    return () => {
      disposed = true;
      live.current = false;
    };
  }, [selection, attempt]);
  const confirm = async () => {
    const shown = inspection;
    if (
      !owns() ||
      working.current ||
      readingNow.current ||
      !shown ||
      latest.current.inspection !== shown ||
      !latest.current.ack ||
      shown.blockers.length ||
      shown.impact.unsent
    )
      return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await worktrees.recycle(
        shown,
        () => owns() && latest.current.inspection === shown,
      );
      if (live.current && latest.current.selection === selection) onClose();
    } catch (reason) {
      if (owns()) setError(worktreeFailureMessage(reason));
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  };
  return (
    <section className="worktree-operation" aria-label={S.recycleReview}>
      <h3>{selection.action === "archive" ? S.archive : S.restore}</h3>
      <p>{selection.action === "archive" ? S.recycleNote : S.restoreNote}</p>
      {reading && <p role="status">{S.loading}</p>}
      {error && <p role="alert">{error}</p>}
      {inspection && (
        <>
          <dl className="worktree-paths">
            <dt>{S.recycleOriginal}</dt>
            <dd>{inspection.originalPath}</dd>
            <dt>{S.recycleRetained}</dt>
            <dd>{inspection.retainedPath}</dd>
          </dl>
          <p>{S.relatedConversations(inspection.impact.conversations)}</p>
          <details>
            <summary>{S.details}</summary>
            <p>
              {S.materialSummary(
                inspection.material.entries,
                inspection.material.bytes,
              )}
            </p>
            <p>{S.externalNote}</p>
          </details>
          {inspection.blockers.length > 0 || inspection.impact.unsent ? (
            <div role="status">
              <p>{S.recycleBlocked}</p>
              <ul>
                {inspection.blockers.map((code, i) => (
                  <li key={i}>{worktreeErrorMessage(code)}</li>
                ))}
                {inspection.impact.unsent && <li>{S.errors.unsentWork}</li>}
              </ul>
            </div>
          ) : (
            <label className="worktree-confirm">
              <input
                type="checkbox"
                checked={ack}
                disabled={busy}
                onChange={(event) => {
                  if (
                    owns() &&
                    !working.current &&
                    latest.current.inspection === inspection
                  )
                    setAck(event.currentTarget.checked);
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
            !ack ||
            !!inspection.blockers.length ||
            inspection.impact.unsent
          }
          onClick={() => void confirm()}
        >
          {selection.action === "archive" ? S.archive : S.restore}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy || reading}
          onClick={() => {
            if (
              owns() &&
              !working.current &&
              !readingNow.current &&
              latest.current.inspection === inspection
            ) {
              latest.current.inspection = null;
              latest.current.ack = false;
              setInspection(null);
              setAck(false);
              setAttempt((n) => n + 1);
            }
          }}
        >
          {S.recycleRetry}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            if (live.current && latest.current.selection === selection)
              onClose();
          }}
        >
          {S.recycleCancel}
        </button>
      </div>
    </section>
  );
}
