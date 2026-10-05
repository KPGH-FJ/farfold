import { useEffect, useRef, useState, type ReactNode } from "react";
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
import type { AccountRegistrationProgress } from "../runtime/account_registration";
import { AgentPreparationActions } from "./AgentPreparationActions";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";
import {
  getAgentPreparation,
  type PreparationAction,
} from "../runtime/preparation";
import {
  authMethodReadOnly,
  authMethodUnavailable,
  authMethodLabel,
} from "../runtime/auth_method";
import type { ApiConfigurationState } from "../runtime/service_capability";
import { MethodApiKeySection } from "./MethodApiKeySection";
import { AgentConnectionPicker } from "./AgentConnectionPicker";
import { AgentAccountHeading } from "./AgentAccountHeading";
import { CONNECTION_STRINGS as R } from "../runtime/r5_auth_strings";
import {
  useAccessPrimary,
  type AgentAccessPrimary,
} from "../runtime/access_primary";
import "../r5-agent-access.css";

export interface AgentConnectionPresentation {
  choice: "existing" | "login" | "api";
  stage: "method" | "account" | "api";
  apiAvailable: boolean;
  actionId?: string | null;
  onActionChange?: (id: string | null) => void;
  onChoice: (
    choice: "existing" | "login" | "api",
    methodId?: string,
    actionId?: string,
  ) => void;
  onStageChange: (stage: "method" | "account" | "api") => void;
  apiContent: ReactNode;
  apiSummary?: ReactNode;
  onUseExisting?: () => void;
  onPrimaryChange?: (action: AgentAccessPrimary | null) => void;
}

export interface AgentAuthSectionProps {
  agentId: string;
  cwd?: string | null;
  source?: string;
  apiState?: ApiConfigurationState;
  methodId?: string | null;
  onMethodChange?: (methodId: string) => void;
  onConfigureKey: () => void;
  onChanged: () => Promise<void>;
  onReconnect: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  program?: string;
  onOpenModels?: () => void;
  canOpenModels?: boolean;
  onOpenConversation?: (threadKey: string) => void;
  focused?: boolean;
  active?: boolean;
  registration?: AccountRegistrationProgress;
  onRegistrationChange?: (
    value: AccountRegistrationProgress | undefined,
  ) => void;
  connection?: AgentConnectionPresentation;
}
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

/** Shared account operation state survives navigation; only this view is local. */
export function AgentAuthSection({
  agentId,
  cwd,
  source,
  apiState = "unknown",
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
  registration,
  onRegistrationChange,
  connection,
}: AgentAuthSectionProps) {
  const [loadedInfo, setInfo] = useState<AuthMethodsResponse | null>(null);
  const [defaultDirectory, setDirectory] = useState<string | null>(cwd ?? null);
  const directory = cwd === undefined ? defaultDirectory : cwd;
  const targetKey = JSON.stringify([agentId, directory, source ?? null]);
  const target = useRef(targetKey);
  const currentView = useRef("");
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
  const methods = (info?.methods ?? []).filter(
    (method) =>
      method.kind !== "api-key" ||
      !!method.apiKeyProvider ||
      apiState !== "unsupported",
  );
  const [error, setError] = useState<string | null>(null);
  const [methodsError, setMethodsError] = useState<string | null>(null);
  const visibleError = error ?? methodsError;
  const [reload, setReload] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [finishConfirmation, setFinishConfirmation] = useState<string | null>(
    null,
  );
  const finishConsent = useRef<string | null>(null);
  const [manualBusy, setManualBusy] = useState(false);
  const [actions, setActions] = useState<PreparationAction[]>([]);
  const [actionsError, setActionsError] = useState<string | null>(null);
  const [actionRevision, retryActions] = useState(0);
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
  const [accountExit, setAccountExit] = useState<"logout" | "switch" | null>(
    null,
  );
  const manualOwned = useRef(false);
  const job = useAuthenticationActivity(agentId);
  const finishKey = JSON.stringify([job?.attemptId, targetKey]);
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
  }, [agentId, directory, source]);
  useEffect(() => {
    let current = true;
    setActions([]);
    setActionsError(null);
    void getAgentPreparation(agentId)
      .then((value) => {
        if (current) setActions(value.actions ?? []);
      })
      .catch((reason) => {
        if (current) setActionsError(uiError(reason, C.loadFailed));
      });
    return () => {
      current = false;
    };
  }, [agentId, program, actionRevision]);
  useEffect(() => {
    finishConsent.current = null;
    setFinishConfirmation(null);
  }, [targetKey, job?.attemptId]);
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
  ) => {
    if (
      !directory ||
      target.current !== targetKey ||
      currentView.current !== viewKey ||
      (!manual && !logout && stage !== "account") ||
      (!manual && methodsOwner.current !== targetKey) ||
      (!logout && !methodIsCurrent(method, manual)) ||
      occupied ||
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
    start(
      { id: "logout", kind: "agent" },
      false,
      true,
      accountExit === "switch",
    );
  };
  const continueLogin = (method: AuthMethodInfo) => {
    if (
      target.current !== targetKey ||
      methodsOwner.current !== targetKey ||
      !methodIsCurrent(method) ||
      authMethodUnavailable(method) ||
      (method.kind === "api-key" &&
        (method.apiKeyProvider || apiState === "unsupported")) ||
      !directory ||
      occupied ||
      source ||
      hasCurrentWork()
    )
      return;
    if (method.kind === "api-key") onConfigureKey();
    else start(method);
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
    !authActive(job) && requestedStage === "account" && missingChoice
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
  const terminalChoices =
    methods.filter((method) => method.kind === "terminal").length +
    actions.length;
  const methodTitle = (method: AuthMethodInfo) =>
    method.kind === "terminal"
      ? terminalChoices > 1
        ? `${R.terminal} · ${authMethodLabel(method, methods)}`
        : R.terminal
      : method.apiKeyProvider === "openai"
        ? R.openaiKey
        : authMethodLabel(method, methods);
  const connectionOptions = [
    ...methods
      .filter(
        (method) =>
          !authMethodReadOnly(method) && !authMethodUnavailable(method),
      )
      .map((method) => ({
        id: JSON.stringify(["method", method.id]),
        title: methodTitle(method),
        description:
          method.kind === "terminal"
            ? R.terminalHint
            : method.apiKeyProvider === "openai"
              ? R.openaiKeyHint
              : method.kind === "api-key"
                ? R.keyHint
                : R.accountHint,
        disabled: false,
      })),
    ...actions.map((action) => ({
      id: JSON.stringify(["action", action.id]),
      title:
        terminalChoices > 1
          ? `${R.terminal} · ${R.serviceTerminal}`
          : R.terminal,
      description: R.terminalHint,
      disabled: false,
    })),
    ...(connection && apiState !== "unsupported"
      ? [
          {
            id: JSON.stringify(["api"]),
            title: R.api,
            description: R.apiHint,
            disabled: !connection.apiAvailable,
          },
        ]
      : []),
  ];
  const optionValue = apiSelected
    ? JSON.stringify(["api"])
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
    setLocalStage("method");
    if (kind === "api") connection?.onChoice("api");
    else if (kind === "action" && id) {
      setLocalActionId(id);
      setSelectedMethodId(null);
      connection?.onChoice("existing", undefined, id);
    } else if (kind === "method" && id) {
      setLocalActionId(null);
      setSelectedMethodId(id);
      if (connection) connection.onChoice("login", id);
      else onMethodChange?.(id);
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
  const continueMethod = () => {
    if (!selectedMethod || occupied || workBlocked || !directory || source)
      return;
    if (stage === "method") {
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
      setStage("account");
    } else continueLogin(selectedMethod);
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
          label:
            stage === "method"
              ? R.continue
              : selectedMethod.kind === "terminal"
                ? R.terminalStart
                : loginAgain(selectedMethod)
                  ? S.loginAgain
                  : R.accountContinue(methodTitle(selectedMethod)),
          disabled: occupied || workBlocked || !directory || !!source,
          run: continueMethod,
        }
      : null;
  const primary =
    authActive(job) || completedSummary || showApiSummary || existingSummary
      ? null
      : apiSelected && stage === "method"
        ? {
            id: JSON.stringify([targetKey, "api"]),
            label: R.continue,
            disabled: occupied || workBlocked || !connection?.apiAvailable,
            run: () => setStage("api"),
          }
        : selectedAction
          ? stage === "method"
            ? {
                id: JSON.stringify([targetKey, "action", selectedAction.id]),
                label: R.continue,
                disabled: occupied || workBlocked || !directory || !!source,
                run: () => setStage("account"),
              }
            : preparationPrimary
          : selectedMethod?.apiKeyProvider && stage === "account"
            ? keyPrimary
            : methodPrimary;
  useAccessPrimary(primary, connection?.onPrimaryChange);
  const accountOptions =
    selectedMethod && !apiSelected
      ? (() => {
          const method = selectedMethod;
          const readOnly = authMethodReadOnly(method);
          const unavailable = authMethodUnavailable(method);
          return (
            <details className="journey-details agent-account-more">
              <summary>{P.accountLinks}</summary>
              <AgentAccountLinks
                active={active}
                agentId={agentId}
                methodId={method.id}
                registration={registration}
                onRegistrationChange={onRegistrationChange}
                onContinueLogin={
                  stage !== "account" || readOnly || method.apiKeyProvider
                    ? undefined
                    : () => continueLogin(method)
                }
                loginDisabled={
                  occupied ||
                  workBlocked ||
                  !directory ||
                  !!source ||
                  !!unavailable
                }
                loginHint={
                  source
                    ? S.api
                    : workBlocked
                      ? S.workHint
                      : (unavailable ?? undefined)
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
              : completedSummary || existingSummary
                ? R.current
                : ((authActive(job) || selectedJob) && job?.terminal) ||
                    selectedAction ||
                    selectedMethod?.kind === "terminal"
                  ? R.terminal
                  : selectedMethod
                    ? methodTitle(selectedMethod)
                    : R.methods
        }
        onBack={stage === "method" ? undefined : changeConnection}
        disabled={occupied || workBlocked}
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
      {!selectedJob &&
        !apiSelected &&
        connectionCheck?.targetKey === targetKey && (
          <p className="auth-note" role="status">
            {connectionCheck.phase === "checking"
              ? S.accountChecking
              : A.connectionChecked}
          </p>
        )}
      {existingSummary && (
        <div className="journey-connection-summary">
          <strong>{R.existing}</strong>
          <span>{R.existingStatus}</span>
        </div>
      )}
      {completedSummary && (
        <div className="journey-connection-summary">
          <strong>{summaryTitle}</strong>
          <span role="status">{summaryStatus}</span>
        </div>
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
                {job.terminal &&
                  job.phase !== "cancelling" &&
                  finishConfirmation !== finishKey && (
                    <button
                      className="btn btn-primary"
                      disabled={!finishAllowed}
                      onClick={() => {
                        if (canFinishNow(job.attemptId)) {
                          finishConsent.current = finishKey;
                          setFinishConfirmation(finishKey);
                        }
                      }}
                    >
                      {S.finish}
                    </button>
                  )}
              </div>
            )}
            {job.terminal &&
              authActive(job) &&
              job.phase !== "checking" &&
              job.phase !== "cancelling" &&
              finishConfirmation === finishKey && (
                <section aria-label={S.finishConfirm}>
                  <p className="auth-note">{S.finishConfirmHint}</p>
                  <div className="auth-actions">
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        finishConsent.current = null;
                        setFinishConfirmation(null);
                      }}
                    >
                      {S.finishBack}
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={!finishAllowed}
                      onClick={() => {
                        if (
                          finishConsent.current !== finishKey ||
                          !canFinishNow(job.attemptId)
                        )
                          return;
                        finishConsent.current = null;
                        setFinishConfirmation(null);
                        void activity.finishTerminal();
                      }}
                    >
                      {S.finishConfirm}
                    </button>
                  </div>
                </section>
              )}
          </div>
        )}
      {!apiSelected && (
        <AgentPreparationActions
          agentId={agentId}
          cwd={directory}
          source={source}
          program={program}
          disabled={occupied || workBlocked}
          onRun={startPreparation}
          data={{
            actions,
            error: actionsError,
            onRetry: () => retryActions((value) => value + 1),
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
        !connectionOptions.length && <div className="auth-note">{A.none}</div>}
      {showPicker && info && !!connectionOptions.length && (
        <AgentConnectionPicker
          name={`connection-${agentId}`}
          options={connectionOptions}
          value={optionValue}
          disabled={occupied || workBlocked || (!connection && !!source)}
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
                {method.kind === "terminal" && stage === "account" && (
                  <>
                    <ol className="terminal-steps" aria-label={R.terminal}>
                      {R.terminalSteps.map((title, index) => (
                        <li
                          key={title}
                          aria-current={index === 0 ? "step" : undefined}
                        >
                          <span aria-hidden="true">{index + 1}</span>
                          {title}
                        </li>
                      ))}
                    </ol>
                    <details className="journey-details">
                      <summary>{R.details}</summary>
                      <p className="auth-note">
                        {S.source}：{directory}
                      </p>
                    </details>
                  </>
                )}
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
                      start(method, false, false, false, credential)
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
      {!authActive(job) && !apiSelected && (
        <details className="journey-details agent-account-more">
          <summary>{R.manage}</summary>
          {accountOptions}
          <div className="auth-actions journey-utilities">
            {modelsAvailable && onOpenModels && !connection && (
              <button
                className="btn btn-text"
                disabled={
                  !canOpenModels || occupied || workBlocked || checkBlocked
                }
                onClick={openModels}
              >
                {S.models}
              </button>
            )}
            <button
              className="btn btn-text"
              disabled={occupied || checkBlocked || !directory}
              onClick={() => void recheck()}
            >
              {R.connection}
            </button>
            <button
              className="btn btn-text"
              disabled={occupied || workBlocked}
              onClick={changeConnection}
            >
              {R.change}
            </button>
            {connection?.onUseExisting && !existingSummary && (
              <button
                className="btn btn-text"
                disabled={occupied || workBlocked}
                onClick={connection.onUseExisting}
              >
                {R.existing}
              </button>
            )}
            {completedSummary && completedMethod && (
              <button
                className="btn btn-text"
                disabled={occupied || workBlocked || !!source}
                onClick={() => {
                  setChangingConnection(true);
                  setStage("account");
                }}
              >
                {completedMethod.apiKeyProvider
                  ? R.keyManage
                  : completedMethod.kind === "terminal"
                    ? R.reopen
                    : S.loginAgain}
              </button>
            )}
            {info?.canLogout && (
              <>
                <button
                  className="btn btn-text"
                  disabled={!accountExitAvailable}
                  onClick={() => chooseAccountExit("logout")}
                >
                  {A.logout}
                </button>
                {canSwitchAccount && (
                  <button
                    className="btn btn-text"
                    disabled={!accountExitAvailable}
                    onClick={() => chooseAccountExit("switch")}
                  >
                    {S.switchAccount}
                  </button>
                )}
              </>
            )}
          </div>
        </details>
      )}
      {!authActive(job) && accountExit && (
        <section
          aria-label={accountExit === "switch" ? S.switchAccount : A.logout}
        >
          <p className="auth-note">
            {accountExit === "switch" ? S.switchHint : S.logoutHint}
          </p>
          <div className="auth-actions">
            <button
              className="btn btn-ghost"
              onClick={() => setAccountExit(null)}
            >
              {STRINGS.access.cancel}
            </button>
            <button
              className="btn btn-primary"
              disabled={!accountExitAvailable}
              onClick={confirmAccountExit}
            >
              {accountExit === "switch" ? S.switchConfirm : S.confirmLogout}
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
