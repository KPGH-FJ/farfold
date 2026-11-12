import { useEffect, useRef, useState, type RefObject } from "react";
import type { SessionForkControl } from "../runtime/session_fork_control";
import { SESSION_FORK_STRINGS as S } from "../runtime/session_fork_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";

export function SessionForkDialog({
  control,
  active,
  isCurrent,
  onClose,
  returnFocusRef,
}: {
  control: SessionForkControl;
  active: boolean;
  isCurrent: () => boolean;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const mounted = useRef(true);
  const latest = useRef({ control, active, isCurrent, onClose });
  latest.current = { control, active, isCurrent, onClose };
  const scope = useRef({ owner: control.owner, active });
  if (scope.current.owner !== control.owner || scope.current.active !== active)
    scope.current = { owner: control.owner, active };
  const captured = scope.current;
  const flight = useRef({ phase: control.phase, action: "" });
  const [, repaint] = useState(0);
  if (flight.current.phase !== control.phase)
    flight.current = { phase: control.phase, action: "" };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const owns = () =>
    mounted.current &&
    scope.current === captured &&
    latest.current.active &&
    latest.current.control.owner === captured.owner &&
    latest.current.isCurrent() &&
    latest.current.control.isCurrent();
  const dispatch = (
    action: "start" | "continue" | "openChild" | "prepareNew",
  ) => {
    if (!owns() || flight.current.action) return;
    const current = latest.current.control;
    if (
      current.blockedReason ||
      (action === "start" && current.phase !== "idle") ||
      (action === "continue" &&
        !["created-unavailable", "unknown"].includes(current.phase)) ||
      (action === "openChild" && !current.child?.threadKey) ||
      (action === "prepareNew" &&
        !["ready", "rejected"].includes(current.phase))
    )
      return;
    const run = current[action];
    if (!run) return;
    flight.current.action = action;
    repaint((value) => value + 1);
    run();
  };
  const close = () => {
    if (owns()) latest.current.onClose();
  };
  const status = {
    idle: control.historyPoint ? S.pointScope : S.scope,
    pending: S.pending,
    unknown: S.unknown,
    "created-unavailable": S.unavailable,
    ready: S.ready,
    rejected: S.rejected,
  }[control.phase];
  const disabled = Boolean(control.blockedReason || flight.current.action);
  const continuing =
    Boolean(control.child && control.continue) &&
    (control.phase === "created-unavailable" || control.phase === "unknown");
  return (
    <WorkspaceDialog
      title={control.historyPoint ? S.pointTitle : S.title}
      onClose={close}
      returnFocusRef={returnFocusRef}
    >
      <div className="workspace-dialog-body">
        <strong role="status">{status}</strong>
        {control.phase === "idle" && (
          <>
            {control.historyPoint?.preview && (
              <p aria-label={S.pointPreview}>{control.historyPoint.preview}</p>
            )}
            <p>{control.historyPoint ? S.pointFiles : S.files}</p>
          </>
        )}
        {(control.phase === "idle" || control.phase === "ready") && (
          <p>{S.permissions}</p>
        )}
        {control.phase === "pending" && <p>{S.background}</p>}
        {control.phase === "unknown" && <p>{S.noRetry}</p>}
        {control.child && (
          <>
            {control.child.title && <p>{control.child.title}</p>}
            <label>
              {S.child}
              <code style={{ overflowWrap: "anywhere" }}>
                {control.child.nativeSessionId}
              </code>
            </label>
            {control.phase !== "ready" && <p>{S.knownChild}</p>}
          </>
        )}
        {control.message && <p>{control.message}</p>}
        {control.blockedReason && <p role="alert">{control.blockedReason}</p>}
      </div>
      <footer>
        <button type="button" className="btn btn-ghost" onClick={close}>
          {control.phase === "idle" ? S.cancel : S.close}
        </button>
        {control.phase === "idle" && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabled}
            onClick={() => dispatch("start")}
          >
            {control.historyPoint ? S.pointConfirm : S.confirm}
          </button>
        )}
        {continuing && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabled}
            onClick={() => dispatch("continue")}
          >
            {S.continue}
          </button>
        )}
        {control.child?.threadKey && control.openChild && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabled || control.phase === "pending"}
            onClick={() => dispatch("openChild")}
          >
            {S.open}
          </button>
        )}
        {(control.phase === "ready" || control.phase === "rejected") &&
          control.prepareNew && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={disabled}
              onClick={() => dispatch("prepareNew")}
            >
              {S.prepareNew}
            </button>
          )}
      </footer>
    </WorkspaceDialog>
  );
}
