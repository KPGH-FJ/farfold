import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle, ComputerTower, Plugs, X } from "@phosphor-icons/react";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import {
  ACCESS_STRINGS as S,
  installationUnavailableHint,
  installationUnavailableLabel,
} from "../runtime/access_strings";
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
import {
  ProgramManager,
  programSummary,
  useProgramInventory,
} from "./ProgramManager";
import { AgentLogo } from "./AgentLogo";
import { ServicePicker, type ServiceChoice } from "./ServicePicker";
import { AgentPrerequisites } from "./AgentPrerequisites";
import { ModelPicker } from "./ModelPicker";
import { additionalModelRows } from "./ModelConfigRows";
import { protectedConfigOptions } from "../runtime/protected_config";
import {
  configValueLabel,
  modelConfigOption,
  threads,
  useThread,
} from "../runtime/sessions";
import type { ConversationRepairContext } from "../runtime/agent_repair";
import { isReasoningOption } from "./ReasoningControl";
import {
  preparationProgram,
  preparationMatches,
  preparationContextMatches,
  preparationRequestMatches,
  preparationNeedsExplicitRead,
  testInProgress,
  usePreparation,
} from "../runtime/agent_preparation";
import { useWorkPolicy } from "../runtime/work_policy";
import { authActive } from "../runtime/auth_activity";
import { SETUP_PRESENTATION as P } from "../runtime/setup_presentation_strings";
import { AgentSetupNavigation } from "./AgentSetupNavigation";
import { SENDING_STRINGS } from "../runtime/sending_strings";
import { WORKSPACE_STRINGS } from "../runtime/workspace_strings";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";
import type { AccountRegistrationProgress } from "../runtime/account_registration";
import type { InstallationInput } from "../runtime/installation_input";
import {
  AgentInstallOptions,
  useInstallationReview,
} from "./AgentInstallOptions";
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
  registration?: AccountRegistrationProgress;
  installationInput?: InstallationInput;
  /** A rejected persisted installation field must not become implicit omission. */
  installationInputInvalid?: boolean;
}
export const initialAgentSetupProgress = (
  selection?: AgentSetupSelection,
  connected = false,
): AgentSetupProgress => ({
  step: connected ? 2 : 0,
  choice: selection?.service ? "api" : "existing",
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
    onProgress({ ...setupProgress, step: value });
  const selection = setupProgress.selection ?? EMPTY_SELECTION;
  const installation = useInstallationReview(setupProgress, onProgress);
  const setChoice = (value: AccessChoice) => {
    if (conversation) return;
    if (value !== choice && (value === "api" || choice === "api"))
      controller.invalidate();
    onProgress({
      ...setupProgress,
      choice: value,
      accessStage: value === "api" ? "api" : "account",
      selection:
        value === "api" || !selection.service
          ? selection
          : { service: null, config: {} },
    });
  };
  const setService = (service: ServiceChoice | null) => {
    if (conversation) return;
    controller.invalidate();
    onProgress({ ...setupProgress, selection: { service, config: {} } });
  };
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [modelChanging, setModelChanging] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const modelChange = useRef(0);
  const latestEntry = useRef("");
  const latestProgress = useRef(setupProgress);
  latestProgress.current = setupProgress;
  const [reportedAuthBusy, setAuthBusy] = useState(false);
  const authJob = useAuthenticationActivity(card.id);
  const authBusy = reportedAuthBusy || authActive(authJob);
  const step =
    connected || authJob || authBusy ? Math.min(setupProgress.step, 2) : 0;
  const [capability, setCapability] = useState<ServiceCapability | null>(null);
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
  const connectingFromProgram = useRef(false);
  const [prerequisitesReady, setPrerequisitesReady] = useState(false);
  const [installPrerequisitesReady, setInstallPrerequisitesReady] =
    useState(false);
  const [prerequisitesBusy, setPrerequisitesBusy] = useState(false);
  const work = useWorkPolicy(cwd);
  const targetCwd = work.ready ? work.cwd : undefined;
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
  const serviceValid =
    choice !== "api" ||
    !!(
      selection.service &&
      selectedService?.complete &&
      !selectedService.deleting &&
      selectedService.revision === selection.service.revision &&
      capability?.apiTypes.includes(selectedService.apiType) &&
      selectedService.models.includes(selection.service.model)
    );

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
    targetCwd && !conversation
      ? {
          agentId: card.id,
          agentName: card.name,
          cwd: targetCwd,
          program,
          service: selection.service,
          config: selection.config,
        }
      : null;
  const entryKey = JSON.stringify(currentInput);
  latestEntry.current = entryKey;
  const sameSource =
    !!currentInput &&
    (preparationMatches(test, currentInput) ||
      (modelChanging && preparationContextMatches(test, currentInput)));
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
  useEffect(() => {
    if (
      active &&
      connected &&
      needsAuth &&
      !source &&
      (step !== 1 ||
        choice !== "login" ||
        setupProgress.accessStage !== "account")
    )
      onProgress({
        ...setupProgress,
        step: 1,
        choice: "login",
        accessStage: "account",
      });
    // Focus each newly reported requirement once. Tabs remain accessible so
    // users can inspect their model, program or another supported source.
  }, [active, connected, needsAuth, source, card.id, cwd]);
  const apiAvailable = !!capability?.apiTypes.length;
  const returnBlocked =
    busy ||
    modelReadFailed ||
    explicitReadRequired ||
    modelChanging ||
    authBusy ||
    !cwd ||
    !connected ||
    !prerequisitesReady ||
    !serviceValid ||
    needsAuth ||
    operationPending ||
    (sameSource &&
      (!!testThread?.modelDrift ||
        !!testThread?.sourceError ||
        !!testThread?.configError ||
        !!testThread?.configuring));
  useEffect(() => {
    if (
      connectingFromProgram.current &&
      connected &&
      prerequisitesReady &&
      !busy
    ) {
      connectingFromProgram.current = false;
      if (intent === "use" && !needsAuth) setStep(2);
    }
  }, [connected, prerequisitesReady, busy, needsAuth, step]);
  useEffect(() => {
    if (
      sameSource &&
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
      step !== 2 ||
      !connected ||
      !prerequisitesReady ||
      !serviceValid ||
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
    serviceValid,
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
    if (sameSource && choice === "api" && capability !== null && !serviceValid)
      controller.invalidate();
  }, [sameSource, choice, capability, serviceValid, controller]);

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    if (active) element?.showModal();
    else element?.close();
    return () => {
      element?.close();
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        !previous.closest("[hidden], [inert]") &&
        previous.getClientRects().length
      )
        previous.focus();
    };
  }, [active]);
  useEffect(() => {
    let active = true;
    setCapabilityError(false);
    setCapability(null);
    void Promise.all([getServiceCapabilities(card.id), listCredentials()])
      .then(([result, records]) => {
        if (active) {
          setCapability(result);
          setServices(records);
        }
      })
      .catch(() => {
        if (active) setCapabilityError(true);
      });
    return () => {
      active = false;
    };
  }, [card.id, card.status, revision]);

  const connect = async (reconnect = false) => {
    const installInput = needsProgramInstall ? installation.read() : undefined;
    if (
      !reconnect &&
      needsProgramInstall &&
      (!installPrerequisitesReady || installInput === null)
    )
      return;
    setConnecting(true);
    setError(null);
    try {
      const target =
        entryCwd ??
        cwd ??
        (await invoke<string>("app_default_working_directory"));
      if (reconnect) await agents.reconnect(card, target);
      else {
        connectingFromProgram.current = step === 0;
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
    // A modal must leave the top layer before the settings page can be used.
    dialog.current?.close();
    onOpenApi(card.id);
  };
  // Authentication and an explicit test retain their own execution owner when this view closes.
  const close = onClose;
  const prepareAgain = () => {
    if (!canReadModels) return;
    const input = preparationInput();
    if (input) void controller.prepare(input, true);
  };
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
    serviceValid &&
    !!targetCwd &&
    work.enabled(card.id);
  const testLabel = {
    untested: S.testNotRun,
    opening: S.testPreparing,
    submitting: S.testSending,
    running: S.testRunning,
    needs_action: S.testNeedsAction,
    stopping: S.testStopping,
    passed: S.testPassed,
    failed: S.testFailed,
    cancelled: S.testCancelled,
    unknown: S.testUnknown,
    stale: S.testStale,
  }[test.phase];

  const importControl = onImport && (
    <button
      className="btn btn-text"
      disabled={busy || !connected || testing}
      onClick={(event) => onImport(card.id, event.currentTarget)}
    >
      {S.importConversations}
    </button>
  );
  return (
    <dialog
      ref={dialog}
      className="agent-setup-dialog"
      data-intent={intent}
      aria-labelledby="agent-setup-title"
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
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
          {displayLocation ?? S.defaultDirectoryError}
        </span>
        <span className={`agent-setup-status ${connected ? "ready" : ""}`}>
          <i aria-hidden="true" />
          {connected ? S.connected : M.goProgram}
        </span>
      </div>
      <AgentSetupNavigation
        step={step}
        connected={connected}
        accountActive={!!authJob || authBusy}
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
            {!cwd && (
              <button
                className="btn btn-text"
                onClick={() => retryDirectory((v) => v + 1)}
              >
                {S.retry}
              </button>
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
              // This command rejects while any real task or approval is active.
              // Do not use the display helper, which records and absorbs errors.
              await invoke("agent_disconnect", { agentId: card.id });
              await agents.refresh();
            }}
            onInstalled={async () => {
              await Promise.all([agents.refresh(), inventory.refresh()]);
            }}
          />
        </fieldset>
        {step === 0 && (
          <>
            {!connected && setupProgress.step !== 0 && (
              <p className="agent-setup-notice" role="status">
                {P.connectionRequiredHint}
              </p>
            )}
            <h3>{intent === "use" ? P.program(card.name) : M.program}</h3>
            {intent === "use" && (
              <p className="agent-setup-subtitle">{P.programHint}</p>
            )}
            {card.installable && (
              <AgentInstallOptions
                {...installation.fieldProps}
                disabled={busy || authBusy || operationPending}
              />
            )}
            <div className="agent-setup-program">
              <div>
                <strong>{card.name}</strong>
                <p>
                  {connected
                    ? S.connected
                    : registered
                      ? S.registered
                      : card.status === "discovered"
                        ? S.discovered
                        : !card.installable && !card.registerable
                          ? installationUnavailableLabel(card.platformAvailable)
                          : S.notInstalled}
                </p>
                <small>
                  {STRINGS.access.program} · {programSummary(card, inventory)}
                </small>
                {card.programEnv && card.version && (
                  <small>
                    {STRINGS.access.component} · {card.version}
                  </small>
                )}
              </div>
              {connected ? (
                intent === "manage" ? (
                  <button
                    className="btn btn-ghost"
                    disabled={busy || authBusy || operationPending}
                    onClick={() => void agents.disconnect(card.id)}
                  >
                    {STRINGS.agents.disconnect}
                  </button>
                ) : (
                  <CheckCircle size={25} className="agent-hub-ready" />
                )
              ) : (
                <button
                  className="btn btn-primary"
                  disabled={
                    busy ||
                    authBusy ||
                    operationPending ||
                    (needsProgramInstall &&
                      (!installPrerequisitesReady || !installation.ready)) ||
                    (!registered && !card.registerable && !card.installable)
                  }
                  onClick={() => void connect().catch(() => undefined)}
                >
                  {busy
                    ? STRINGS.common.loading
                    : registered || card.registerable
                      ? S.connect
                      : S.install}
                </button>
              )}
            </div>
            {needsProgramInstall &&
              card.installable &&
              !installPrerequisitesReady && (
                <p className="auth-note">{S.installPrerequisitesRequired}</p>
              )}
            {progress && (
              <div className="agent-setup-progress" role="status">
                <span>{progress.label}</span>
                {progress.canCancelInstall && (
                  <button
                    className="btn btn-text"
                    onClick={() => void agents.cancelInstall(card.id)}
                  >
                    {STRINGS.access.cancelOperation}
                  </button>
                )}
              </div>
            )}
            {!registered && !card.registerable && !card.installable && (
              <p className="auth-note">
                {installationUnavailableHint(card.platformAvailable)}
              </p>
            )}
            {intent === "use" && (
              <p className="agent-setup-note">
                {connected ? S.connectedHint : S.connectionScope}
              </p>
            )}
            <details className="agent-setup-management">
              <summary>{S.advanced}</summary>
              <fieldset
                className="agent-setup-program-guard"
                disabled={authBusy || operationPending}
              >
                <ProgramManager
                  card={card}
                  agents={agents}
                  inventory={inventory}
                  installDisabled={
                    !installation.ready ||
                    !installPrerequisitesReady ||
                    busy ||
                    authBusy ||
                    operationPending
                  }
                  onInstall={async () => {
                    const input = installation.read();
                    if (
                      input === null ||
                      !installPrerequisitesReady ||
                      busy ||
                      authBusy ||
                      operationPending
                    )
                      return false;
                    return agents.install(card, input);
                  }}
                />
              </fieldset>
              {connected && intent === "use" && (
                <button
                  className="btn btn-ghost"
                  disabled={busy || authBusy || operationPending}
                  onClick={() => void agents.disconnect(card.id)}
                >
                  {STRINGS.agents.disconnect}
                </button>
              )}
              {intent === "manage" && registered && (
                <div className="agent-manage-actions">
                  <button
                    className="btn btn-text"
                    disabled={busy || authBusy || operationPending || connected}
                    onClick={() => setRemoveConfirm(true)}
                  >
                    {STRINGS.access.remove}
                  </button>
                  {removeConfirm && (
                    <div className="access-confirm" role="alert">
                      <p>{STRINGS.access.removeHint}</p>
                      <button
                        className="btn btn-ghost"
                        disabled={
                          busy || authBusy || operationPending || connected
                        }
                        onClick={() =>
                          void agents.remove(card.id).then((ok) => {
                            if (ok) close();
                          })
                        }
                      >
                        {STRINGS.access.confirmRemove}
                      </button>
                      <button
                        className="btn btn-text"
                        onClick={() => setRemoveConfirm(false)}
                      >
                        {STRINGS.access.cancel}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </details>
            {intent === "manage" && importControl}
          </>
        )}
        {step === 1 && (
          <>
            {needsAuth && (
              <p className="agent-setup-notice">
                {choice === "api" ? S.apiAuthRequired : S.authRequired}
              </p>
            )}
            {!conversation && (
              <div
                className="agent-access-choices agent-source-choices"
                role="radiogroup"
                aria-label={P.source}
              >
                {(["existing", "api"] as const).map((value) => {
                  const Icon = value === "existing" ? ComputerTower : Plugs;
                  const selected =
                    value === choice ||
                    (value === "existing" && choice === "login");
                  return (
                    <button
                      type="button"
                      key={value}
                      role="radio"
                      aria-checked={selected}
                      disabled={
                        authBusy ||
                        operationPending ||
                        (value === "api" && !apiAvailable)
                      }
                      className={selected ? "selected" : ""}
                      onClick={() => setChoice(value)}
                    >
                      <Icon size={22} aria-hidden="true" />
                      <span>
                        <strong>
                          {value === "existing" ? P.localSource : P.apiChoice}
                        </strong>
                        <small>
                          {value === "api" && !apiAvailable
                            ? capabilityError
                              ? S.loadFailed
                              : capability === null
                                ? STRINGS.common.loading
                                : M.apiUnavailable
                            : value === "existing"
                              ? P.localSourceHint
                              : P.apiChoiceHint}
                        </small>
                      </span>
                      {selected && <CheckCircle size={20} aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            )}
            {!conversation && choice !== "api" && (
              <div className="agent-current-summary">
                <strong>{P.summary}</strong>
                <small>{P.accountUnknown}</small>
                <small>
                  {!connected
                    ? M.loginConnect
                    : needsAuth
                      ? S.authRequired
                      : passed
                        ? S.testPassed
                        : P.accountUnchecked}
                </small>
              </div>
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
            {!connected && !authBusy && (
              <div className="agent-setup-notice" role="status">
                <h3>{P.connectionRequired}</h3>
                <p>{P.connectionRequiredHint}</p>
                <button className="btn btn-ghost" onClick={() => setStep(0)}>
                  {M.goProgram}
                </button>
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
            {(authJob ||
              authBusy ||
              (connected && (conversation || choice !== "api"))) && (
              <>
                <AgentAuthSection
                  active={active}
                  agentId={card.id}
                  program={program}
                  onOpenModels={() => setStep(2)}
                  focused={intent === "use"}
                  methodId={setupProgress.authMethodId ?? null}
                  registration={setupProgress.registration}
                  onRegistrationChange={(registration) =>
                    onProgress({
                      ...setupProgress,
                      registration,
                      authMethodId: registration
                        ? registration.methodId || undefined
                        : setupProgress.authMethodId,
                    })
                  }
                  onMethodChange={(authMethodId) =>
                    onProgress({
                      ...setupProgress,
                      authMethodId,
                      registration: undefined,
                    })
                  }
                  cwd={cwd}
                  source={source}
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
              </>
            )}
            {choice === "api" && (
              <div className="agent-setup-api">
                {apiAvailable && !conversation && (
                  <ServicePicker
                    agentId={card.id}
                    value={selection.service}
                    onChange={setService}
                    emptyLabel={S.chooseService}
                    disabled={operationPending || authBusy}
                    data={{
                      items: services,
                      capability,
                      error: capabilityError,
                      onRetry: () => setRevision((v) => v + 1),
                    }}
                  />
                )}
                <p>
                  {capabilityError
                    ? S.loadFailed
                    : capability === null
                      ? STRINGS.common.loading
                      : capability.apiTypes.length
                        ? S.apiReturnHint
                        : M.apiUnavailable}
                </p>
                {capabilityError ? (
                  <button
                    className="btn btn-ghost"
                    onClick={() => setRevision((v) => v + 1)}
                  >
                    {S.retry}
                  </button>
                ) : (
                  ((capability && capability.apiTypes.length > 0) ||
                    conversation) && (
                    <button
                      className="btn btn-ghost"
                      disabled={authBusy || operationPending}
                      onClick={openApi}
                    >
                      {S.openApi}
                    </button>
                  )
                )}
              </div>
            )}
          </>
        )}
        {step === 2 && conversation && (
          <section className="agent-setup-selection">
            <h3>{M.model}</h3>
            <p className="agent-setup-subtitle">{STRINGS.repair.modelLocked}</p>
            <dl className="agent-setup-review">
              <div>
                <dt>{S.source}</dt>
                <dd>
                  {source
                    ? (selectedService?.label ?? STRINGS.service.unavailable)
                    : S.existing}
                </dd>
              </div>
              {conversation.recordedModel && (
                <div>
                  <dt>{STRINGS.repair.recordedModel}</dt>
                  <dd>{conversation.recordedModel}</dd>
                </div>
              )}
              {protectedConfigOptions(
                conversation.configOptions,
                conversation.protectedIds,
              ).map((option) => (
                <div key={option.id}>
                  <dt>{option.name}</dt>
                  <dd>{configValueLabel(option)}</dd>
                </div>
              ))}
              {!conversation.configOptions.length && (
                <div>
                  <dt>{S.model}</dt>
                  <dd>{STRINGS.repair.unknownModel}</dd>
                </div>
              )}
              <div>
                <dt>{S.workFolder}</dt>
                <dd>{displayLocation}</dd>
              </div>
            </dl>
          </section>
        )}
        {step === 2 && !conversation && (
          <section className="agent-setup-selection">
            <h3>{M.model}</h3>
            <p className="agent-setup-subtitle">{M.managementHint}</p>
            {intent === "use" && (
              <dl className="agent-setup-review">
                <div>
                  <dt>{S.title}</dt>
                  <dd>{card.name}</dd>
                </div>
                <div>
                  <dt>{S.source}</dt>
                  <dd>
                    {choice === "api"
                      ? (selectedService?.label ?? S.chooseService)
                      : S.existing}
                  </dd>
                </div>
                <div>
                  <dt>{S.workFolder}</dt>
                  <dd title={displayLocation ?? ""}>
                    {displayLocation ?? S.defaultDirectoryError}
                  </dd>
                </div>
              </dl>
            )}
            {!serviceValid && (
              <div role="alert" className="agent-setup-notice">
                <p>{S.chooseCompatibleApi}</p>
                <button className="btn btn-ghost" onClick={() => setStep(1)}>
                  {S.changeSource}
                </button>
              </div>
            )}
            {needsAuth && (
              <div role="alert" className="agent-setup-notice">
                <p>{choice === "api" ? S.apiAuthRequired : S.authRequired}</p>
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
            {testThread && sameSource && (
              <fieldset
                className="agent-setup-options"
                disabled={
                  testThread.identity !== "draft" ||
                  testing ||
                  modelReadFailed ||
                  explicitReadRequired
                }
              >
                {model ? (
                  <div className="so-row">
                    <span className="so-name">{S.model}</span>
                    <ModelPicker
                      option={model}
                      disabled={
                        testing ||
                        modelChanging ||
                        testThread.identity !== "draft" ||
                        testThread.configuring
                      }
                      onPick={(value) => void pickOption(model.id, value)}
                    />
                  </div>
                ) : (
                  <p className="auth-note">{S.testModelUnspecified}</p>
                )}
                {additionalModelRows({
                  options: testThread.configOptions,
                  primaryId: model?.id,
                  disabled:
                    testing ||
                    modelChanging ||
                    testThread.identity !== "draft" ||
                    testThread.configuring,
                  onPick: (id, value) => void pickOption(id, value),
                })}
                {testThread.configOptions
                  .filter(isReasoningOption)
                  .map((option) => (
                    <label
                      className="so-row agent-setup-reasoning"
                      key={option.id}
                    >
                      <span className="so-name">{option.name}</span>
                      {option.type === "select" && option.options.length ? (
                        <select
                          aria-label={option.name}
                          title={option.description}
                          value={String(option.currentValue ?? "")}
                          disabled={
                            testing ||
                            modelChanging ||
                            testThread.identity !== "draft" ||
                            testThread.configuring
                          }
                          onChange={(event) =>
                            void pickOption(option.id, event.target.value)
                          }
                        >
                          {!option.options.some(
                            (item) => item.value === option.currentValue,
                          ) && (
                            <option
                              value={String(option.currentValue ?? "")}
                              disabled
                            >
                              {configValueLabel(option)}
                            </option>
                          )}
                          {option.options.map((item) => (
                            <option key={item.value} value={item.value}>
                              {item.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span>{configValueLabel(option)}</span>
                      )}
                    </label>
                  ))}
              </fieldset>
            )}
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
            <details
              className="agent-setup-test-note"
              open={
                sameSource &&
                !readingModels &&
                !modelReadFailed &&
                (testing || !!test.error || passed)
                  ? true
                  : undefined
              }
            >
              <summary>{S.optionalTest}</summary>
              <h4 role="status">
                {sameSource && !readingModels && !modelReadFailed
                  ? testLabel
                  : S.testNotRun}
              </h4>
              <p>{S.conversationTestHint}</p>
              {sameSource && test.prompt && (
                <details className="agent-test-message" open>
                  <summary>{S.testMessage}</summary>
                  <p>{test.prompt}</p>
                </details>
              )}
              {sameSource && !modelReadFailed && test.error && (
                <p role="alert" className="ac-error">
                  {test.error}
                </p>
              )}
              {sameSource && test.reply && (
                <details className="agent-test-message" open>
                  <summary>{S.testActualReply}</summary>
                  <pre>{test.reply}</pre>
                </details>
              )}
              <div className="agent-test-actions">
                {sameSource &&
                testThread?.identity === "draft" &&
                test.phase === "untested" ? (
                  <button
                    className="btn btn-primary"
                    disabled={
                      busy ||
                      modelChanging ||
                      authBusy ||
                      !connected ||
                      !prerequisitesReady ||
                      !serviceValid ||
                      !work.enabled(card.id) ||
                      testThread.configuring ||
                      !!testThread.configError
                    }
                    onClick={() => void controller.start()}
                  >
                    {S.testInConversation}
                  </button>
                ) : (
                  !operationPending && (
                    <button
                      className="btn btn-ghost"
                      disabled={
                        busy ||
                        authBusy ||
                        !connected ||
                        !prerequisitesReady ||
                        !serviceValid ||
                        !work.enabled(card.id) ||
                        !controller.canPrepare()
                      }
                      onClick={prepareAgain}
                    >
                      {passed ? S.testChangeOptions : S.testReprepare}
                    </button>
                  )
                )}
                {sameSource && testing && test.phase !== "stopping" && (
                  <button className="btn btn-ghost" onClick={controller.stop}>
                    {S.testStop}
                  </button>
                )}
                {sameSource &&
                  test.threadKey &&
                  onOpenConversation &&
                  testThread?.identity === "established" && (
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
              {sameSource && testing && (
                <p className="agent-setup-note">{S.testCloseHint}</p>
              )}
              {sameSource && test.phase === "opening" && (
                <p className="agent-setup-note">{S.testModelLoading}</p>
              )}
            </details>
            <p className="agent-setup-note">
              {passed ? S.readyScope : S.untestedReturnHint}
            </p>
            {importControl}
          </section>
        )}
      </div>
      <footer className="agent-setup-footer">
        <div />
        <div>
          <button className="btn btn-ghost" onClick={close}>
            {authBusy || operationPending ? S.leaveAndKeep : S.pauseSetup}
          </button>
          <button
            className="btn btn-primary"
            disabled={
              intent === "manage"
                ? !!onConfirmManagement && !conversation && returnBlocked
                : returnBlocked
            }
            onClick={async () => {
              if (intent === "manage") {
                if (conversation || !onConfirmManagement) close();
                else {
                  setFinishing(true);
                  setError(null);
                  try {
                    if (await onConfirmManagement(card.id, selection)) close();
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
            {intent === "manage"
              ? conversation
                ? P.returnConversation
                : P.save
              : returnLabel}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
