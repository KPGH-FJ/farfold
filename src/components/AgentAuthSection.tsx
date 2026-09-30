import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CaretDown } from "@phosphor-icons/react";
import {
  authMethods,
  type AuthMethodInfo,
  type AuthMethodsResponse,
} from "../runtime/agents";
import {
  authenticationActivity,
  invalidateAuthentication,
  useAuthenticationActivity,
} from "../runtime/authentication";
import {
  beginAuthentication,
  beginPreparationAction,
  recheckAuthentication,
} from "../runtime/auth_actions";
import { authActive } from "../runtime/auth_activity";
import {
  authenticationCheckBlockers,
  authenticationWorkBlockers,
} from "../runtime/auth_blockers";
import { threads, useThreadsSnapshot } from "../runtime/sessions";
import { AUTH_ACTIVITY_STRINGS as S } from "../runtime/auth_strings";
import { STRINGS } from "../runtime/strings";
import { uiError } from "../runtime/ui_error";
import { ManualAuthSection } from "./ManualAuthSection";
import { InlineTerminal } from "./InlineTerminal";
import { AgentAccountLinks } from "./AgentAccountLinks";
import { SETUP_PRESENTATION as P } from "../runtime/setup_presentation_strings";
import type { AccountRegistrationProgress } from "../runtime/account_registration";
import { AgentPreparationActions } from "./AgentPreparationActions";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";
import type { PreparationAction } from "../runtime/preparation";

export interface AgentAuthSectionProps {
  agentId: string;
  cwd?: string | null;
  source?: string;
  methodId?: string | null;
  onMethodChange?: (methodId: string) => void;
  onConfigureKey: () => void;
  onChanged: () => Promise<void>;
  onReconnect: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  program?: string;
  onOpenModels?: () => void;
  onOpenConversation?: (threadKey: string) => void;
  focused?: boolean;
  active?: boolean;
  registration?: AccountRegistrationProgress;
  onRegistrationChange?: (
    value: AccountRegistrationProgress | undefined,
  ) => void;
}
const A = STRINGS.agents.auth;

/** Shared account operation state survives navigation; only this view is local. */
export function AgentAuthSection({
  agentId,
  cwd,
  source,
  methodId,
  onMethodChange,
  onConfigureKey,
  onChanged,
  onReconnect,
  onBusyChange,
  program,
  onOpenModels,
  onOpenConversation,
  focused = false,
  active = true,
  registration,
  onRegistrationChange,
}: AgentAuthSectionProps) {
  const [info, setInfo] = useState<AuthMethodsResponse | null>(null);
  const [directory, setDirectory] = useState<string | null>(cwd ?? null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null);
  const manualOwned = useRef(false);
  const job = useAuthenticationActivity(agentId);
  const activity = authenticationActivity(agentId);
  const occupied = authActive(job) || manualBusy;
  const live = useThreadsSnapshot();
  const workBlockers = authenticationWorkBlockers(
    agentId,
    live.threads.values(),
  );
  const workBlocked = workBlockers.length > 0;
  const hasCurrentWork = () =>
    authenticationWorkBlockers(agentId, threads.getSnapshot().threads.values())
      .length > 0;
  const checkTarget = job?.target ?? { agentId, cwd: directory ?? "", source };
  const checkBlocked =
    authenticationCheckBlockers(checkTarget, live.threads.values()).length > 0;
  const hasCheckWork = () =>
    authenticationCheckBlockers(
      checkTarget,
      threads.getSnapshot().threads.values(),
    ).length > 0;
  useEffect(() => setSelectedMethodId(null), [agentId]);
  useEffect(() => {
    onBusyChange?.(occupied);
    return () => onBusyChange?.(false);
  }, [occupied, onBusyChange]);
  useEffect(() => {
    let current = true;
    setDirectory(cwd ?? null);
    if (cwd === undefined)
      void invoke<string>("app_default_working_directory")
        .then((value) => {
          if (current) setDirectory(value);
        })
        .catch((reason) => {
          if (current) setError(uiError(reason, A.failed));
        });
    return () => {
      current = false;
    };
  }, [cwd]);
  useEffect(() => {
    let current = true;
    setInfo(null);
    setError(null);
    setHidden(false);
    void authMethods(agentId)
      .then((value) => {
        if (current) setInfo(value);
      })
      .catch((reason) => {
        if (current) setError(uiError(reason, A.failed));
      });
    return () => {
      current = false;
    };
  }, [agentId, reload]);
  const start = (
    method: Pick<AuthMethodInfo, "id" | "kind"> &
      Partial<
        Pick<AuthMethodInfo, "name" | "completion" | "unavailableReason">
      >,
    manual = false,
    logout = false,
  ) => {
    if (
      !directory ||
      occupied ||
      source ||
      hasCurrentWork() ||
      (method.unavailableReason && !manual && !logout)
    )
      return;
    try {
      setError(null);
      setHidden(false);
      beginAuthentication({
        target: { agentId, cwd: directory, source },
        method,
        manual,
        logout,
        onChanged,
      });
    } catch (reason) {
      setError(uiError(reason, A.failed));
    }
  };
  const startPreparation = (action: PreparationAction, targetCwd: string) => {
    if (!targetCwd || !directory || occupied || source || hasCurrentWork())
      return;
    try {
      setError(null);
      setHidden(false);
      beginPreparationAction({
        target: { agentId, cwd: targetCwd, source },
        action,
        onChanged,
      });
    } catch (reason) {
      setError(uiError(reason, C.failed));
    }
  };
  const acquireManual = (checking = false) => {
    if (
      manualOwned.current ||
      authActive(activity.getSnapshot()) ||
      (checking ? hasCheckWork() : hasCurrentWork())
    )
      return null;
    manualOwned.current = true;
    setManualBusy(true);
    return () => {
      manualOwned.current = false;
      setManualBusy(false);
    };
  };
  const recheck = async () => {
    if (occupied || hasCheckWork()) return;
    if (job) {
      await activity.recheck(async () => {
        await recheckAuthentication(job.target, onChanged);
      });
    } else {
      const release = acquireManual(true);
      if (!release) return;
      try {
        invalidateAuthentication(agentId);
        if (source) await onReconnect();
        else if (directory)
          await recheckAuthentication({ agentId, cwd: directory }, onChanged);
      } catch (reason) {
        setError(uiError(reason, A.reconnectFailed));
        // Reloading methods clears their loading error. Keep the actual check
        // failure visible until the user explicitly retries.
        return;
      } finally {
        release();
      }
    }
    setReload((value) => value + 1);
  };
  const configuring = job?.operation.kind === "preparation";
  const terminalOutcome = job?.terminalOutcome;
  const configurationResult =
    !configuring || !terminalOutcome
      ? null
      : terminalOutcome.kind === "failed"
        ? uiError(terminalOutcome.error, C.failed)
        : terminalOutcome.kind === "cancelled"
          ? C.cancelled
          : terminalOutcome.code === 0
            ? C.ended
            : terminalOutcome.cancelled
              ? C.cancelled
              : C.exitFailed(terminalOutcome.code);
  const selectedMethod = authActive(job)
    ? undefined
    : (info?.methods.find(
        (method) =>
          method.id === (methodId === undefined ? selectedMethodId : methodId),
      ) ?? (info?.methods.length === 1 ? info.methods[0] : undefined));
  const status =
    job?.phase === "unknown"
      ? S.unknown
      : job?.phase === "cancelling"
        ? S.cancelling
        : job?.phase === "checking"
          ? A.checking
          : job?.phase === "completed"
            ? job.checked
              ? configuring
                ? C.checked
                : A.connectionChecked
              : A.reconnectFailed
            : job?.phase === "cancelled"
              ? configuring
                ? C.cancelled
                : S.cancelled
              : job?.phase === "failed"
                ? uiError(job.error, configuring ? C.failed : A.failed)
                : configuring
                  ? C.waiting
                  : S.waiting;
  return (
    <section className="auth agent-account-entry" aria-label={A.heading}>
      <div className="agent-account-heading">
        <h3>{focused ? P.accountHeading : A.heading}</h3>
        <p>{focused ? P.accountFocusedHint : P.accountHint}</p>
      </div>
      {error && (
        <div className="ac-error auth-error" role="alert">
          {error}
          <button
            className="btn btn-text"
            onClick={() => setReload((value) => value + 1)}
          >
            {STRINGS.access.retry}
          </button>
        </div>
      )}
      {source && (
        <div className="auth-note">
          {S.api}
          <button className="btn btn-text" onClick={onConfigureKey}>
            {STRINGS.access.apiRoute}
          </button>
        </div>
      )}
      {workBlocked && (
        <section aria-label={S.workHeading}>
          <h4>{S.workHeading}</h4>
          <p className="auth-note">{S.workHint}</p>
          <div role="list">
            {workBlockers.map((work) => (
              <div className="auth-row" role="listitem" key={work.key}>
                <div>
                  <div className="auth-name">{work.title}</div>
                  <div className="auth-desc">{work.reason}</div>
                  {!work.canOpen && <p className="auth-note">{S.workDraft}</p>}
                </div>
                {work.canOpen && onOpenConversation && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => onOpenConversation(work.key)}
                  >
                    {S.workOpen}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      {job && (
        <div className="auth-progress">
          <div className="auth-name">{job.operation.title}</div>
          {directory && job.target.cwd !== directory && (
            <p className="auth-note">{S.otherTarget}</p>
          )}
          <div className="auth-note" title={job.target.cwd}>
            {S.source}：{job.target.cwd}
          </div>
          <div className="auth-note" role="status">
            {status}
          </div>
          {configurationResult && configurationResult !== status && (
            <p className="auth-note">{configurationResult}</p>
          )}
          {configuring && !authActive(job) && onOpenModels && (
            <button className="btn btn-text" onClick={onOpenModels}>
              {C.models}
            </button>
          )}
          {!!job.error && job.phase !== "failed" && (
            <div className="auth-note" role="alert">
              {uiError(job.error, A.reconnectFailed)}
            </div>
          )}
          {job.terminal && (
            <button
              className="btn btn-text"
              onClick={() => setHidden((value) => !value)}
            >
              {hidden ? (configuring ? C.show : S.show) : S.hide}
            </button>
          )}
          {job.terminal && !hidden && (
            <InlineTerminal
              session={job.terminal}
              purpose={configuring ? "service_configuration" : "authentication"}
            />
          )}
          {authActive(job) && job.phase !== "checking" && (
            <div className="auth-actions">
              <button
                className="btn btn-ghost"
                onClick={() => void activity.cancel()}
              >
                {job.phase === "cancelling"
                  ? A.retryClose
                  : STRINGS.access.cancel}
              </button>
              {!job.terminal &&
                (job.phase === "unknown" || job.phase === "cancelling") && (
                  <button
                    className="btn btn-text"
                    onClick={() => void activity.endConnection()}
                  >
                    {S.endConnection}
                  </button>
                )}
              {job.terminal &&
                job.operation.completion === "return_and_verify" &&
                job.phase !== "cancelling" && (
                  <button
                    className="btn btn-primary"
                    onClick={() => void activity.cancel(true)}
                  >
                    {A.returnToCheck}
                  </button>
                )}
            </div>
          )}
        </div>
      )}
      <AgentPreparationActions
        agentId={agentId}
        cwd={directory}
        source={source}
        program={program}
        disabled={occupied || workBlocked}
        onRun={startPreparation}
      />
      {!info && !error && <div className="auth-note">{A.loading}</div>}
      {info?.methods.length === 0 && <div className="auth-note">{A.none}</div>}
      {!authActive(job) && info && info.methods.length > 1 && (
        <label className="auth-method-picker">
          <span>{S.chooseMethod}</span>
          <span className="api-select-wrap">
            <select
              value={selectedMethod?.id ?? ""}
              disabled={occupied || !!source}
              onChange={(event) => {
                setSelectedMethodId(event.target.value);
                onMethodChange?.(event.target.value);
              }}
            >
              <option value="" disabled>
                {S.chooseMethodHint}
              </option>
              {info.methods.map((method) => (
                <option key={method.id} value={method.id}>
                  {method.name}
                </option>
              ))}
            </select>
            <CaretDown size={14} aria-hidden="true" />
          </span>
        </label>
      )}
      {!authActive(job) &&
        selectedMethod &&
        ((method) => (
          <div key={method.id}>
            <div className="agent-account-action">
              <div>
                <div className="auth-name">
                  {method.purpose === "setup" ? A.setup : method.name}
                </div>
                {method.description && (
                  <div className="auth-desc">{method.description}</div>
                )}
                {method.unavailableReason && (
                  <p className="auth-note">{method.unavailableReason}</p>
                )}
              </div>
              <button
                className="btn btn-primary"
                disabled={
                  occupied ||
                  workBlocked ||
                  !directory ||
                  !!source ||
                  !!method.unavailableReason
                }
                onClick={() =>
                  !method.unavailableReason &&
                  (method.kind === "api-key" ? onConfigureKey() : start(method))
                }
              >
                {method.kind === "api-key"
                  ? STRINGS.access.apiRoute
                  : method.kind === "terminal"
                    ? method.purpose === "setup"
                      ? A.openSetup
                      : A.terminal
                    : A.start}
              </button>
            </div>
            <AgentAccountLinks
              active={active}
              agentId={agentId}
              methodId={method.id}
              registration={registration}
              onRegistrationChange={onRegistrationChange}
              onContinueLogin={() =>
                !method.unavailableReason &&
                (method.kind === "api-key" ? onConfigureKey() : start(method))
              }
              loginDisabled={
                occupied ||
                workBlocked ||
                !directory ||
                !!source ||
                !!method.unavailableReason
              }
              loginHint={
                source
                  ? S.api
                  : workBlocked
                    ? S.workHint
                    : (method.unavailableReason ?? undefined)
              }
            />
            <details className="agent-account-more">
              <summary>{P.moreLogin}</summary>
              <ManualAuthSection
                agentId={agentId}
                methodId={method.id}
                declaredEnv={method.envName}
                disabled={occupied || workBlocked || !directory || !!source}
                onAcquire={acquireManual}
                onInvalidate={() => {
                  invalidateAuthentication(agentId);
                }}
                onRun={() => start(method, true)}
              />
            </details>
          </div>
        ))(selectedMethod)}
      {!authActive(job) && info?.methods.length === 0 && (
        <>
          <AgentAccountLinks
            active={active}
            agentId={agentId}
            registration={registration}
            onRegistrationChange={onRegistrationChange}
          />
          <details className="agent-account-more">
            <summary>{P.moreLogin}</summary>
            <ManualAuthSection
              agentId={agentId}
              methodId="manual"
              disabled={occupied || workBlocked || !directory || !!source}
              onAcquire={acquireManual}
              onInvalidate={() => {
                invalidateAuthentication(agentId);
              }}
              onRun={() => start({ id: "manual", kind: "terminal" }, true)}
            />
          </details>
        </>
      )}
      {!authActive(job) && (
        <div className="auth-actions agent-account-checks">
          <button
            className="btn btn-text"
            disabled={occupied || checkBlocked || !directory}
            onClick={() => void recheck()}
          >
            {S.check}
          </button>
          {info?.canLogout && (
            <button
              className="btn btn-text"
              disabled={occupied || workBlocked || !directory || !!source}
              onClick={() =>
                start({ id: "logout", kind: "agent" }, false, true)
              }
            >
              {A.logout}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
