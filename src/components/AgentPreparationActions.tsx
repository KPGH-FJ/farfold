import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getAgentPreparation,
  type PreparationAction,
} from "../runtime/preparation";
import { PREPARATION_ACTION_STRINGS as S } from "../runtime/preparation_action_strings";
import { uiError } from "../runtime/ui_error";
import { useWorkPolicy } from "../runtime/work_policy";
import {
  useAccessPrimary,
  type AgentAccessPrimary,
} from "../runtime/access_primary";

/** Reviewed commands come only from the backend's current preparation actions. */
export function AgentPreparationActions({
  agentId,
  cwd,
  source,
  program,
  disabled,
  onRun,
  data,
  selectedId,
  reviewSelected = false,
  hideChoices = false,
  onPrimaryChange,
  onCancelReview,
}: {
  agentId: string;
  cwd: string | null;
  source?: string;
  program?: string;
  disabled: boolean;
  onRun: (action: PreparationAction, cwd: string) => void;
  data?: {
    actions: PreparationAction[];
    error: string | null;
    onRetry: () => void;
  };
  selectedId?: string | null;
  reviewSelected?: boolean;
  hideChoices?: boolean;
  onPrimaryChange?: (action: AgentAccessPrimary | null) => void;
  onCancelReview?: () => void;
}) {
  const location = useWorkPolicy(cwd);
  const targetCwd = location.ready ? location.cwd : undefined;
  const [actions, setActions] = useState<PreparationAction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [review, setReview] = useState<{
    action: PreparationAction;
    cwd: string;
    program?: string;
  } | null>(null);
  useEffect(() => {
    if (data) return;
    let current = true;
    setActions([]);
    setReview(null);
    setError(null);
    void getAgentPreparation(agentId)
      .then((value) => {
        if (current) setActions(value.actions ?? []);
      })
      .catch((reason) => {
        if (current) setError(uiError(reason, S.loadFailed));
      });
    return () => {
      current = false;
    };
  }, [agentId, program, revision, !!data]);
  useEffect(() => setReview(null), [cwd, source, targetCwd]);
  const currentActions = data?.actions ?? actions;
  const currentError = data?.error ?? error;
  useEffect(() => {
    if (!reviewSelected || !selectedId || !targetCwd) {
      if (hideChoices) setReview(null);
      return;
    }
    const action = currentActions.find((item) => item.id === selectedId);
    setReview(
      action
        ? {
            action: { ...action, args: [...action.args] },
            cwd: targetCwd,
            program,
          }
        : null,
    );
  }, [
    reviewSelected,
    selectedId,
    currentActions,
    targetCwd,
    program,
    hideChoices,
  ]);
  const blocked = disabled || !!source || !targetCwd || !!currentError;
  const runReviewed = () => {
    if (
      blocked ||
      !review ||
      review.cwd !== targetCwd ||
      review.program !== program
    )
      return;
    const current = currentActions.find(
      (action) => action.id === review.action.id,
    );
    if (!current || JSON.stringify(current) !== JSON.stringify(review.action))
      return;
    onRun(review.action, review.cwd);
    setReview(null);
  };
  useAccessPrimary(
    review
      ? {
          id: JSON.stringify([agentId, review.cwd, program, review.action]),
          label: S.run,
          disabled: blocked,
          run: runReviewed,
        }
      : null,
    onPrimaryChange,
  );
  return (
    <>
      {currentError && (
        <div className="auth-note" role="alert">
          {currentError}{" "}
          <button
            className="btn btn-text"
            onClick={() =>
              data ? data.onRetry() : setRevision((value) => value + 1)
            }
          >
            {S.retry}
          </button>
        </div>
      )}
      {!hideChoices &&
        currentActions.map((action) => (
          <div className="agent-account-action" key={action.id}>
            <div>
              <div className="auth-name">{S.title}</div>
              <div className="auth-desc">{S.hint}</div>
            </div>
            <button
              className="btn btn-ghost"
              disabled={blocked}
              onClick={() => {
                if (!blocked && targetCwd)
                  setReview({
                    action: { ...action, args: [...action.args] },
                    cwd: targetCwd,
                    program,
                  });
              }}
            >
              {S.review}
            </button>
          </div>
        ))}
      {!!currentActions.length && !source && !targetCwd && (
        <p className="auth-note" role="status">
          {location.error ?? S.locationPending}
          {location.error && (
            <button className="btn btn-text" onClick={location.retry}>
              {S.retryLocation}
            </button>
          )}
        </p>
      )}
      {review && (
        <section className="agent-account-more" aria-label={S.title}>
          <p>{S.effects}</p>
          <details className="journey-details">
            <summary>{S.details}</summary>
            <p className="auth-note">{S.environment}</p>
            <p>
              {S.location}：{review.cwd}
            </p>
            <p>{S.command}</p>
            <pre className="agent-preparation-command">
              {JSON.stringify([review.action.command, ...review.action.args])}
            </pre>
            <button
              className="btn btn-text"
              onClick={() =>
                void openUrl(review.action.sourceUrl).catch((reason) =>
                  setError(uiError(reason, S.loadFailed)),
                )
              }
            >
              {S.source}
            </button>
          </details>
          <div className="auth-actions">
            {!onPrimaryChange && (
              <button
                className="btn btn-primary"
                disabled={blocked}
                onClick={runReviewed}
              >
                {S.run}
              </button>
            )}
            {!hideChoices && (
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setReview(null);
                  onCancelReview?.();
                }}
              >
                {S.cancelReview}
              </button>
            )}
          </div>
        </section>
      )}
    </>
  );
}
