import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getAgentPreparation,
  type PreparationAction,
} from "../runtime/preparation";
import { PREPARATION_ACTION_STRINGS as S } from "../runtime/preparation_action_strings";
import { uiError } from "../runtime/ui_error";

/** Reviewed commands come only from the backend's current preparation actions. */
export function AgentPreparationActions({
  agentId,
  cwd,
  source,
  program,
  disabled,
  onRun,
}: {
  agentId: string;
  cwd: string | null;
  source?: string;
  program?: string;
  disabled: boolean;
  onRun: (action: PreparationAction) => void;
}) {
  const [actions, setActions] = useState<PreparationAction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [review, setReview] = useState<{
    action: PreparationAction;
    cwd: string;
    program?: string;
  } | null>(null);
  useEffect(() => {
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
  }, [agentId, program, revision]);
  useEffect(() => setReview(null), [cwd, source]);
  const blocked = disabled || !!source || !cwd;
  return (
    <>
      {error && (
        <div className="auth-note" role="alert">
          {error}{" "}
          <button
            className="btn btn-text"
            onClick={() => setRevision((value) => value + 1)}
          >
            {S.retry}
          </button>
        </div>
      )}
      {actions.map((action) => (
        <div className="agent-account-action" key={action.id}>
          <div>
            <div className="auth-name">{S.title}</div>
            <div className="auth-desc">{S.hint}</div>
          </div>
          <button
            className="btn btn-ghost"
            disabled={blocked}
            onClick={() => {
              if (!blocked && cwd)
                setReview({
                  action: { ...action, args: [...action.args] },
                  cwd,
                  program,
                });
            }}
          >
            {S.review}
          </button>
        </div>
      ))}
      {review && (
        <section className="agent-account-more" aria-label={S.title}>
          <p>{S.effects}</p>
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
          <div className="auth-actions">
            <button
              className="btn btn-primary"
              disabled={blocked}
              onClick={() => {
                if (blocked || review.cwd !== cwd || review.program !== program)
                  return;
                onRun(review.action);
                setReview(null);
              }}
            >
              {S.run}
            </button>
            <button className="btn btn-text" onClick={() => setReview(null)}>
              {S.cancelReview}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
