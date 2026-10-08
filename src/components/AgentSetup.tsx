import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { X } from "@phosphor-icons/react";
import {
  preparationConnection,
  type AgentCardModel,
  type AgentsState,
  type AuthMethodsResponse,
} from "../runtime/agents";
import { isAutomaticConnectionAllowed } from "../runtime/connection_intent";
import { ACCESS_STRINGS as S } from "../runtime/access_strings";
import { STRINGS } from "../runtime/strings";
import { programProgress } from "../runtime/program_progress";
import { AGENT_SETUP_STRINGS as M } from "../runtime/agent_setup_strings";
import {
  authenticationRequired,
  useAuthentication,
  useAuthenticationActivity,
} from "../runtime/authentication";
import {
  getServiceCapabilities,
  listCredentials,
  subscribeCredentialChanges,
  type Credential,
  type ServiceCapability,
} from "../runtime/credentials";
import { uiError } from "../runtime/ui_error";
import { AgentAuthSection } from "./AgentAuthSection";
import { useModalDialog } from "./useModalDialog";
import { useSetupAuthFocus } from "./useSetupAuthFocus";
import { useProgramInventory } from "./ProgramManager";
import { agentSetupProgram } from "./AgentSetupProgram";
import { AgentRemoveDialog } from "./AgentRemoveDialog";
import {
  agentSetupCurrentSelection,
  agentSetupModelOptions,
  agentSetupModelReview,
  agentSetupTestNote,
} from "./AgentSetupModels";
import { AgentLogo } from "./AgentLogo";
import type { ServiceChoice } from "./ServicePicker";
import { AgentServiceSection } from "./AgentServiceSection";
import { ServiceModelPicker } from "./ServiceModelPicker";
import { apiConfigurationState } from "../runtime/service_capability";
import { AgentPrerequisites } from "./AgentPrerequisites";
import { AgentModelReadNotice } from "./AgentModelReadNotice";
import { modelConfigOption, threads, useThread } from "../runtime/sessions";
import type { ConversationRepairContext } from "../runtime/agent_repair";
import { isReasoningOption } from "./ReasoningControl";
import {
  preparationProgram,
  preparationMatches,
  preparationContextMatches,
  preparationRequestMatches,
  preparationReadMatches,
  preparationNeedsExplicitRead,
  preparationPhaseLabel,
  testInProgress,
  usePreparation,
} from "../runtime/agent_preparation";
import { useWorkPolicy } from "../runtime/work_policy";
import { authActive } from "../runtime/auth_activity";
import { authenticationWorkBlockers } from "../runtime/auth_blockers";
import { SETUP_PRESENTATION as P } from "../runtime/setup_presentation_strings";
import { R5_SETUP_STRINGS as R } from "../runtime/r5_setup_strings";
import type { AgentAccessPrimary } from "../runtime/access_primary";
import { AgentSetupNavigation } from "./AgentSetupNavigation";
import { SENDING_STRINGS } from "../runtime/sending_strings";
import { WORKSPACE_STRINGS } from "../runtime/workspace_strings";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";
import { agentStatus } from "../runtime/agent_status";
import { setupStorage } from "../runtime/setup_storage";
import type { InstallationInput } from "../runtime/installation_input";
import { useInstallationReview } from "./AgentInstallOptions";
import "../agent-setup-presentation.css";

export interface AgentSetupSelection {
  service: ServiceChoice | null;
  config: Record<string, unknown>;
}
const EMPTY_SELECTION: AgentSetupSelection = { service: null, config: {} };

type AccessChoice = "existing" | "login" | "api";
export interface AgentSetupProgress {
  step: number;
  choice: AccessChoice;
  accessStage?: "method" | "account" | "api";
  selection?: AgentSetupSelection;
  authMethodId?: string;
  preparationActionId?: string;
  installationInput?: InstallationInput;
  /** A rejected persisted installation field must not become implicit omission. */
  installationInputInvalid?: boolean;
}
export const initialAgentSetupProgress = (
  selection?: AgentSetupSelection,
  connected = false,
): AgentSetupProgress => ({
  step: !connected
    ? 0
    : selection?.service || Object.keys(selection?.config ?? {}).length
      ? 2
      : 1,
  choice: selection?.service ? "api" : "existing",
  accessStage: selection?.service ? "api" : "method",
  selection,
});

export function AgentSetup({
  card,
  agents,
  onClose,
  onStart,
  onOpenApi,
  active = true,
  progress: setupProgress,
  onProgress,
  onImport,
  onOpenConversation,
  onConfirmManagement,
  cwd: entryCwd,
  returnLabel = S.useSelection,
  locationLabel,
  intent = "use",
  conversation,
  sourceContext,
}: {
  conversation?: ConversationRepairContext;
  sourceContext?: string;
  intent?: "use" | "manage";
  cwd?: string | null;
  returnLabel?: string;
  locationLabel?: string;
  card: AgentCardModel;
  agents: AgentsState;
  onClose: () => void;
  onStart: (
    agentId: string,
    selection?: AgentSetupSelection,
  ) => void | Promise<void>;
  onOpenApi: (agentId?: string) => void;
  active?: boolean;
  progress: AgentSetupProgress;
  onProgress: (progress: AgentSetupProgress) => void;
  onImport?: (agentId: string, opener?: HTMLElement) => void;
  onOpenConversation?: (threadKey: string) => void;
  onConfirmManagement?: (
    agentId: string,
    selection: AgentSetupSelection,
  ) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { controller, state: test } = usePreparation(card.id);
  const testThread = useThread(test.threadKey);
  const choice = conversation?.sourceContext ? "api" : setupProgress.choice;
  const connected = card.status === "connected";
  const setStep = (value: number) =>
    updateAccess({
      step: value,
      ...(value === 1 && step === 0 && !conversation && !authBusy
        ? { accessStage: "method" as const }
        : {}),
    });
  const selection = setupProgress.selection ?? EMPTY_SELECTION;
  const installation = useInstallationReview(setupProgress, onProgress);
  const setChoice = (
    value: AccessChoice,
    authMethodId?: string,
    preparationActionId?: string,
  ) => {
    if (conversation || authBusy || operationPending) return;
    setServiceEditing(false);
    if (value !== choice && (value === "api" || choice === "api"))
      controller.invalidate();
    updateAccess({
      choice: value,
      accessStage: "method",
      authMethodId,
      preparationActionId,
      selection:
        value === "api" || !selection.service
          ? selection
          : { service: null, config: {} },
    });
  };
  const setService = (service: ServiceChoice | null) => {
    if (conversation || authBusy || operationPending) return;
    setServiceEditing(false);
    controller.invalidate();
    updateAccess({ selection: { service, config: {} } });
  };
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [modelChanging, setModelChanging] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [serviceEditing, setServiceEditing] = useState(false);
  useEffect(() => setServiceEditing(false), [card.id]);
  const modelChange = useRef(0);
  const latestEntry = useRef("");
  const modelReadConfirmation = useRef(false);
  const latestProgress = useRef(setupProgress);
  const modelNavigation = useRef(false);
  latestProgress.current = setupProgress;
  const updateAccess = (change: Partial<AgentSetupProgress>) => {
    const next = { ...latestProgress.current, ...change };
    latestProgress.current = next;
    onProgress(next);
  };
  const [authInfo, setAuthInfo] = useState<AuthMethodsResponse | null>(null);
  useEffect(() => setAuthInfo(null), [card.id]);
  const [reportedAuthBusy, setAuthBusy] = useState(false);
  const [accountPrimary, setAccountPrimary] =
    useState<AgentAccessPrimary | null>(null);
  const authJob = useAuthenticationActivity(card.id);
  const authBusy = reportedAuthBusy || authActive(authJob);
  const step =
    connected || authJob || authBusy ? Math.min(setupProgress.step, 2) : 0;
  const [loadedCapability, setCapability] = useState<{
    agentId: string;
    value: ServiceCapability;
  } | null>(null);
  const capability =
    loadedCapability?.agentId === card.id ? loadedCapability.value : null;
  const [capabilityError, setCapabilityError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [services, setServices] = useState<Credential[]>([]);
  const [cwd, setCwd] = useState<string | null>(entryCwd ?? null);
  const [defaultCwd, setDefaultCwd] = useState<string | null>(null);
  const displayLocation =
    cwd && cwd === defaultCwd
      ? WORKSPACE_STRINGS.normalConversation
      : (locationLabel ?? cwd);
  const [directoryRevision, retryDirectory] = useState(0);
  const [prerequisitesReady, setPrerequisitesReady] = useState(false);
  const [installPrerequisitesReady, setInstallPrerequisitesReady] =
    useState(false);
  const [prerequisitesBusy, setPrerequisitesBusy] = useState(false);
  const work = useWorkPolicy(cwd);
  const targetCwd = work.ready ? work.cwd : undefined;
  const prepConnected = !!preparationConnection(
    agents.statuses?.[card.id],
    cwd,
  );
  const program = preparationProgram(card);
  const testing = testInProgress(test.phase);
  const model = testThread ? modelConfigOption(testThread.configOptions) : null;
  useEffect(
    () => subscribeCredentialChanges(() => setRevision((value) => value + 1)),
    [],
  );
  const inventory = useProgramInventory(card, agents.busy[card.id]);
  const authentication = useAuthentication();
  const registered = connected || card.status === "installed";
  const needsProgramInstall = !registered && !card.registerable;
  const busy =
    finishing || connecting || prerequisitesBusy || !!agents.busy[card.id];
  const progress = programProgress(
    agents.busy[card.id],
    agents.installProgress[card.id],
  );
  const selectedService = services.find(
    (item) => item.id === (conversation?.service?.id ?? selection.service?.id),
  );
  const sourceValid =
    choice !== "api" ||
    !!(
      selection.service &&
      selectedService?.complete &&
      !selectedService.deleting &&
      selectedService.revision === selection.service.revision &&
      capability?.apiTypes.includes(selectedService.apiType) &&
      selectedService.models.length
    );
  const modelValid =
    sourceValid &&
    (choice !== "api" ||
      !!(
        selection.service?.model &&
        selectedService?.models.includes(selection.service.model)
      ));

  useEffect(() => {
    let current = true;
    setCwd(entryCwd ?? null);
    setError(null);
    void invoke<string>("app_default_working_directory")
      .then((value) => {
        if (current) {
          setDefaultCwd(value);
          if (!entryCwd) setCwd(value);
        }
      })
      .catch(() => {
        if (current && !entryCwd) setError(S.defaultDirectoryError);
      });
    return () => {
      current = false;
    };
  }, [entryCwd, directoryRevision]);
  useEffect(() => {
    if (
      !conversation &&
      test.input &&
      (test.input.program !== program || !connected)
    )
      controller.invalidate();
  }, [program, connected, controller, conversation]);
  const currentInput =
    targetCwd && !conversation && modelValid
      ? {
          agentId: card.id,
          agentName: card.name,
          cwd: targetCwd,
          program,
          service: selection.service,
          config: selection.config,
          readOptionsOnly: true,
        }
      : null;
  const entryKey = JSON.stringify(currentInput);
  latestEntry.current = entryKey;
  const sameSource =
    !!currentInput &&
    (preparationMatches(test, currentInput) ||
      preparationReadMatches(test, currentInput) ||
      (modelChanging && preparationContextMatches(test, currentInput)));
  const selectionMismatch =
    sameSource &&
    !!testThread &&
    !test.readError &&
    !modelChanging &&
    !!currentInput &&
    !preparationMatches(test, currentInput);
  const explicitReadRequired =
    !!currentInput && preparationNeedsExplicitRead(test, currentInput);
  const modelReadFailed =
    test.phase === "failed" &&
    !!currentInput &&
    preparationRequestMatches(test, currentInput) &&
    (!test.threadKey ||
      !!test.readError ||
      !preparationMatches(test, currentInput) ||
      explicitReadRequired);
  const operationPending =
    testing ||
    modelChanging ||
    test.phase === "unknown" ||
    !controller.canPrepare();
  const waitingForOtherSource = !sameSource && operationPending;
  const passed =
    sameSource && prerequisitesReady && controller.verified(program);
  const source =
    conversation?.sourceContext ??
    (selection.service
      ? (sourceContext ??
        (sameSource ? testThread?.serviceContext : undefined) ??
        JSON.stringify(selection.service))
      : undefined);
  const needsAuth =
    authenticationRequired(authentication, card.id, cwd, source) ||
    (!!targetCwd &&
      targetCwd !== cwd &&
      authenticationRequired(authentication, card.id, targetCwd, source));
  useSetupAuthFocus({
    active,
    connected,
    required: needsAuth,
    agentId: card.id,
    cwd,
    source,
    progress: setupProgress,
    onProgress,
  });
  const apiState = apiConfigurationState(capability);
  const apiAvailable = apiState === "supported";
  const accountStage =
    setupProgress.accessStage ??
    (choice === "api"
      ? "api"
      : setupProgress.authMethodId || setupProgress.preparationActionId
        ? "account"
        : "method");
  const accountChecked =
    choice !== "api" &&
    accountStage === "account" &&
    authJob?.phase === "completed" &&
    authJob.checked &&
    authJob.target.agentId === card.id &&
    (authJob.target.cwd === cwd || authJob.target.cwd === targetCwd) &&
    (authJob.target.source ?? null) === (source ?? null) &&
    (authJob.operation.kind !== "authentication" ||
      !["logout", "switch_account"].includes(
        authJob.operation.intent ?? "login",
      )) &&
    ((choice === "login" &&
      authJob.operation.kind === "authentication" &&
      authJob.operation.methodId === setupProgress.authMethodId) ||
      (choice === "existing" &&
        authJob.operation.kind === "preparation" &&
        authJob.operation.actionId === setupProgress.preparationActionId));
  const canContinueModel =
    (choice === "api" &&
      accountStage === "api" &&
      sourceValid &&
      !serviceEditing) ||
    accountChecked ||
    (choice === "existing" &&
      accountStage === "account" &&
      !setupProgress.authMethodId &&
      !setupProgress.preparationActionId &&
      !needsAuth);
  const returnBlocked =
    busy ||
    modelReadFailed ||
    selectionMismatch ||
    explicitReadRequired ||
    modelChanging ||
    authBusy ||
    !cwd ||
    !connected ||
    !prerequisitesReady ||
    !modelValid ||
    (!conversation &&
      step === 2 &&
      (!sameSource || !testThread || !!test.readError)) ||
    needsAuth ||
    operationPending ||
    (sameSource &&
      (!!testThread?.modelDrift ||
        !!testThread?.sourceError ||
        !!testThread?.configError ||
        !!testThread?.configuring));
  const nextStep =
    step === 0 || (!conversation && step === 1) ? step + 1 : null;
  const nextBlocked =
    busy ||
    authBusy ||
    operationPending ||
    !connected ||
    !prerequisitesReady ||
    (step === 1 && (!sourceValid || needsAuth));
  const canOpenModels =
    canContinueModel && !nextBlocked && !!cwd && sourceValid && !needsAuth;
  modelNavigation.current = canOpenModels;
  /** Saved-settings reuse is verified in place, before the user reaches models. */
  const existingVerifyActive =
    !conversation &&
    step === 1 &&
    prepConnected &&
    choice === "existing" &&
    accountStage === "account" &&
    !setupProgress.authMethodId &&
    !setupProgress.preparationActionId &&
    !needsAuth &&
    !authBusy;
  const existingVerifyReady =
    existingVerifyActive &&
    sameSource &&
    !!testThread &&
    !test.readError &&
    !explicitReadRequired &&
    !modelReadFailed;
  const verifyArmed = useRef(false);
  const wasVerifying = useRef(false);
  useEffect(() => {
    if (existingVerifyActive && !wasVerifying.current && intent === "use")
      verifyArmed.current = true;
    if (!existingVerifyActive) verifyArmed.current = false;
    wasVerifying.current = existingVerifyActive;
  }, [existingVerifyActive, intent]);
  useEffect(() => {
    if (verifyArmed.current && existingVerifyReady) {
      verifyArmed.current = false;
      onProgress({ ...latestProgress.current, step: 2 });
    }
  }, [existingVerifyReady, onProgress]);
  useEffect(() => {
    if (
      sameSource &&
      !selectionMismatch &&
      !modelReadFailed &&
      !test.readError &&
      !modelChanging &&
      !authBusy &&
      test.threadKey &&
      JSON.stringify(selection.config) !== JSON.stringify(test.config)
    )
      onProgress({
        ...setupProgress,
        selection: { service: selection.service, config: test.config },
      });
  }, [
    sameSource,
    selectionMismatch,
    modelReadFailed,
    modelChanging,
    authBusy,
    test.readError,
    test.config,
    test.threadKey,
  ]);
  const preparationInput = () => currentInput;
  useEffect(() => {
    if (
      !active ||
      conversation ||
      modelChanging ||
      authBusy ||
      explicitReadRequired ||
      needsAuth ||
      waitingForOtherSource ||
      !(step === 2 || existingVerifyActive) ||
      !connected ||
      !prerequisitesReady ||
      !modelValid ||
      !cwd ||
      !work.enabled(card.id)
    )
      return;
    const input = preparationInput();
    if (input) void controller.prepare(input);
  }, [
    active,
    conversation,
    modelChanging,
    authBusy,
    explicitReadRequired,
    needsAuth,
    waitingForOtherSource,
    step,
    connected,
    prerequisitesReady,
    modelValid,
    targetCwd,
    cwd,
    work.ready,
    work.enabled(card.id),
    program,
    selection.service,
    selection.config,
    controller,
  ]);
  useEffect(() => {
    if (sameSource && choice === "api" && capability !== null && !modelValid)
      controller.invalidate();
  }, [sameSource, choice, capability, modelValid, controller]);

  const { onCancel } = useModalDialog({
    dialogRef: dialog,
    open: active,
    onDismiss: onClose,
  });
  useEffect(() => {
    let active = true;
    const agentId = card.id;
    setCapabilityError(false);
    setCapability(null);
    setServices([]);
    void Promise.allSettled([
      getServiceCapabilities(agentId),
      listCredentials(),
    ]).then(([result, records]) => {
      if (!active) return;
      if (result.status === "fulfilled")
        setCapability({ agentId, value: result.value });
      if (records.status === "fulfilled") setServices(records.value);
      setCapabilityError(
        result.status === "rejected" || records.status === "rejected",
      );
    });
    return () => {
      active = false;
    };
  }, [card.id, card.status, revision]);

  const connect = async (reconnect = false) => {
    if (!reconnect && (busy || authBusy || operationPending)) return;
    const installInput = needsProgramInstall ? installation.read() : undefined;
    if (
      !reconnect &&
      needsProgramInstall &&
      (!installPrerequisitesReady || installInput === null)
    )
      return;
    if (!reconnect && step === 0 && setupProgress.step === 1 && !conversation)
      updateAccess({ step: 0, accessStage: "method" });
    setConnecting(true);
    setError(null);
    try {
      const target =
        entryCwd ??
        cwd ??
        (await invoke<string>("app_default_working_directory"));
      if (reconnect) await agents.reconnect(card, target);
      else {
        if (needsProgramInstall && installInput)
          await agents.connect(card, target, installInput ?? undefined);
        else await agents.connect(card, target);
      }
    } catch (reason) {
      setError(uiError(reason, S.defaultDirectoryError));
      throw reason;
    } finally {
      setConnecting(false);
    }
  };
  const openApi = () => {
    if (apiState === "unsupported") return;
    // A modal must leave the top layer before the settings page can be used.
    dialog.current?.close();
    onOpenApi(card.id);
  };
  const close = onClose;
  const prepareAgain = () => {
    if (!canReadModels) return;
    const input = preparationInput();
    if (input) void controller.prepare(input, true);
  };
  const autoConnectKey = useRef("");
  useEffect(() => {
    if (
      !active ||
      conversation ||
      step !== 1 ||
      prepConnected ||
      needsProgramInstall ||
      busy ||
      authBusy ||
      operationPending ||
      !cwd ||
      !agents.statuses ||
      // Borrowed/cached declarations display without a connection; only a
      // first-time Agent with no declaration at all is connected up front.
      !authInfo ||
      authInfo.executionReady ||
      authInfo.methods.length > 0 ||
      authInfo.canLogout ||
      !isAutomaticConnectionAllowed(card.id)
    )
      return;
    const key = JSON.stringify([card.id, cwd]);
    if (autoConnectKey.current === key) return;
    autoConnectKey.current = key;
    void connect().catch(() => undefined);
  }, [
    active,
    conversation,
    step,
    prepConnected,
    needsProgramInstall,
    busy,
    authBusy,
    operationPending,
    cwd,
    card.id,
    connect,
    authInfo,
  ]);
  useEffect(
    () => () => {
      modelChange.current += 1;
    },
    [],
  );
  const pickOption = async (optionId: string, value: string) => {
    if (
      conversation ||
      !testThread ||
      modelChanging ||
      explicitReadRequired ||
      modelReadFailed
    )
      return;
    const ticket = ++modelChange.current;
    const entry = entryKey;
    const key = testThread.key;
    setModelChanging(true);
    try {
      await threads.setConfig(key, optionId, value);
      const current = threads.thread(key);
      if (
        ticket === modelChange.current &&
        latestEntry.current === entry &&
        current &&
        !current.configError
      )
        onProgress({
          ...latestProgress.current,
          selection: {
            service: selection.service,
            config: Object.fromEntries(
              current.configOptions.map((option) => [
                option.id,
                option.currentValue,
              ]),
            ),
          },
        });
    } catch {
      // The shared model control retains the returned error and previous value.
    } finally {
      if (ticket === modelChange.current) setModelChanging(false);
    }
  };
  const readingModels = sameSource && test.phase === "opening";
  // A fresh session can resolve a session-open failure. A prior prompt failure
  // still needs an explicit successful request; model options alone are weaker.
  const canReadModels =
    !busy &&
    !authBusy &&
    !modelChanging &&
    !operationPending &&
    connected &&
    prerequisitesReady &&
    modelValid &&
    !!targetCwd &&
    work.enabled(card.id);
  modelReadConfirmation.current = active && step === 2 && canReadModels;
  const testLabel = preparationPhaseLabel(test.phase);
  const importControl = onImport && (
    <button
      className="btn btn-text"
      disabled={busy || !connected || testing}
      onClick={(event) => onImport(card.id, event.currentTarget)}
    >
      {S.importConversations}
    </button>
  );
  const headerStatus = agentStatus({
    card,
    progressLabel:
      progress?.label ?? (connecting ? STRINGS.agents.connecting : null),
    accountInProgress: authBusy,
    configuring: authJob?.operation?.kind === "preparation",
    readRequired: explicitReadRequired,
    authRequired: needsAuth,
    prepared:
      !!conversation ||
      (setupStorage.completed(card.id) &&
        !!(selection.service || Object.keys(selection.config).length)),
  });
  return (
    <dialog
      ref={dialog}
      className="agent-setup-dialog"
      data-intent={intent}
      aria-labelledby="agent-setup-title"
      onCancel={onCancel}
    >
      <header className="agent-setup-header">
        <h2 id="agent-setup-title">
          <AgentLogo card={card} />
          {intent === "manage" ? P.management(card.name) : P.title(card.name)}
        </h2>
        <button className="icon-btn" aria-label={S.close} onClick={close}>
          <X size={19} />
        </button>
      </header>
      <div className="agent-setup-context">
        <span title={displayLocation ?? ""}>
          {intent === "manage" ? R.management : R.step(step)}
        </span>
        <span className={`agent-setup-status tone-${headerStatus.tone}`}>
          <i aria-hidden="true" />
          {headerStatus.label}
        </span>
      </div>
      <AgentSetupNavigation
        step={step}
        connected={connected}
        accountActive={!!authJob || authBusy}
        modelsAvailable={!!conversation || step === 2 || canContinueModel}
        onStep={setStep}
      />
      <div
        className="agent-setup-body"
        id="agent-setup-panel"
        role="tabpanel"
        aria-labelledby={`agent-setup-tab-${step}`}
      >
        {(error || agents.errors[card.id]) && (
          <div role="alert" className="ac-error">
            {error ?? agents.errors[card.id]}
            {!cwd ? (
              <button
                className="btn btn-text"
                onClick={() => retryDirectory((v) => v + 1)}
              >
                {S.retry}
              </button>
            ) : (
              step === 1 &&
              !prepConnected &&
              !connecting && (
                <button
                  className="btn btn-text"
                  onClick={() => void connect().catch(() => undefined)}
                >
                  {S.retry}
                </button>
              )
            )}
          </div>
        )}
        {waitingForOtherSource && (
          <div className="agent-setup-notice" role="status">
            <p>{S.otherTestPending}</p>
            {test.threadKey && onOpenConversation && (
              <button
                className="btn btn-ghost"
                onClick={() => {
                  dialog.current?.close();
                  onOpenConversation(test.threadKey!);
                }}
              >
                {S.testOpen}
              </button>
            )}
          </div>
        )}
        {authBusy && step !== 1 && (
          <div className="agent-setup-notice" role="status">
            <p>
              {authJob?.operation?.kind === "preparation"
                ? C.busy
                : S.loginBusy}
            </p>
            <button
              className="btn btn-ghost"
              onClick={() => onProgress({ ...setupProgress, step: 1 })}
            >
              {authJob?.operation?.kind === "preparation"
                ? C.resume
                : S.resumeLogin}
            </button>
          </div>
        )}
        {step === 0 &&
          agentSetupProgram({
            card,
            agents,
            inventory,
            installation,
            setupStep: setupProgress.step,
            registered,
            needsProgramInstall,
            prerequisitesReady,
            installPrerequisitesReady,
            busy,
            authBusy,
            operationPending,
            progress,
            intent,
            onRemoveAgent: () => setRemoving(true),
            onConnect: () => connect(),
            importControl,
          })}
        <fieldset
          className="agent-setup-program-guard"
          hidden={step !== 0}
          disabled={authBusy || operationPending}
        >
          <AgentPrerequisites
            agentId={card.id}
            refreshKey={program}
            onChange={setPrerequisitesReady}
            onInstallReadyChange={setInstallPrerequisitesReady}
            onInfoChange={installation.onInfoChange}
            onBusyChange={setPrerequisitesBusy}
            onBeforeInstall={async () => {
              controller.invalidate();
              // The install command releases safe idle connections itself and
              // rejects while any task, approval or check is unconfirmed.
              await agents.refresh();
            }}
            onInstalled={async () => {
              await Promise.all([agents.refresh(), inventory.refresh()]);
            }}
          />
        </fieldset>
        {step === 1 && (
          <>
            {needsAuth && (
              <p className="agent-setup-notice">
                {choice === "api"
                  ? S.apiAuthRequired
                  : S.authRequiredName(card.name)}
              </p>
            )}
            {conversation && (
              <div className="agent-setup-review">
                <strong>{S.source}</strong>
                <p>
                  {source
                    ? (selectedService?.label ?? STRINGS.service.unavailable)
                    : S.existing}
                </p>
                <p className="agent-setup-note">{STRINGS.repair.modelLocked}</p>
              </div>
            )}
            {!conversation && !prepConnected && !authBusy && connecting && (
              <div className="agent-setup-notice" role="status">
                <p>{P.readingMethods}</p>
              </div>
            )}
            {capabilityError && (
              <button
                className="btn btn-text"
                onClick={() => setRevision((v) => v + 1)}
              >
                {S.retry}
              </button>
            )}
            {(conversation ? authJob || authBusy || connected : true) && (
              <AgentAuthSection
                connection={
                  conversation
                    ? undefined
                    : {
                        choice,
                        stage: accountStage,
                        apiAvailable,
                        authRequired: needsAuth,
                        onChoice: setChoice,
                        onPrimaryChange: setAccountPrimary,
                        onUseExisting: () => {
                          if (authBusy || operationPending) return;
                          if (choice === "api") controller.invalidate();
                          updateAccess({
                            choice: "existing",
                            accessStage: "account",
                            authMethodId: undefined,
                            preparationActionId: undefined,
                            selection: selection.service
                              ? { service: null, config: {} }
                              : selection,
                          });
                        },
                        onStageChange: (accessStage) =>
                          updateAccess({ accessStage }),
                        existingVerify: existingVerifyActive
                          ? {
                              status: existingVerifyReady
                                ? "ready"
                                : modelReadFailed || test.readError
                                  ? "failed"
                                  : "checking",
                              error:
                                modelReadFailed || test.readError
                                  ? (test.readError ?? test.error)
                                  : null,
                              onRetry: prepareAgain,
                            }
                          : undefined,
                        actionId: setupProgress.preparationActionId ?? null,
                        onActionChange: (id) =>
                          updateAccess({
                            preparationActionId: id ?? undefined,
                            authMethodId: undefined,
                          }),
                        apiContent: (
                          <AgentServiceSection
                            agentId={card.id}
                            capability={capability}
                            error={capabilityError}
                            items={services}
                            value={selection.service}
                            onChange={setService}
                            onRetry={() => setRevision((v) => v + 1)}
                            onOpenApi={openApi}
                            disabled={operationPending || authBusy}
                            readonly={false}
                          />
                        ),
                        apiSummary:
                          sourceValid &&
                          selection.service &&
                          !serviceEditing ? (
                            <AgentServiceSection
                              agentId={card.id}
                              capability={capability}
                              error={capabilityError}
                              items={services}
                              value={selection.service}
                              onChange={setService}
                              onRetry={() => setRevision((v) => v + 1)}
                              onOpenApi={openApi}
                              disabled={operationPending || authBusy}
                              readonly={false}
                              editing={false}
                              onChangeService={() => setServiceEditing(true)}
                              onEditService={openApi}
                              onChangeMethod={() =>
                                updateAccess({ accessStage: "method" })
                              }
                            />
                          ) : undefined,
                      }
                }
                active={active}
                agentId={card.id}
                program={program}
                canOpenModels={canOpenModels}
                onOpenModels={() => {
                  if (
                    modelNavigation.current &&
                    latestEntry.current === entryKey
                  )
                    onProgress({ ...latestProgress.current, step: 2 });
                }}
                card={card}
                busy={busy}
                onConnect={async () => {
                  const target =
                    entryCwd ??
                    cwd ??
                    (await invoke<string>("app_default_working_directory"));
                  if (!(await agents.connect(card, target)))
                    throw new Error(
                      agents.errors[card.id] ??
                        STRINGS.agents.errors.connectFailed,
                    );
                }}
                onInfoChange={setAuthInfo}
                methodId={setupProgress.authMethodId ?? null}
                onMethodChange={(authMethodId) =>
                  updateAccess({
                    authMethodId,
                    preparationActionId: undefined,
                  })
                }
                cwd={cwd}
                source={source}
                apiState={apiState}
                onChanged={async () => {
                  await agents.refresh();
                }}
                onReconnect={async () => {
                  await connect(true);
                }}
                onConfigureKey={openApi}
                onBusyChange={setAuthBusy}
                onOpenConversation={
                  onOpenConversation
                    ? (key) => {
                        dialog.current?.close();
                        onOpenConversation(key);
                      }
                    : undefined
                }
              />
            )}
          </>
        )}
        {step === 2 &&
          conversation &&
          agentSetupModelReview({
            conversation,
            source,
            serviceLabel: selectedService?.label,
            displayLocation,
          })}
        {step === 2 && !conversation && (
          <section className="agent-setup-selection">
            <h3>{R.chooseModel}</h3>
            <p className="agent-setup-subtitle">
              {choice === "api" ? R.serviceModelHint : M.managementHint}
            </p>
            {choice === "api" && (
              <ServiceModelPicker
                value={selection.service}
                items={services}
                capability={capability}
                error={capabilityError}
                onChange={setService}
                onRetry={() => setRevision((v) => v + 1)}
                disabled={busy || authBusy || operationPending || modelChanging}
              />
            )}
            {intent === "use" &&
              agentSetupCurrentSelection({
                name: card.name,
                apiChoice: choice === "api",
                serviceLabel: selectedService?.label,
                displayLocation,
              })}
            {!sourceValid && (
              <div role="alert" className="agent-setup-notice">
                <p>{S.chooseCompatibleApi}</p>
                <button className="btn btn-ghost" onClick={() => setStep(1)}>
                  {S.changeSource}
                </button>
              </div>
            )}
            {needsAuth && (choice !== "api" || apiState !== "unsupported") && (
              <div role="alert" className="agent-setup-notice">
                <p>
                  {choice === "api"
                    ? S.apiAuthRequired
                    : S.authRequiredName(card.name)}
                </p>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    if (choice === "api") openApi();
                    else
                      onProgress({
                        ...setupProgress,
                        step: 1,
                        choice: "login",
                      });
                  }}
                >
                  {choice === "api" ? S.openApi : S.login}
                </button>
              </div>
            )}
            {!prerequisitesReady && (
              <p role="status" className="auth-note">
                {S.prerequisitesRequired}
              </p>
            )}
            {work.error && (
              <p role="alert" className="ac-error">
                {work.error}{" "}
                <button className="btn btn-text" onClick={work.retry}>
                  {S.retry}
                </button>
              </p>
            )}
            {cwd && work.ready && !work.enabled(card.id) && (
              <div className="agent-setup-test-note">
                <p>{S.testWorkDisabled}</p>
                <button
                  className="btn btn-ghost"
                  disabled={work.saving}
                  onClick={() =>
                    void (work.locationEnabled === false
                      ? work.setLocation(true)
                      : work.set(card.id, true))
                  }
                >
                  {work.locationEnabled === false
                    ? SENDING_STRINGS.resumeLocation
                    : S.testWorkEnable}
                </button>
              </div>
            )}
            {testThread &&
              sameSource &&
              (choice !== "api" ||
                testThread.configOptions.some(
                  (option) =>
                    (option.category === "model" && option.id !== model?.id) ||
                    isReasoningOption(option),
                )) &&
              agentSetupModelOptions({
                apiChoice: choice === "api",
                model,
                options: testThread.configOptions,
                fieldsetDisabled:
                  testThread.identity !== "draft" ||
                  testing ||
                  modelReadFailed ||
                  explicitReadRequired,
                fieldsDisabled:
                  testing ||
                  modelChanging ||
                  testThread.identity !== "draft" ||
                  testThread.configuring,
                onPick: (id, value) => void pickOption(id, value),
              })}
            <div className="agent-model-reading">
              <p role="status">
                {!connected
                  ? M.modelConnect
                  : readingModels
                    ? M.modelReading
                    : modelReadFailed
                      ? M.modelFailed
                      : sameSource && testThread
                        ? model
                          ? M.modelReady
                          : M.modelUnprovided
                        : M.modelPending}
              </p>
              <p className="agent-setup-note">{M.modelReadHint}</p>
              {explicitReadRequired && (
                <p className="auth-note">{C.readRequired}</p>
              )}
              <AgentModelReadNotice
                mismatch={selectionMismatch}
                disabled={!canReadModels}
                onConfirm={() => {
                  if (
                    !modelReadConfirmation.current ||
                    latestProgress.current !== setupProgress ||
                    latestEntry.current !== entryKey ||
                    !currentInput
                  )
                    return;
                  const config = controller.confirmRead(currentInput);
                  if (config)
                    updateAccess({
                      selection: { service: selection.service, config },
                    });
                }}
              />
              {modelReadFailed && test.error && (
                <p role="alert" className="ac-error">
                  {test.error}
                </p>
              )}
              <button
                className="btn btn-ghost"
                disabled={!canReadModels}
                onClick={prepareAgain}
              >
                {explicitReadRequired ||
                modelReadFailed ||
                (sameSource && testThread)
                  ? M.modelRetry
                  : M.modelRead}
              </button>
              {!connected && (
                <button className="btn btn-text" onClick={() => setStep(0)}>
                  {M.program}
                </button>
              )}
            </div>
            {sameSource && testThread?.configError && (
              <p role="alert" className="ac-error">
                {testThread.configError}
              </p>
            )}
            {agentSetupTestNote({
              open:
                sameSource &&
                !readingModels &&
                !modelReadFailed &&
                (testing || !!test.error || passed),
              label:
                sameSource && !readingModels && !modelReadFailed
                  ? testLabel
                  : S.testNotRun,
              prompt: sameSource ? test.prompt : null,
              error: sameSource && !modelReadFailed ? test.error : null,
              reply: sameSource ? test.reply : null,
              passed,
              action:
                sameSource &&
                testThread?.identity === "draft" &&
                test.phase === "untested"
                  ? "start"
                  : operationPending
                    ? null
                    : "reprepare",
              startDisabled:
                busy ||
                selectionMismatch ||
                modelChanging ||
                authBusy ||
                !connected ||
                !prerequisitesReady ||
                !modelValid ||
                !work.enabled(card.id) ||
                !!testThread?.configuring ||
                !!testThread?.configError,
              reprepareDisabled:
                busy ||
                authBusy ||
                !connected ||
                !prerequisitesReady ||
                !modelValid ||
                !work.enabled(card.id) ||
                !controller.canPrepare(),
              showStop: sameSource && testing && test.phase !== "stopping",
              onStartTest: () => void controller.start(),
              onPrepare: prepareAgain,
              onStop: controller.stop,
              onOpenTest:
                sameSource &&
                test.threadKey &&
                onOpenConversation &&
                testThread?.identity === "established"
                  ? () => {
                      dialog.current?.close();
                      onOpenConversation(test.threadKey!);
                    }
                  : undefined,
              closeHint: sameSource && testing,
              openingHint: sameSource && test.phase === "opening",
            })}
            {importControl}
          </section>
        )}
      </div>
      <footer className="agent-setup-footer">
        <div>
          {step > 0 && (
            <button
              className="btn btn-ghost"
              disabled={busy || authBusy || operationPending}
              onClick={() => {
                if (!busy && !authBusy && !operationPending) setStep(step - 1);
              }}
            >
              {step === 1 ? R.backProgram : R.backAccount}
            </button>
          )}
        </div>
        <div>
          <button className="btn btn-ghost" onClick={close}>
            {authBusy || operationPending ? S.leaveAndKeep : S.pauseSetup}
          </button>
          {step === 1 && accountPrimary ? (
            <button
              className="btn btn-primary"
              disabled={accountPrimary.disabled}
              onClick={accountPrimary.run}
            >
              {accountPrimary.label}
            </button>
          ) : (
            (step !== 1 || conversation || canContinueModel) && (
              <button
                className="btn btn-primary"
                disabled={
                  nextStep !== null
                    ? nextBlocked
                    : intent === "manage"
                      ? !!onConfirmManagement && !conversation && returnBlocked
                      : returnBlocked
                }
                onClick={async () => {
                  if (nextStep !== null) {
                    if (!nextBlocked) setStep(nextStep);
                    return;
                  }
                  if (intent === "manage") {
                    if (conversation || !onConfirmManagement) close();
                    else {
                      setFinishing(true);
                      setError(null);
                      try {
                        if (await onConfirmManagement(card.id, selection))
                          close();
                      } catch (reason) {
                        setError(uiError(reason, S.loadFailed));
                      } finally {
                        setFinishing(false);
                      }
                    }
                  } else {
                    setFinishing(true);
                    setError(null);
                    try {
                      await onStart(card.id, selection);
                    } catch (reason) {
                      setError(uiError(reason, S.loadFailed));
                    } finally {
                      setFinishing(false);
                    }
                  }
                }}
              >
                {nextStep !== null
                  ? step === 0
                    ? P.nextAccount
                    : P.nextModel
                  : intent === "manage"
                    ? conversation
                      ? P.returnConversation
                      : P.save
                    : returnLabel}
              </button>
            )
          )}
        </div>
      </footer>
      {removing &&
        createPortal(
          <AgentRemoveDialog
            card={card}
            agents={agents}
            inventory={inventory}
            cwd={cwd}
            canLogout={authInfo?.executionReady === true && authInfo.canLogout}
            blocked={
              busy ||
              authBusy ||
              operationPending ||
              authenticationWorkBlockers(
                card.id,
                threads.getSnapshot().threads.values(),
              ).length > 0
            }
            onClose={() => setRemoving(false)}
            onRemoved={() => {
              setRemoving(false);
              close();
            }}
          />,
          document.body,
        )}
    </dialog>
  );
}
