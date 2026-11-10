import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { threads, type ThreadState } from "../runtime/sessions";
import { getSessionToolsController } from "../runtime/session_tools_controller";
import type {
  SessionToolConfigurationReport,
  SessionToolsReport,
  SessionToolStartupReport,
} from "../runtime/session_tools_types";
import { SESSION_TOOLS_STRINGS as S } from "../runtime/session_tools_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";
import "./SessionToolsDialog.css";

const CONFIGURATION_SCOPE = ":configuration";

export function SessionToolConfigurationView({
  report,
  previous = false,
}: {
  report: SessionToolConfigurationReport;
  previous?: boolean;
}) {
  const copy = S.configuration;
  const heading = previous ? S.previousReport : copy.title;
  return (
    <section className="session-tools-report" aria-label={heading}>
      <h3>{heading}</h3>
      <p>
        {previous ? copy.previousCount : S.count} {report.reportedItemCount}{" "}
        {copy.count}
      </p>
      <p className="session-tools-note">
        {S.received}：
        <time>{new Date(report.observedAtMs).toLocaleString()}</time>
      </p>
      <p className="session-tools-note">
        {copy.source} {copy.connection}
      </p>
      {report.reportedItemCount === 0 && <p>{copy.empty}</p>}
      {report.itemsTruncated && <p>{S.truncated}</p>}
      {report.items.length > 0 && (
        <ul className="session-tools-items">
          {report.items.map((item, index) => (
            <li key={index}>
              <strong>{item.name ?? copy.unnamed}</strong>
              <p>{copy.kinds[item.kind]}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

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
  const capability =
    active && controller.isCurrent() ? thread.sessionToolInventory : null;
  const hasConfiguration = capability?.configuration === true;
  const configurationOnly =
    hasConfiguration && capability.toolsUnavailable === true;
  const requestedScope =
    controller.requestedConfiguration || configurationOnly
      ? CONFIGURATION_SCOPE
      : (controller.requestedExtension ?? "");
  const [selection, setSelection] = useState(() => ({
    controller,
    name: requestedScope,
  }));
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
  const close = () => {
    if (mounted.current && latest.current.active) latest.current.onClose();
  };
  const report = controller.isCurrent() ? view.lastReport : null;
  const emptyExtension =
    controller.isCurrent() && view.operation?.report?.reportedItemCount === 0
      ? view.operation.extensionName
      : undefined;
  const extensions = capability?.extensions;
  const scope =
    !configurationOnly && selection.controller === controller
      ? selection.name
      : requestedScope;
  const configuration = hasConfiguration && scope === CONFIGURATION_SCOPE;
  const currentConfiguration = configuration
    ? view.operation?.configurationReport
    : undefined;
  const selected = configuration || extensions?.includes(scope) ? scope : "";
  const blocked = controller.blockedFor(configuration ? true : undefined);
  const error = requestedScope === selected ? (view.error ?? blocked) : blocked;
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
        {!configurationOnly && (hasConfiguration || !!extensions?.length) && (
          <label className="session-tools-filter">
            <span>{S.filter}</span>
            <select
              value={selected}
              disabled={
                view.unresolved || blocked === "busy" || blocked === "changed"
              }
              onChange={(event) => {
                if (owns())
                  setSelection({ controller, name: event.target.value });
              }}
            >
              <option value="">{S.allTools}</option>
              {hasConfiguration && (
                <option value={CONFIGURATION_SCOPE}>
                  {S.configuration.title}
                </option>
              )}
              {extensions?.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {view.phase === "idle" && (
          <p>{configuration ? S.configuration.initial : S.initial}</p>
        )}
        {view.unresolved && (
          <p role="status">
            {view.phase === "loading" ? S.loading : S.pending}
          </p>
        )}
        {error && <p role="status">{S.errors[error]}</p>}
        {startup && <SessionToolStartupView report={startup} />}
        {currentConfiguration && (
          <SessionToolConfigurationView report={currentConfiguration} />
        )}
        {configuration &&
          view.lastConfiguration &&
          currentConfiguration !== view.lastConfiguration && (
            <SessionToolConfigurationView
              report={view.lastConfiguration}
              previous
            />
          )}
        {emptyExtension && (
          <p className="session-tools-note">
            <bdi>{emptyExtension}</bdi> · {S.emptyScopedReport}
          </p>
        )}
        {report && (
          <>
            <p className="session-tools-note">
              {view.operation?.report === report.value &&
              report.extensionName === (selected || undefined)
                ? S.filter
                : S.previousReport}
              ：<bdi>{report.extensionName ?? S.allTools}</bdi>
            </p>
            <SessionToolsReportView report={report.value} />
          </>
        )}
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
              if (owns())
                controller.read(
                  configuration ? undefined : selected || undefined,
                  configuration ? true : undefined,
                );
            }}
          >
            {requestedScope === selected && (view.operation || view.error)
              ? S.refresh
              : S.read}
          </button>
        )}
      </footer>
    </WorkspaceDialog>
  );
}
