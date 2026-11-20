import { useEffect, useRef, useState } from "react";
import { AuthElicitationList } from "./AuthElicitationList";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import { AgentPreparationActions } from "./AgentPreparationActions";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";
import { officialLink, type PreparationAction } from "../runtime/preparation";
import { useConnectionPreparation } from "./useConnectionPreparation";
import {
  authMethodReadOnly,
  authMethodUnavailable,
} from "../runtime/auth_method";
import { allowAutomaticConnection } from "../runtime/connection_intent";
import { ACCOUNT_GUIDE_STRINGS as G } from "../runtime/account_guide_strings";
import { MethodApiKeySection } from "./MethodApiKeySection";
import { AgentConnectionPicker } from "./AgentConnectionPicker";
import { AgentAccountHeading } from "./AgentAccountHeading";
import { ConnectionAccount } from "./ConnectionAccount";
import { useConnectionAccount } from "../runtime/connection_account";
import { CONNECTION_STRINGS as R } from "../runtime/r5_auth_strings";
import {
  useAccessPrimary,
  type AgentAccessPrimary,
} from "../runtime/access_primary";
import {
  authConnectionOptions,
  authMethodContinue,
  authMethodGroup,
  currentMethodRoles,
  methodTitle,
} from "./agent_auth_options";
import {
  AgentAccountExit,
  AgentAuthManage,
  AgentAuthWorkBlockers,
  AgentExistingVerify,
} from "./AgentAuthManage";
import "../r5-agent-access.css";
import type {
  AgentConnectionPresentation,
  AgentAuthSectionProps,
} from "./agent_auth_types";
export type {
  AgentConnectionPresentation,
  AgentAuthSectionProps,
} from "./agent_auth_types";

const A = STRINGS.agents.auth;
const methodSignature = (
  method: Pick<AuthMethodInfo, "id" | "kind"> & Partial<AuthMethodInfo>,
) =>
  JSON.stringify([
    method.id,
    method.kind,
    method.purpose ?? null,
    method.completion ?? "exit_code",
    method.apiKeyProvider ?? null,
    method.unavailableReason ?? null,
  ]);

export function AgentAuthSection({
  agentId,
  cwd,
  source,
  apiState = "unknown",
  apiUnavailableReason,
  methodId,
  onMethodChange,
  onConfigureKey,
  onChanged,
  onReconnect,
  onBusyChange,
  program,
  onOpenModels,
  canOpenModels = false,
  onOpenConversation,
  active = true,
  card,
  onConnect,
  onInfoChange,
  busy = false,
  connection,
}: AgentAuthSectionProps) {
  const [loadedInfo, setInfo] = useState<AuthMethodsResponse | null>(null);
  const [defaultDirectory, setDirectory] = useState<string | null>(cwd ?? null);
  const directory = cwd === undefined ? defaultDirectory : cwd;
  const targetKey = JSON.stringify([agentId, directory, source ?? null]);
  const target = useRef(targetKey);
  const currentView = useRef("");
  // Accept the committed destination key while the operation is still running.
  const acceptedView = useRef<string | null>(null);
  target.current = targetKey;
  const modelNavigation = useRef(canOpenModels);
  modelNavigation.current = canOpenModels;
  const methodsOwner = useRef(targetKey);
  const methodsRequest = useRef(0);
  const declarationRequest = methodsRequest.current;
  const methodView = useRef({
    request: declarationRequest,
    selected: null as string | null,
    count: 0,
  });
  const info = methodsOwner.current === targetKey ? loadedInfo : null;
  const preparation = useConnectionPreparation(agentId, program, !!info);
  const { info: preparationInfo, error: actionsError } = preparation;
  const { actions = [], connectionGuidance = [] } = preparationInfo ?? {};
  const officialMethodRoles = currentMethodRoles(
    info?.methods ?? [],
    preparationInfo?.officialMethodRoles ?? [],
  );
  const methods = (info?.methods ?? []).filter(
    (method) =>
      (method.kind !== "api-key" ||
        !!method.apiKeyProvider ||
        apiState !== "unsupported") &&
      !officialMethodRoles.some(
        (item) =>
          item.methodId === method.id &&
          item.role === "external" &&
          connectionGuidance.some(
            (guide) => guide.methodId === method.id && officialLink(guide.url),
          ),
      ),
  );
  const [error, setError] = useState<string | null>(null);
  const [methodsError, setMethodsError] = useState<string | null>(null);
  const visibleError = error ?? methodsError;
  const [reload, setReload] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [localActionId, setLocalActionId] = useState<string | null>(null);
  const [changingConnection, setChangingConnection] = useState(false);
  const [localStage, setLocalStage] = useState<"method" | "account">("method");
  const [keyPrimary, setKeyPrimary] = useState<AgentAccessPrimary | null>(null);
  const [preparationPrimary, setPreparationPrimary] =
    useState<AgentAccessPrimary | null>(null);
  const [connectionCheck, setConnectionCheck] = useState<{
    targetKey: string;
    phase: "checking" | "checked";
  } | null>(null);
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [registrationNotice, setRegistrationNotice] = useState(false);
  const preparationTicket = useRef(0);
  const infoChange = useRef(onInfoChange);
  infoChange.current = onInfoChange;
  const existingAccount = useConnectionAccount(
    agentId,
    directory ?? null,
    source,
    active,
  );
  const [accountExit, setAccountExit] = useState<"logout" | "switch" | null>(
    null,
  );
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
  const checkTarget =
    authActive(job) && job
      ? job.target
      : { agentId, cwd: directory ?? "", source };
  const checkBlocked =
    authenticationCheckBlockers(checkTarget, live.threads.values()).length > 0;
  const hasCheckWork = () =>
    authenticationCheckBlockers(
      checkTarget,
      threads.getSnapshot().threads.values(),
    ).length > 0;
  useEffect(() => {
    setSelectedMethodId(null);
    setAccountExit(null);
    setError(null);
    setLocalActionId(null);
    setChangingConnection(false);
    setLocalStage("method");
    setRegistrationNotice(false);
    setPreparing(false);
  }, [agentId, directory, source]);
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
    const unlisten = listen<{ agentId: string }>("agent:status", (event) => {
      if (event.payload.agentId !== agentId) return;
      methodsRequest.current++;
      methodsOwner.current = "";
      setInfo(null);
      infoChange.current?.(null);
      setAccountExit(null);
      setReload((value) => value + 1);
    });
    return () => {
      void unlisten.then((off) => off()).catch(() => undefined);
    };
  }, [agentId]);
  useEffect(() => {
    let current = true;
    const request = ++methodsRequest.current;
    methodsOwner.current = "";
    setInfo(null);
    infoChange.current?.(null);
    setMethodsError(null);
    setHidden(false);
    void authMethods(agentId, {
      cwd: directory,
      source: connection ? undefined : source,
    })
      .then((value) => {
        if (
          current &&
          target.current === targetKey &&
          methodsRequest.current === request
        ) {
          methodsOwner.current = targetKey;
          setInfo(value);
          infoChange.current?.(value);
        }
      })
      .catch((reason) => {
        if (
          current &&
          target.current === targetKey &&
          methodsRequest.current === request
        )
          setMethodsError(uiError(reason, A.failed));
      });
    return () => {
      current = false;
    };
  }, [agentId, directory, source, targetKey, reload, !!connection]);
  const methodIsCurrent = (
    method: Pick<AuthMethodInfo, "id" | "kind"> & Partial<AuthMethodInfo>,
    manual = false,
  ) =>
    methodsRequest.current === declarationRequest &&
    methodView.current.request === declarationRequest &&
    (manual && method.id === "manual"
      ? methodView.current.count === 0
      : methodView.current.selected === methodSignature(method));
  const start = (
    method: Pick<AuthMethodInfo, "id" | "kind"> &
      Partial<
        Pick<
          AuthMethodInfo,
          "name" | "completion" | "unavailableReason" | "apiKeyProvider"
        >
      >,
    manual = false,
    logout = false,
    switchAccount = false,
    credential?: { id: string; revision: string },
    verified = false,
  ) => {
    if (
      !directory ||
      target.current !== targetKey ||
      (currentView.current !== viewKey &&
        currentView.current !== acceptedView.current) ||
      (!logout && !verified && !methodIsCurrent(method, manual)) ||
      occupied ||
      busy ||
      authActive(activity.getSnapshot()) ||
      source ||
      hasCurrentWork() ||
      (authMethodUnavailable(method) && !manual && !logout)
    )
      return;
    try {
      setError(null);
      setHidden(false);
      setChangingConnection(false);
      beginAuthentication({
        target: { agentId, cwd: directory, source },
        method,
        manual,
        logout,
        switchAccount,
        ...(credential
          ? {
              credentialId: credential.id,
              credentialRevision: credential.revision,
            }
          : {}),
        onChanged,
      });
      if (connection && !logout && !manual) setStage("account");
      setAccountExit(null);
    } catch (reason) {
      setError(uiError(reason, A.failed));
    }
  };
  const accountExitAvailable =
    !!info?.canLogout && !occupied && !workBlocked && !!directory && !source;
  const canSwitchAccount =
    !!info?.canLogout &&
    info.methods.some(
      (method) =>
        (method.kind === "agent" ||
          method.kind === "terminal" ||
          (method.kind === "api-key" && !!method.apiKeyProvider)) &&
        !authMethodUnavailable(method),
    );
  const chooseAccountExit = (intent: "logout" | "switch") => {
    if (
      !accountExitAvailable ||
      (intent === "switch" && !canSwitchAccount) ||
      methodsOwner.current !== targetKey ||
      target.current !== targetKey ||
      hasCurrentWork()
    )
      return;
    setAccountExit(intent);
  };
  /** Borrowed or cached declarations display methods but cannot execute; the
   *  preparation connection is established silently on demand, then the fresh
   *  declaration replaces the displayed one. */
  const ensureExecutable = async (): Promise<AuthMethodsResponse | null> => {
    if (info?.executionReady || !onConnect) return info;
    const ticket = ++preparationTicket.current;
    setPreparing(true);
    setError(null);
    try {
      allowAutomaticConnection(agentId);
      await onConnect();
      const fresh = await authMethods(agentId, {
        cwd: directory,
        source: connection ? undefined : source,
      });
      if (target.current !== targetKey || ticket !== preparationTicket.current)
        return null;
      methodsOwner.current = targetKey;
      setInfo(fresh);
      infoChange.current?.(fresh);
      return fresh;
    } catch (reason) {
      if (target.current === targetKey) setError(uiError(reason, A.failed));
      return null;
    } finally {
      if (ticket === preparationTicket.current) setPreparing(false);
    }
  };
  /** Run `invoke` after connecting when needed; the method id is re-validated
   *  against the fresh declaration so a changed list never executes stale. */
  const runWithConnection = (
    method: AuthMethodInfo,
    invokeMethod: (method: AuthMethodInfo) => void,
  ) => {
    if (!info || info.executionReady || !onConnect) {
      invokeMethod(method);
      return;
    }
    void (async () => {
      const fresh = await ensureExecutable();
      if (!fresh) return;
      if (!fresh.executionReady) {
        setError(R.connectionIncomplete);
        return;
      }
      const next =
        method.id === "manual" || method.id === "logout"
          ? method
          : fresh.methods.find((entry) => entry.id === method.id);
      if (!next) {
        setError(R.methodsChanged);
        return;
      }
      // Abort when the selection moved on while the connection was prepared.
      if (
        method.id !== "manual" &&
        method.id !== "logout" &&
        methodView.current.selected !== methodSignature(next)
      )
        return;
      invokeMethod(next);
    })();
  };
  const confirmAccountExit = () => {
    if (
      !accountExit ||
      !accountExitAvailable ||
      (accountExit === "switch" && !canSwitchAccount) ||
      methodsOwner.current !== targetKey ||
      target.current !== targetKey ||
      hasCurrentWork()
    )
      return;
    runWithConnection({ id: "logout", kind: "agent" } as AuthMethodInfo, () =>
      start(
        { id: "logout", kind: "agent" },
        false,
        true,
        accountExit === "switch",
        undefined,
        true,
      ),
    );
  };

  const startPreparation = (action: PreparationAction, targetCwd: string) => {
    if (
      target.current !== targetKey ||
      currentView.current !== viewKey ||
      !targetCwd ||
      !directory ||
      occupied ||
      authActive(activity.getSnapshot()) ||
      source ||
      hasCurrentWork()
    )
      return;
    try {
      setError(null);
      setHidden(false);
      setChangingConnection(false);
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
    if (
      target.current !== targetKey ||
      currentView.current !== viewKey ||
      occupied ||
      busy ||
      hasCheckWork()
    )
      return;
    if (job && (selectedJob || visibleAccountExit)) {
      await activity.recheck(async () => {
        await recheckAuthentication(job.target, onChanged);
      });
    } else {
      const release = acquireManual(true);
      if (!release) return;
      setConnectionCheck({ targetKey, phase: "checking" });
      setError(null);
      try {
        if (info && !info.executionReady && !source) await ensureExecutable();
        invalidateAuthentication(agentId);
        if (source) await onReconnect();
        else if (directory)
          await recheckAuthentication({ agentId, cwd: directory }, onChanged);
      } catch (reason) {
        setConnectionCheck((current) =>
          current?.targetKey === targetKey ? null : current,
        );
        if (target.current === targetKey)
          setError(uiError(reason, A.reconnectFailed));
        // Reloading methods clears their loading error. Keep the actual check
        // failure visible until the user explicitly retries.
        return;
      } finally {
        release();
      }
      setConnectionCheck((current) =>
        current?.targetKey === targetKey
          ? target.current === targetKey
            ? { targetKey, phase: "checked" }
            : null
          : current,
      );
    }
    if (target.current !== targetKey) return;
    setError(null);
    setReload((value) => value + 1);
  };
  const sameJobTarget =
    !!job &&
    job.target.agentId === agentId &&
    job.target.cwd === directory &&
    (job.target.source ?? null) === (source ?? null);
  const actionId = connection?.actionId ?? localActionId;
  const selectedAction = actions.find((action) => action.id === actionId);
  const apiSelected = connection?.choice === "api";
  const chosenMethod = methods.find(
    (method) =>
      method.id === (methodId === undefined ? selectedMethodId : methodId),
  );
  const requestedStage = connection?.stage ?? localStage;
  const recordedChoice =
    sameJobTarget &&
    (job.operation.kind === "authentication"
      ? connection?.choice === "login" && job.operation.methodId === methodId
      : job.operation.actionId === actionId);
  const missingChoice =
    !recordedChoice &&
    ((connection?.choice === "login" && !chosenMethod) ||
      (!!actionId && !selectedAction));
  const stage =
    !authActive(job) &&
    !recordedChoice &&
    requestedStage === "account" &&
    (missingChoice ||
      (connection?.choice === "login" && !chosenMethod?.apiKeyProvider))
      ? "method"
      : requestedStage;
  const selectedMethod = authActive(job)
    ? undefined
    : (chosenMethod ?? methods[0]);
  const viewKey = JSON.stringify([
    targetKey,
    stage,
    connection?.choice,
    chosenMethod?.id,
    actionId,
  ]);
  currentView.current = viewKey;
  methodView.current = {
    request: declarationRequest,
    selected: selectedMethod ? methodSignature(selectedMethod) : null,
    count: methods.length,
  };
  const selectedJob =
    sameJobTarget &&
    !apiSelected &&
    (connection
      ? stage === "account" &&
        (connection.choice === "login"
          ? job.operation.kind === "authentication" &&
            job.operation.methodId === (methodId ?? selectedMethod?.id)
          : !!actionId &&
            job.operation.kind === "preparation" &&
            job.operation.actionId === actionId)
      : !methodId ||
        (job.operation.kind === "authentication" &&
          job.operation.methodId === methodId));
  const configuring = job?.operation.kind === "preparation";
  const exiting =
    job?.operation.kind === "authentication" &&
    (job.operation.intent === "logout" ||
      job.operation.intent === "switch_account");
  const visibleAccountExit =
    sameJobTarget && !apiSelected && exiting && !changingConnection;
  const protocolLogin =
    job?.operation.kind === "authentication" &&
    (job.operation.intent === undefined || job.operation.intent === "login") &&
    !job.terminal &&
    !job.terminalOutcome;
  const loginConfirmed =
    protocolLogin && !!job?.operationConfirmed && selectedJob;
  const terminalOutcome = job?.terminalOutcome;
  const terminalReady =
    !!job?.terminal?.getSnapshot().id &&
    job.terminal.getSnapshot().exit === null &&
    !job.terminal.getSnapshot().closing;
  const finishAllowed =
    terminalReady &&
    authActive(job) &&
    job?.phase !== "checking" &&
    job?.phase !== "cancelling" &&
    !workBlocked &&
    !checkBlocked;
  const canFinishNow = (attemptId: string) => {
    const current = activity.getSnapshot();
    const terminal = current?.terminal?.getSnapshot();
    return (
      target.current === targetKey &&
      current?.attemptId === attemptId &&
      authActive(current) &&
      current.phase !== "checking" &&
      current.phase !== "cancelling" &&
      !!terminal?.id &&
      terminal.exit === null &&
      !terminal.closing &&
      !hasCurrentWork() &&
      !authenticationCheckBlockers(
        current.target,
        threads.getSnapshot().threads.values(),
      ).length
    );
  };
  const modelsAvailable =
    selectedJob &&
    job?.phase === "completed" &&
    job.checked &&
    !exiting &&
    job.target.agentId === agentId &&
    job.target.cwd === directory &&
    (job.target.source ?? null) === (source ?? null);
  const openModels = () => {
    const current = activity.getSnapshot();
    if (
      !modelNavigation.current ||
      target.current !== targetKey ||
      current?.attemptId !== job?.attemptId ||
      current?.phase !== "completed" ||
      !current.checked ||
      current.target.agentId !== agentId ||
      current.target.cwd !== directory ||
      (current.target.source ?? null) !== (source ?? null) ||
      (current.operation.kind === "authentication" &&
        ["logout", "switch_account"].includes(
          current.operation.intent ?? "",
        )) ||
      hasCurrentWork() ||
      hasCheckWork()
    )
      return;
    onOpenModels?.();
  };
  const configurationResult =
    !configuring || !terminalOutcome
      ? null
      : terminalOutcome.kind === "failed"
        ? uiError(terminalOutcome.error, C.failed)
        : terminalOutcome.kind === "cancelled"
          ? C.cancelled
          : terminalOutcome.code === 0
            ? C.ended
            : job?.finishRequested
              ? S.finishEnded
              : terminalOutcome.cancelled
                ? C.cancelled
                : C.exitFailed(terminalOutcome.code);
  const loginAgain = (method: AuthMethodInfo) =>
    loginConfirmed &&
    job?.operation.kind === "authentication" &&
    job.operation.methodId === method.id;
  const status =
    job?.phase === "unknown"
      ? job.finishRequested
        ? S.finishUnknown
        : S.unknown
      : job?.phase === "cancelling"
        ? job.finishRequested
          ? S.finishClosing
          : S.cancelling
        : job?.phase === "checking"
          ? loginConfirmed
            ? S.loginConfirmedChecking
            : job.finishRequested && !exiting
              ? S.finishChecking
              : exiting
                ? job.operationConfirmed
                  ? S.logoutChecking
                  : S.accountChecking
                : protocolLogin
                  ? S.accountChecking
                  : A.checking
          : job?.phase === "completed"
            ? loginConfirmed
              ? job.checked
                ? S.loginSucceeded
                : S.loginConfirmedCheckFailed
              : job.checked
                ? exiting
                  ? !job.operationConfirmed
                    ? S.logoutNotConfirmed
                    : job.operation.kind === "authentication" &&
                        job.operation.intent === "switch_account"
                      ? S.switchReady
                      : S.logoutChecked
                  : job.finishRequested
                    ? S.finishChecked
                    : configuring
                      ? C.checked
                      : A.connectionChecked
                : exiting
                  ? job.operationConfirmed
                    ? S.logoutCheckFailed
                    : A.reconnectFailed
                  : A.reconnectFailed
            : job?.phase === "cancelled"
              ? configuring
                ? C.cancelled
                : S.cancelled
              : job?.phase === "failed"
                ? uiError(
                    job.error,
                    exiting
                      ? S.logoutFailed
                      : configuring
                        ? C.failed
                        : A.failed,
                  )
                : configuring
                  ? C.waiting
                  : exiting
                    ? S.logoutWaiting
                    : protocolLogin
                      ? S.loginWaiting
                      : S.waiting;
  const connectionOptions = authConnectionOptions({
    connection,
    existingAccount,
    methods,
    actions,
    apiState,
    roles: officialMethodRoles,
  });
  const hasConnectionChoices = !!(
    connectionOptions.length || connectionGuidance.length
  );
  const existingSelected =
    !!connection &&
    connection.choice === "existing" &&
    !apiSelected &&
    !selectedAction &&
    !(methodId === undefined ? selectedMethodId : methodId);
  const optionValue = apiSelected
    ? JSON.stringify(["api"])
    : existingSelected
      ? JSON.stringify(["existing"])
      : selectedAction
        ? JSON.stringify(["action", selectedAction.id])
        : selectedMethod
          ? JSON.stringify(["method", selectedMethod.id])
          : null;
  const setStage = (value: "method" | "account" | "api") => {
    if (connection) connection.onStageChange(value);
    else setLocalStage(value === "api" ? "method" : value);
  };
  const chooseConnection = (encoded: string) => {
    if (
      target.current !== targetKey ||
      methodsRequest.current !== declarationRequest ||
      occupied ||
      busy ||
      preparing ||
      hasCurrentWork() ||
      methodsOwner.current !== targetKey
    )
      return;
    const option = connectionOptions.find(
      (item) => item.id === encoded && !item.disabled,
    );
    if (!option) return;
    const [kind, id] = JSON.parse(encoded) as [string, string?];
    setChangingConnection(true);
    setAccountExit(null);
    setRegistrationNotice(false);
    setLocalStage("method");
    if (kind === "existing") {
      setLocalActionId(null);
      setSelectedMethodId(null);
      chooseExisting();
    } else if (kind === "api") connection?.onChoice("api");
    else if (kind === "action" && id) {
      setLocalActionId(id);
      setSelectedMethodId(null);
      connection?.onChoice("existing", undefined, id);
    } else if (kind === "method" && id) {
      setLocalActionId(null);
      setSelectedMethodId(id);
      if (connection) connection.onChoice("login", id);
      else onMethodChange?.(id);
      const picked = methods.find((method) => method.id === id);
      if (picked?.apiKeyProvider) setStage("account");
    }
  };
  const terminalNeedsReview =
    !!terminalOutcome &&
    (terminalOutcome.kind !== "ended" ||
      ((terminalOutcome.cancelled || terminalOutcome.code !== 0) &&
        !job?.finishRequested));
  const completedSummary =
    !changingConnection &&
    selectedJob &&
    job?.phase === "completed" &&
    !exiting &&
    !terminalNeedsReview &&
    (loginConfirmed || job.checked);
  const showApiSummary =
    !authActive(job) &&
    apiSelected &&
    stage === "api" &&
    !!connection?.apiSummary;
  const completedMethod = methods.find(
    (method) =>
      job?.operation.kind === "authentication" &&
      method.id === job.operation.methodId,
  );
  const summaryTitle =
    job?.terminal || configuring
      ? R.terminal
      : completedMethod
        ? methodTitle(completedMethod)
        : (job?.operation.title ?? R.existing);
  const summaryStatus = loginConfirmed
    ? completedMethod?.apiKeyProvider
      ? R.keyConfirmed
      : R.confirmed
    : job?.terminal || configuring
      ? R.terminalChecked
      : R.checked;
  const changeConnection = () => {
    if (
      target.current !== targetKey ||
      currentView.current !== viewKey ||
      occupied ||
      busy ||
      hasCurrentWork()
    )
      return;
    setChangingConnection(true);
    setStage("method");
  };
  const existingSummary =
    !!connection &&
    connection.choice === "existing" &&
    stage === "account" &&
    !methodId &&
    !actionId &&
    !authActive(job) &&
    !completedSummary;
  const showPicker =
    !authActive(job) && !completedSummary && stage === "method";
  const fieldVisible =
    !completedSummary &&
    !showApiSummary &&
    !existingSummary &&
    !authActive(job) &&
    !apiSelected &&
    !selectedAction &&
    stage === "account";
  const executeSelected = () => {
    if (
      !selectedMethod ||
      preparation.loading ||
      occupied ||
      busy ||
      workBlocked ||
      !directory ||
      source
    )
      return;
    if (
      target.current !== targetKey ||
      methodsOwner.current !== targetKey ||
      !methodIsCurrent(selectedMethod) ||
      hasCurrentWork()
    )
      return;
    setSelectedMethodId(selectedMethod.id);
    if (connection) connection.onChoice("login", selectedMethod.id);
    else onMethodChange?.(selectedMethod.id);
    acceptedView.current = JSON.stringify([
      targetKey,
      stage,
      connection?.choice,
      selectedMethod.id,
      actionId,
    ]);
    if (selectedMethod.apiKeyProvider) {
      setStage("account");
      return;
    }
    if (selectedMethod.kind === "api-key") {
      onConfigureKey();
      return;
    }
    runWithConnection(selectedMethod, (fresh) =>
      start(fresh, false, false, false, undefined, true),
    );
  };
  const methodPrimary =
    selectedMethod &&
    (fieldVisible || (showPicker && !apiSelected && !selectedAction)) &&
    !authMethodReadOnly(selectedMethod) &&
    !authMethodUnavailable(selectedMethod) &&
    (!selectedMethod.apiKeyProvider || stage === "method")
      ? {
          id: JSON.stringify([
            targetKey,
            methodSignature(selectedMethod),
            stage,
          ]),
          label: authMethodContinue(
            selectedMethod,
            officialMethodRoles,
            loginAgain(selectedMethod),
            S.loginAgain,
          ),
          disabled:
            occupied ||
            busy ||
            workBlocked ||
            !directory ||
            !!source ||
            preparation.loading ||
            preparing,
          run: executeSelected,
        }
      : null;
  const chooseExisting = () => {
    const run = () => {
      if (connection?.onUseExisting) connection.onUseExisting();
      else {
        connection?.onChoice("existing");
        setStage("account");
      }
    };
    if (info && !info.executionReady && onConnect)
      void (async () => {
        const fresh = await ensureExecutable();
        if (!fresh?.executionReady) return;
        run();
      })();
    else run();
  };
  const primary =
    authActive(job) || completedSummary || showApiSummary || existingSummary
      ? null
      : existingSelected && stage === "method"
        ? {
            id: JSON.stringify([targetKey, "existing"]),
            label: R.existingContinue,
            disabled:
              occupied ||
              busy ||
              workBlocked ||
              !directory ||
              !!source ||
              preparing,
            run: chooseExisting,
          }
        : apiSelected && stage === "method"
          ? {
              id: JSON.stringify([targetKey, "api"]),
              label: R.continue,
              disabled:
                occupied ||
                busy ||
                workBlocked ||
                !connection?.apiAvailable ||
                preparing,
              run: () => setStage("api"),
            }
          : selectedAction
            ? stage === "method"
              ? {
                  id: JSON.stringify([targetKey, "action", selectedAction.id]),
                  label: R.continue,
                  disabled:
                    occupied ||
                    busy ||
                    workBlocked ||
                    !directory ||
                    !!source ||
                    preparing,
                  run: () => setStage("account"),
                }
              : preparationPrimary
            : selectedMethod?.apiKeyProvider && stage === "account"
              ? keyPrimary
              : methodPrimary;
  useAccessPrimary(primary, connection?.onPrimaryChange);
  const registrationReturn = () => {
    setRegistrationNotice(true);
    if (connection) chooseExisting();
    else void recheck();
  };
  const registrationRow = (groupMethods: AuthMethodInfo[]) => (
    <AgentAccountLinks
      active={active}
      agentId={agentId}
      methodIds={groupMethods.map((method) => method.id)}
      agentName={card?.name ?? agentId}
      websiteUrl={
        card?.presentation?.sourceUrl ?? card?.sourceUrl ?? card?.installGuide
      }
      onReturn={registrationReturn}
      disabled={occupied || busy || workBlocked || !directory || !!source}
    />
  );
  const groupFooters = {
    [R.groupAgent]: registrationRow(
      methods.filter(
        (method) =>
          authMethodGroup(method, officialMethodRoles) === R.groupAgent,
      ),
    ),
    [R.groupTerminal]: registrationRow(
      methods.filter(
        (method) =>
          authMethodGroup(method, officialMethodRoles) === R.groupTerminal,
      ),
    ),
  };
  const accountOptions =
    selectedMethod && !apiSelected
      ? (() => {
          const method = selectedMethod;
          return (
            <details className="agent-account-more">
              <summary>{P.moreLogin}</summary>
              <ManualAuthSection
                agentId={agentId}
                methodId={method.id}
                declaredEnv={method.envName}
                disabled={
                  occupied || busy || workBlocked || !directory || !!source
                }
                onAcquire={acquireManual}
                onInvalidate={() => {
                  invalidateAuthentication(agentId);
                }}
                onRun={() => start(method, true)}
              />
            </details>
          );
        })()
      : null;
  return (
    <section className="auth agent-account-entry" aria-label={P.accountHeading}>
      <AgentAccountHeading
        title={
          stage === "method" && !authActive(job)
            ? R.choose
            : apiSelected
              ? R.api
              : completedSummary
                ? R.current
                : existingSummary
                  ? R.existing
                  : ((authActive(job) || selectedJob) && job?.terminal) ||
                      selectedAction ||
                      selectedMethod?.kind === "terminal"
                    ? R.terminal
                    : selectedMethod
                      ? methodTitle(selectedMethod)
                      : R.methods
        }
        onBack={stage === "method" ? undefined : changeConnection}
        disabled={occupied || busy || workBlocked}
      />
      {visibleError && (
        <div className="ac-error auth-error" role="alert">
          {visibleError}
          <button
            className="btn btn-text"
            onClick={() => {
              setError(null);
              setReload((value) => value + 1);
            }}
          >
            {STRINGS.access.retry}
          </button>
        </div>
      )}
      {source && !connection && apiState !== "unsupported" && (
        <div className="auth-note">
          {S.api}
          <button className="btn btn-text" onClick={onConfigureKey}>
            {STRINGS.access.apiRoute}
          </button>
        </div>
      )}
      {workBlocked && (
        <AgentAuthWorkBlockers
          blockers={workBlockers}
          agentName={card?.name}
          onOpenConversation={onOpenConversation}
        />
      )}
      {!selectedJob &&
        !apiSelected &&
        connectionCheck?.targetKey === targetKey && (
          <p className="auth-note" role="status">
            {connectionCheck.phase === "checking"
              ? S.accountChecking
              : A.connectionChecked}
          </p>
        )}
      {!apiSelected && (
        <ConnectionAccount
          agentId={agentId}
          cwd={directory}
          source={source}
          active={active}
        />
      )}
      {completedSummary && (
        <div className="journey-connection-summary">
          <strong>{summaryTitle}</strong>
          <span role="status">{summaryStatus}</span>
        </div>
      )}
      {existingSummary && connection?.existingVerify && (
        <AgentExistingVerify verify={connection.existingVerify} />
      )}
      {completedSummary && !job.checked && (
        <p className="auth-note" role="alert">
          {status}
        </p>
      )}
      {showApiSummary && connection?.apiSummary}
      {apiSelected &&
        stage === "api" &&
        !showApiSummary &&
        connection?.apiContent}
      {job &&
        !completedSummary &&
        (authActive(job) ||
          visibleAccountExit ||
          (!changingConnection && selectedJob)) && (
          <div className="auth-progress">
            <div className="auth-name">{job.operation.title}</div>
            {(job.target.agentId !== agentId ||
              job.target.cwd !== directory ||
              (job.target.source ?? null) !== (source ?? null)) && (
              <p className="auth-note">{S.otherTarget}</p>
            )}
            <details className="journey-details">
              <summary>{R.details}</summary>
              <p className="auth-note">
                {S.source}：{job.target.cwd}
              </p>
            </details>
            <div className="auth-note" role="status">
              {status}
            </div>
            {configurationResult && configurationResult !== status && (
              <p className="auth-note">{configurationResult}</p>
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
                {hidden
                  ? terminalOutcome
                    ? S.records
                    : configuring
                      ? C.show
                      : S.show
                  : S.hide}
              </button>
            )}
            <AuthElicitationList
              activity={activity}
              job={job}
              agentName={card?.name ?? agentId}
            />
            {job.terminal && !hidden && (
              <InlineTerminal
                session={job.terminal}
                purpose={
                  configuring ? "service_configuration" : "authentication"
                }
                getFinishRequested={() => {
                  const current = activity.getSnapshot();
                  return (
                    current?.attemptId === job.attemptId &&
                    current.finishRequested
                  );
                }}
              />
            )}
            {job.terminal && authActive(job) && (
              <p className="auth-note">{S.finishHint}</p>
            )}
            {authActive(job) && job.phase !== "checking" && (
              <div className="auth-actions">
                <button
                  className="btn btn-ghost"
                  onClick={() => void activity.cancel()}
                >
                  {job.phase === "cancelling" ||
                  (job.finishRequested && job.phase === "unknown")
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
                {job.terminal && job.phase !== "cancelling" && (
                  <button
                    className="btn btn-primary"
                    disabled={!finishAllowed}
                    onClick={() => {
                      if (canFinishNow(job.attemptId))
                        void activity.finishTerminal();
                    }}
                  >
                    {S.finish}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      {!apiSelected && (
        <AgentPreparationActions
          agentId={agentId}
          cwd={directory}
          source={source}
          program={program}
          disabled={occupied || busy || workBlocked}
          onRun={startPreparation}
          data={{
            actions,
            error: actionsError ?? null,
            onRetry: preparation.retry,
          }}
          hideChoices
          selectedId={selectedAction?.id}
          reviewSelected={
            !authActive(job) &&
            !completedSummary &&
            !apiSelected &&
            stage === "account" &&
            !!selectedAction
          }
          onPrimaryChange={
            connection?.onPrimaryChange ? setPreparationPrimary : undefined
          }
          onCancelReview={() => {
            if (!occupied && !hasCurrentWork()) setStage("method");
          }}
        />
      )}
      {!info && !visibleError && <div className="auth-note">{A.loading}</div>}
      {info &&
        methods.length === 0 &&
        !completedSummary &&
        !apiSelected &&
        !hasConnectionChoices && <div className="auth-note">{A.none}</div>}
      {preparing && (
        <p className="auth-note" role="status">
          {R.preparingLogin}
        </p>
      )}
      {registrationNotice && showPicker && (
        <p className="auth-note" role="status">
          {G.returnedPickMethod}
        </p>
      )}
      {showPicker && info && hasConnectionChoices && (
        <AgentConnectionPicker
          name={`connection-${agentId}`}
          options={connectionOptions}
          value={optionValue}
          disabled={
            occupied || busy || workBlocked || (!connection && !!source)
          }
          groupFooters={groupFooters}
          guidance={connectionGuidance}
          guidanceOwner={JSON.stringify([viewKey, program])}
          onGuidanceReturn={
            active && directory && !source ? recheck : undefined
          }
          apiUnavailableReason={
            apiState === "unsupported" ? apiUnavailableReason : undefined
          }
          onChange={chooseConnection}
        />
      )}
      {showPicker && primary && !connection?.onPrimaryChange && (
        <button
          className="btn btn-primary"
          disabled={primary.disabled}
          onClick={primary.run}
        >
          {primary.label}
        </button>
      )}
      {(fieldVisible ||
        (showPicker &&
          !apiSelected &&
          selectedMethod &&
          (authMethodReadOnly(selectedMethod) ||
            authMethodUnavailable(selectedMethod)))) &&
        selectedMethod &&
        ((method) => {
          const readOnly = authMethodReadOnly(method);
          const unavailable = authMethodUnavailable(method);
          return (
            <div key={method.id}>
              <div className="agent-account-action">
                <div>
                  {unavailable && <p className="auth-note">{unavailable}</p>}
                  {method.kind === "environment" &&
                    !!method.envNames?.length && (
                      <div className="auth-note">
                        <p>{S.environmentNames}</p>
                        <ul>
                          {method.envNames.map((name) => (
                            <li key={name}>
                              <code>{name}</code>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                </div>
                {!readOnly && methodPrimary && !connection?.onPrimaryChange && (
                  <button
                    className="btn btn-primary"
                    disabled={methodPrimary.disabled}
                    onClick={methodPrimary.run}
                  >
                    {methodPrimary.label}
                  </button>
                )}
              </div>
              {method.kind === "api-key" &&
                method.apiKeyProvider &&
                directory &&
                stage === "account" && (
                  <MethodApiKeySection
                    key={JSON.stringify([
                      agentId,
                      method.id,
                      method.apiKeyProvider,
                      directory,
                      source,
                    ])}
                    agentId={agentId}
                    methodId={method.id}
                    provider={method.apiKeyProvider}
                    startLabel={
                      loginAgain(method) ? R.keyVerify : R.verifyConnect
                    }
                    cwd={directory}
                    source={source}
                    disabled={
                      occupied || workBlocked || !!source || !!unavailable
                    }
                    onAcquire={acquireManual}
                    onStart={(credential) =>
                      runWithConnection(method, (fresh) =>
                        start(fresh, false, false, false, credential, true),
                      )
                    }
                    onPrimaryChange={
                      connection?.onPrimaryChange ? setKeyPrimary : undefined
                    }
                  />
                )}
            </div>
          );
        })(selectedMethod)}
      {!authActive(job) &&
        info &&
        methods.length === 0 &&
        !completedSummary &&
        !apiSelected && (
          <>
            <AgentAccountLinks
              active={active}
              agentId={agentId}
              agentName={card?.name ?? agentId}
              websiteUrl={
                card?.presentation?.sourceUrl ??
                card?.sourceUrl ??
                card?.installGuide
              }
              onReturn={registrationReturn}
              disabled={
                occupied || busy || workBlocked || !directory || !!source
              }
            />
            <details className="agent-account-more">
              <summary>{P.moreLogin}</summary>
              <ManualAuthSection
                agentId={agentId}
                methodId="manual"
                disabled={
                  occupied || busy || workBlocked || !directory || !!source
                }
                onAcquire={acquireManual}
                onInvalidate={() => {
                  invalidateAuthentication(agentId);
                }}
                onRun={() => start({ id: "manual", kind: "terminal" }, true)}
              />
            </details>
          </>
        )}
      {!authActive(job) && !apiSelected && (
        <AgentAuthManage
          accountOptions={accountOptions}
          modelsAvailable={modelsAvailable}
          canOpenModels={canOpenModels}
          managed={!!connection}
          occupied={occupied}
          busy={busy}
          workBlocked={workBlocked}
          checkBlocked={checkBlocked}
          directoryReady={!!directory}
          onOpenModels={openModels}
          onRecheck={() => void recheck()}
          onChangeConnection={changeConnection}
          completedLabel={
            completedSummary && completedMethod
              ? completedMethod.apiKeyProvider
                ? R.keyManage
                : completedMethod.kind === "terminal"
                  ? R.reopen
                  : S.loginAgain
              : null
          }
          completedDisabled={occupied || workBlocked || !!source}
          onManageCompleted={() => {
            setChangingConnection(true);
            setStage("account");
          }}
          canLogout={!!info?.canLogout}
          canSwitch={canSwitchAccount}
          accountExitAvailable={accountExitAvailable}
          onAccountExit={chooseAccountExit}
        />
      )}
      {!authActive(job) && accountExit && (
        <AgentAccountExit
          intent={accountExit}
          available={accountExitAvailable}
          onCancel={() => setAccountExit(null)}
          onConfirm={confirmAccountExit}
        />
      )}
    </section>
  );
}
