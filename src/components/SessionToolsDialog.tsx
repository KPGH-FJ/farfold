import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { threads, type ThreadState } from "../runtime/sessions";
import { getSessionToolsController } from "../runtime/session_tools_controller";
import type {
  SessionToolsReport,
  SessionToolStartupReport,
} from "../runtime/session_tools_types";
import { SESSION_TOOLS_STRINGS as S } from "../runtime/session_tools_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";
import "./SessionToolsDialog.css";

/** A returned catalogue is a report, never a connection or invocation receipt. */
export function SessionToolsReportView({
  report,
}: {
  report: SessionToolsReport;
}) {
  return (
    <section className="session-tools-report" aria-label={S.title}>
      <p>
        {S.count} {report.reportedItemCount} {S.countUnit}
      </p>
      <p className="session-tools-note">
        {S.received}：
        <time>{new Date(report.observedAtMs).toLocaleString()}</time>
      </p>
      <p className="session-tools-note">
        {S.incomplete} {S.limits}
      </p>
      {report.itemsTruncated && <p>{S.truncated}</p>}
      {report.items.length > 0 && (
        <ul className="session-tools-items">
          {report.items.map((item, index) => (
            <li key={index}>
              <strong>{item.name}</strong>
              {item.nameTruncated && <p>{S.nameTruncated}</p>}
              <p>
                {S.permission}：
                {item.permission === null
                  ? S.permissionUnknown
                  : S.permissions[item.permission]}
              </p>
              {item.description !== null && (
                <details>
                  <summary>{S.description}</summary>
                  <p className="session-tools-description">
                    {item.description}
                  </p>
                  {item.descriptionTruncated && <p>{S.descriptionTruncated}</p>}
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="session-tools-note">{S.permissionNotice}</p>
    </section>
  );
}

export function SessionToolStartupView({
  report,
}: {
  report: SessionToolStartupReport;
}) {
  const { reportedCount, loadedCount, failedCount, unknownCount } = report;
  return (
    <section aria-label={S.startup.title}>
      <h3>{S.startup.title}</h3>
      <p>
        {S.startup.reported} {reportedCount} 项结果
      </p>
      {reportedCount > 0 && (
        <p>
          {S.startup.loaded} {loadedCount} 项，{S.startup.failed} {failedCount}{" "}
          项，{S.startup.unknown} {unknownCount} 项。
        </p>
      )}
      {loadedCount + failedCount + unknownCount < reportedCount && (
        <p>{S.startup.truncated}</p>
      )}
      <p className="session-tools-note">{S.startup.limits}</p>
    </section>
  );
}

export function SessionToolsDialog({
  thread,
  title,
  active,
  onClose,
  returnFocusRef,
}: {
  thread: ThreadState;
  title: string;
  active: boolean;
  onClose(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const controller = useMemo(
    () => getSessionToolsController(thread, () => threads.thread(thread.key)),
    [thread, thread.connectionId, thread.nativeSessionId, thread.cwd],
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const mounted = useRef(true);
  const latest = useRef({ active, controller, onClose });
  latest.current = { active, controller, onClose };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const owns = () =>
    mounted.current &&
    latest.current.active &&
    latest.current.controller === controller &&
    controller.isCurrent();
  const blocked = controller.blockedCode;
  const error = !controller.isCurrent() ? "changed" : (view.error ?? blocked);
  const close = () => {
    if (mounted.current && latest.current.active) latest.current.onClose();
  };
  const report = controller.isCurrent() ? view.operation?.report : null;
  const startup =
    active && controller.isCurrent()
      ? thread.sessionToolInventory?.startup
      : null;
  return (
    <WorkspaceDialog
      title={S.title}
      onClose={close}
      returnFocusRef={returnFocusRef}
      returnFocusWhen={() => active && controller.isCurrent()}
    >
      <div
        className="workspace-dialog-body"
        aria-busy={view.unresolved || undefined}
      >
        <p className="session-tools-context">{title}</p>
        <p>{S.scope}</p>
        {view.phase === "idle" && <p>{S.initial}</p>}
        {view.unresolved && (
          <p role="status">
            {view.phase === "loading" ? S.loading : S.pending}
          </p>
        )}
        {error && <p role="status">{S.errors[error]}</p>}
        {startup && <SessionToolStartupView report={startup} />}
        {report && <SessionToolsReportView report={report} />}
        <p className="session-tools-note">{S.notice}</p>
      </div>
      <footer>
        <button type="button" className="btn btn-ghost" onClick={close}>
          {S.close}
        </button>
        {view.unresolved ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              !active ||
              !controller.isCurrent() ||
              view.checking ||
              view.phase === "loading"
            }
            onClick={() => {
              if (owns()) controller.check();
            }}
          >
            {view.checking ? S.checking : S.check}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!active || !controller.isCurrent() || blocked !== null}
            onClick={() => {
              if (owns()) controller.read();
            }}
          >
            {view.operation || view.error ? S.refresh : S.read}
          </button>
        )}
      </footer>
    </WorkspaceDialog>
  );
}
