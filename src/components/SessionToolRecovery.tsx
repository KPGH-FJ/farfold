import { useMemo, useSyncExternalStore } from "react";
import { threads, type ThreadState } from "../runtime/sessions";
import { SessionToolRecoveryController } from "../runtime/session_tool_recovery_controller";
import { TOOL_RECOVERY as S } from "../runtime/session_tool_recovery_strings";

const controllers = new WeakMap<ThreadState, SessionToolRecoveryController>();
export function sessionToolRecoveryController(thread: ThreadState) {
  let controller = controllers.get(thread);
  if (!controller || !controller.isCurrent()) {
    controller = new SessionToolRecoveryController(
      thread,
      () => threads.thread(thread.key),
      (operationId) => threads.toolChanges.resolveRecovery(thread, operationId),
    );
    controllers.set(thread, controller);
  }
  return controller;
}

/** Available on the failed-open surface as well as inside current tools. */
export function SessionToolRecovery({
  thread,
  active = true,
}: {
  thread: ThreadState;
  active?: boolean;
}) {
  const controller = useMemo(
    () => sessionToolRecoveryController(thread),
    [thread],
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  if (!thread.sessionToolRecoveryRequired && view.phase !== "resolved")
    return null;
  const busy = view.phase === "inspecting" || view.phase === "confirming";
  const current = active && controller.isCurrent();
  const message = view.error
    ? S[view.error]
    : view.phase === "resolved"
      ? S.resolved
      : busy
        ? view.phase === "confirming"
          ? S.confirming
          : S.checking
        : view.inspection
          ? S.outcomes[view.inspection.outcome]
          : S.hint;
  return (
    <section className="session-tools-report" aria-label={S.title}>
      <h3>{S.title}</h3>
      <p role="status" aria-live="polite" aria-atomic="true">
        {message}
      </p>
      {view.phase !== "resolved" && (
        <div className="b-act">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!current}
            aria-disabled={
              !current ||
              controller.blocked ||
              view.confirmationUnresolved ||
              undefined
            }
            onClick={() => {
              if (active) controller.inspect();
            }}
          >
            {view.phase === "inspecting" ? S.checking : S.inspect}
          </button>
          {view.inspection?.canConfirm && (
            <button
              type="button"
              className="btn"
              disabled={!current}
              aria-disabled={
                !current ||
                controller.blocked ||
                (view.phase !== "review" && !view.confirmationUnresolved) ||
                undefined
              }
              onClick={() => {
                if (active) controller.confirm();
              }}
            >
              {view.phase === "confirming"
                ? S.confirming
                : view.confirmationUnresolved
                  ? S.checkConfirmation
                  : S.confirm}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
