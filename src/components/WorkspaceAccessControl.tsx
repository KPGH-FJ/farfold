import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { FolderSimpleIcon } from "@phosphor-icons/react";
import { threads, type ThreadState } from "../runtime/sessions";
import { WorkspaceAccessStatusController } from "../runtime/workspace_access_status";
import { WorkspaceAccessDecisionController } from "../runtime/workspace_access_decision";
import { WORKSPACE_ACCESS as S } from "../runtime/workspace_access_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorkspaceAccessDecisionReview } from "./WorkspaceAccessDecisionReview";

/** The same explicit read control for a prepared draft or an existing conversation. */
export function WorkspaceAccessControl({
  thread,
  active,
}: {
  thread: ThreadState | null;
  active: boolean;
}) {
  const latest = useRef({ thread, active });
  latest.current = { thread, active };
  const mounted = useRef(true);
  const anchor = useRef<HTMLButtonElement>(null);
  const control = useMemo(
    () =>
      new WorkspaceAccessStatusController(thread, () => {
        const target = latest.current.thread;
        return mounted.current &&
          latest.current.active &&
          target &&
          threads.thread(target.key) === target
          ? target
          : undefined;
      }),
    [
      thread,
      thread?.agentId,
      thread?.cwd,
      thread?.nativeSessionId,
      thread?.connectionId,
      thread?.serviceContext,
      thread?.service?.id,
      thread?.service?.fingerprint,
      active,
    ],
  );
  const decisions = useMemo(
    () =>
      new WorkspaceAccessDecisionController(
        thread,
        control,
        (decision, scope) =>
          threads.decideWorkspaceAccess(thread!.key, decision, scope),
      ),
    [control, thread],
  );
  // Retire before the modal's passive focus-return cleanup can run.
  useLayoutEffect(() => {
    mounted.current = true;
    control.activate();
    decisions.activate();
    return () => {
      mounted.current = false;
      control.dispose();
      decisions.dispose();
    };
  }, [control, decisions]);
  const snapshot = useSyncExternalStore(
    control.subscribe,
    control.getSnapshot,
    control.getSnapshot,
  );
  const decisionSnapshot = useSyncExternalStore(
    decisions.subscribe,
    decisions.getSnapshot,
    decisions.getSnapshot,
  );
  if (!active || !control.isCurrent()) return null;
  const blocked = control.blockedReason;
  const reviewing =
    decisionSnapshot.phase === "review" ||
    decisionSnapshot.phase === "submitting";
  const submitting = decisionSnapshot.phase === "submitting";
  const result =
    decisionSnapshot.phase === "reported"
      ? decisionSnapshot.result
      : decisionSnapshot.phase === "idle" && snapshot.phase === "ready"
        ? snapshot.result
        : null;
  const dismiss = () => {
    decisions.dismiss();
    control.dismiss();
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="new-choice-trigger"
        title={blocked ?? S.entry}
        aria-label={S.entry}
        aria-haspopup="dialog"
        aria-expanded={snapshot.phase !== "idle"}
        disabled={Boolean(blocked) || snapshot.phase === "loading"}
        onClick={() => void control.read()}
      >
        <FolderSimpleIcon size={16} aria-hidden="true" />
        <span>{S.title}</span>
      </button>
      {snapshot.phase !== "idle" && (
        <WorkspaceDialog
          title={reviewing ? S.reviewTitle : S.title}
          onClose={dismiss}
          returnFocusRef={anchor}
          returnFocusWhen={control.isCurrent}
          busy={submitting}
        >
          {reviewing ? (
            <WorkspaceAccessDecisionReview
              snapshot={decisionSnapshot}
              blocked={decisions.blocked}
              onBack={() => decisions.dismiss()}
              onConfirm={() => void decisions.confirm()}
            />
          ) : (
            <div className="workspace-dialog-body">
              {decisionSnapshot.phase !== "error" && (
                <p>
                  {decisionSnapshot.phase === "reported"
                    ? S.decisionReported
                    : decisions.choices.length
                      ? S.readWithActions
                      : S.readOnly}
                </p>
              )}
              <label>
                {S.folder}
                <code style={{ overflowWrap: "anywhere" }}>{thread?.cwd}</code>
              </label>
              {snapshot.phase === "loading" && <p role="status">{S.reading}</p>}
              {snapshot.phase === "error" && (
                <p role="alert">{S.errors[snapshot.code]}</p>
              )}
              {decisionSnapshot.phase === "error" && (
                <p role="alert">
                  {decisionSnapshot.error.effect === "unconfirmed"
                    ? S.decisionUnconfirmed
                    : S.decisionErrors[decisionSnapshot.error.code]}
                </p>
              )}
              {result && (
                <>
                  <strong role="status">{S.statuses[result.status]}</strong>
                  <p>{S.reported}</p>
                  {result.status === "session" && <p>{S.temporaryScope}</p>}
                  {result.details ? (
                    result.details.repoScopeVerified &&
                    result.details.repoRoot ? (
                      <label>
                        {S.repository}
                        <code style={{ overflowWrap: "anywhere" }}>
                          {result.details.repoRoot}
                        </code>
                      </label>
                    ) : (
                      <p>{S.noRepository}</p>
                    )
                  ) : (
                    <p>{S.noDetails}</p>
                  )}
                </>
              )}
              {decisionSnapshot.phase === "idle" &&
                decisions.choices.length > 0 && (
                  <section>
                    <strong>{S.actions}</strong>
                    <p>{S.actionHint}</p>
                    {decisions.choices.map((decision) => (
                      <button
                        key={decision}
                        type="button"
                        className="btn btn-ghost"
                        disabled={decisions.blocked}
                        onClick={() => decisions.review(decision)}
                      >
                        {S.decisions[decision]}
                      </button>
                    ))}
                  </section>
                )}
            </div>
          )}
          <footer>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={submitting}
              onClick={dismiss}
            >
              {S.close}
            </button>
          </footer>
        </WorkspaceDialog>
      )}
    </>
  );
}
