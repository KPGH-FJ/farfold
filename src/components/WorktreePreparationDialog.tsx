import { useEffect, useRef, useState, type RefObject } from "react";
import { worktrees } from "../runtime/worktrees";
import { worktreeFailureMessage } from "../runtime/worktree_strings";
import {
  inspectWorktreePreparation,
  validateWorktreePreparation,
} from "../runtime/worktree_preparation";
import {
  preparationRequestText,
  validPreparationRequest,
  type PreparationRequest,
} from "../runtime/worktree_preparation_request";
import { type PreparationInspection } from "../runtime/worktree_preparation_types";
import {
  WORKTREE_PREPARATION_STRINGS as S,
  preparationFailureMessage,
} from "../runtime/worktree_preparation_strings";
import type {
  PreparationAppendResult,
  PreparationDraftTarget,
} from "../runtime/draft_preparation";
import { WorkspaceDialog } from "./WorkspaceDialog";
import "./WorktreePreparationDialog.css";

type Review = Readonly<{
  text: string;
  inspection: PreparationInspection | null;
}>;
export function WorktreePreparationDialog({
  target,
  onClose,
  returnFocusRef,
}: {
  target: PreparationDraftTarget;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [request, setRequest] = useState<PreparationRequest>({
    task: "",
    projectRelativePath: "",
    service: false,
    port: "",
  });
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    PreparationAppendResult | "save-stale" | null
  >(null);
  const live = useRef(true);
  const working = useRef(false);
  const current = useRef({ target, request, review });
  current.current = { target, request, review };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      queueMicrotask(() => {
        if (!live.current) target.retire();
      });
    };
  }, [target]);
  const owns = () => live.current && current.current.target === target;
  const close = () => {
    live.current = false;
    target.retire();
    onClose();
  };
  const change = (next: PreparationRequest) => {
    if (working.current || result) return;
    setRequest(next);
    setReview(null);
    setError(null);
  };
  const preview = async (inspect: boolean) => {
    if (working.current || !owns() || !target.isCurrent()) {
      if (owns()) setError(S.stale);
      return;
    }
    const requested = current.current.request;
    if (!validPreparationRequest(requested)) {
      setError(S.invalid);
      return;
    }
    working.current = true;
    setBusy(true);
    setError(null);
    setReview(null);
    try {
      let inspection: PreparationInspection | null = null;
      if (inspect) {
        await worktrees.load();
        if (!owns() || !target.isCurrent()) return;
        const state = worktrees.snapshot();
        if (!state.ready || state.loading || state.error)
          throw { code: "unavailable" };
        const matches = state.locations.filter(
          (location) => location.path === target.cwd,
        );
        if (
          matches.length !== 1 ||
          state.archives.some((archive) => archive.originalPath === target.cwd)
        ) {
          setError(S.notRegistered);
          return;
        }
        const location = await worktrees.check(matches[0]).catch((reason) => {
          if (owns()) setError(worktreeFailureMessage(reason));
          return null;
        });
        if (!location) return;
        if (!owns() || !target.isCurrent()) return;
        inspection = await inspectWorktreePreparation(
          location,
          requested.projectRelativePath,
        );
      }
      if (
        !owns() ||
        !target.isCurrent() ||
        current.current.request !== requested
      )
        return;
      setReview({
        inspection,
        text: preparationRequestText(target.cwd, requested, inspection),
      });
    } catch (reason) {
      if (owns()) setError(preparationFailureMessage(reason));
    } finally {
      working.current = false;
      if (owns()) setBusy(false);
    }
  };
  const add = async () => {
    const shown = current.current.review;
    if (working.current || !shown || !owns() || !target.isCurrent()) {
      if (owns()) setError(S.stale);
      return;
    }
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      const outcome = await target.appendOnce(shown.text, async () => {
        if (!owns() || current.current.review !== shown)
          throw new Error(S.stale);
        if (shown.inspection)
          await validateWorktreePreparation(shown.inspection);
        if (!owns() || current.current.review !== shown)
          throw new Error(S.stale);
      });
      if (owns()) setResult(outcome);
    } catch (reason) {
      if (owns())
        setError(
          reason instanceof Error &&
            (reason.message === S.saveBeforeFailed ||
              reason.message === S.stale)
            ? reason.message
            : preparationFailureMessage(reason),
        );
    } finally {
      working.current = false;
      if (owns()) setBusy(false);
    }
  };
  const save = async () => {
    if (working.current || !owns()) return;
    working.current = true;
    setBusy(true);
    const saved = await target.retrySave();
    working.current = false;
    if (owns()) {
      setBusy(false);
      if (saved === "saved") setResult("added-saved");
      else if (saved === "stale") setResult("save-stale");
    }
  };
  const valid = target.isCurrent();
  return (
    <WorkspaceDialog
      title={S.title}
      onClose={close}
      returnFocusRef={returnFocusRef}
    >
      <div
        className="worktree-preparation workspace-dialog-body"
        aria-busy={busy || undefined}
      >
        <p className="worktree-preparation-path">
          <strong>{S.path}</strong>
          <br />
          {target.cwd}
        </p>
        <p>{S.readBoundary}</p>
        <label>
          {S.relativePath}
          <input
            value={request.projectRelativePath}
            maxLength={1024}
            disabled={busy || !!result || !valid}
            onChange={(event) =>
              change({ ...request, projectRelativePath: event.target.value })
            }
          />
        </label>
        <label>
          {S.task}
          <textarea
            value={request.task}
            maxLength={4000}
            placeholder={S.taskPlaceholder}
            disabled={busy || !!result || !valid}
            onChange={(event) =>
              change({ ...request, task: event.target.value })
            }
          />
        </label>
        <label className="worktree-preparation-check">
          <input
            type="checkbox"
            checked={request.service}
            disabled={busy || !!result || !valid}
            onChange={(event) =>
              change({ ...request, service: event.target.checked, port: "" })
            }
          />
          {S.service}
        </label>
        {request.service && (
          <label>
            {S.port}
            <input
              inputMode="numeric"
              value={request.port}
              maxLength={5}
              disabled={busy || !!result || !valid}
              onChange={(event) =>
                change({ ...request, port: event.target.value })
              }
            />
            <span>{S.portNote}</span>
          </label>
        )}
        {!result && (
          <div className="worktree-preparation-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !valid || !validPreparationRequest(request)}
              onClick={() => void preview(true)}
            >
              {S.inspect}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || !valid || !validPreparationRequest(request)}
              onClick={() => void preview(false)}
            >
              {S.manual}
            </button>
          </div>
        )}
        {busy && (
          <p role="status">
            {result === "added-unsaved"
              ? S.saving
              : review
                ? S.validating
                : S.checking}
          </p>
        )}
        {!valid && !result && <p role="status">{S.stale}</p>}
        {error && <p role="alert">{error}</p>}
        {review && (
          <>
            {review.inspection && (
              <details>
                <summary>{S.facts}</summary>
                <p>
                  {review.inspection.git.kind === "main"
                    ? S.gitMain
                    : S.gitLinked}{" "}
                  {S.otherTrees(review.inspection.git.otherWorktreeCount)}
                </p>
                <ul>
                  {review.inspection.facts.map((fact) => (
                    <li key={fact.name}>
                      {fact.name} — {S.kinds[fact.nodeKind]}
                    </li>
                  ))}
                </ul>
                <p>
                  {review.inspection.coverage.complete
                    ? S.complete
                    : S.incomplete}
                </p>
              </details>
            )}
            <label>
              {S.review}
              <textarea
                className="worktree-preparation-request"
                readOnly
                value={review.text}
              />
            </label>
            <p>{S.reviewNote}</p>
          </>
        )}
        <p>{S.isolation}</p>
        {result && (
          <p role="status">
            {result === "added-saved"
              ? S.added
              : result === "added-unsaved"
                ? S.unsaved
                : result === "save-stale"
                  ? S.saveStale
                  : S.stale}
          </p>
        )}
      </div>
      <footer>
        <button type="button" className="btn btn-ghost" onClick={close}>
          {S.close}
        </button>
        {result === "added-unsaved" ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {S.retrySave}
          </button>
        ) : (
          !result && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !review || !valid}
              onClick={() => void add()}
            >
              {S.add}
            </button>
          )
        )}
      </footer>
    </WorkspaceDialog>
  );
}
