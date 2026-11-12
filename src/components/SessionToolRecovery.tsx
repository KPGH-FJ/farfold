import { useMemo, useSyncExternalStore } from "react";
import { threads, type ThreadState } from "../runtime/sessions";
import { SessionToolRecoveryController } from "../runtime/session_tool_recovery_controller";
import { TOOL_RECOVERY as S } from "../runtime/session_tool_recovery_strings";
import "./SessionToolsDialog.css";

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
  const accepting = view.inspection?.resolution === "acceptCurrent";
  const configuration = view.inspection?.configuration;
  return (
    <section
      className="session-tools-report session-tool-recovery"
      aria-label={S.title}
    >
      <div
        className="session-tool-recovery-content"
        tabIndex={configuration ? 0 : undefined}
        role={configuration ? "region" : undefined}
        aria-label={configuration ? S.currentConfiguration : undefined}
      >
        <h3>{S.title}</h3>
        <p role="status" aria-live="polite" aria-atomic="true">
          {view.phase === "resolved" && accepting ? S.acceptedCurrent : message}
        </p>
        {view.inspection?.outcome === "changed" && !configuration && (
          <p>{S.limitedReview}</p>
        )}
        {configuration && view.phase !== "resolved" && (
          <section aria-label={S.currentConfiguration}>
            <h4>{S.currentConfiguration}</h4>
            <p>{S.currentSettings}</p>
            {configuration.items.length === 0 && <p>{S.emptyConfiguration}</p>}
            <ul className="session-tools-items">
              {configuration.items.map((item, index) => (
                <li key={index}>
                  <strong>{item.name}</strong>
                  <p>{S.configurationKinds[item.kind]}</p>
                  {item.address && (
                    <p style={{ overflowWrap: "anywhere" }}>{item.address}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {view.phase !== "resolved" && (
        <div className="b-act session-tool-recovery-actions">
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
                  : accepting
                    ? S.acceptCurrent
                    : S.confirm}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
