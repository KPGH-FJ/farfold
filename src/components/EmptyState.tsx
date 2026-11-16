import { audioCapability } from "../runtime/audio_input";
import {
  captureConfigurationOwner,
  configurationRestoreIntent,
  mirroredConfigurationChoice,
  restoreSavedConfiguration,
} from "../runtime/saved_configuration_restore";
/** 开始页：仅本次明确选择或首发准备草稿，恢复的选择不会自动打开。 */
import { PreservedDrafts } from "./PreservedDrafts";
import { NewConversationLocationBar } from "./NewConversationLocationBar";
import { useDraftPreparation } from "./useDraftPreparation";
import {
  usePreparedComposerOwner,
  usePreparedComposerPortal,
  useSavedPreparedConversation,
  type PreparedConversationTransition,
} from "./usePreparedComposerOwner";
import { useDraftWorkLocation } from "./useDraftWorkLocation";
import { useDraftSendIntent, type DraftSendIntent } from "./useDraftSendIntent";
import {
  DraftArchiveBlockedError,
  useDraftArchiveGuard,
} from "./useDraftArchiveGuard";
import { REDESIGN as R } from "../runtime/redesign_strings";
import { serviceSelectionIsCurrent } from "../runtime/conversation_actions";
import { createPortal } from "react-dom";
import { chooseDirectory } from "../runtime/dialogs";
import type { UiNotice } from "../runtime/ui_error";
import {
  configurationApplyNotice,
  configurationPreparationNotice,
  confirmationFeedback,
  isConfigurationRestoreNotice,
} from "../runtime/configuration_restore_feedback";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ServiceChoice } from "./ServicePicker";
import {
  listCredentials,
  subscribeCredentialChanges,
} from "../runtime/credentials";
import {
  NewConversationAgentDialog,
  NewConversationModelDialog,
  newConversationPreparationError,
  type NewConversationModelChoice,
} from "./NewConversationPickers";
import { Composer } from "./Composer";
import type { AgentCardModel } from "../runtime/agents";
import { promptCapabilities } from "../runtime/agents";
import {
  isAgentPresentable,
  isAgentReadyForConversation,
} from "../runtime/agent_directory";
import {
  hasSavedAgentPreparation,
  useConversationAgentReadiness,
} from "../runtime/agent_readiness";
import { isMyAgent } from "../runtime/my_agents";
import { agentStatus } from "../runtime/agent_status";
import {
  allowAutomaticConnection,
  isAutomaticConnectionAllowed,
  useAutomaticConnectionAllowed,
} from "../runtime/connection_intent";
import { useConnectionHold } from "../runtime/connection_hold";
import { ACCESS_STRINGS as A } from "../runtime/access_strings";
import {
  modelConfigOption,
  configValueLabel,
  threads,
  useThread,
  type PromptBlock,
} from "../runtime/sessions";
import { useWorkPolicy } from "../runtime/work_policy";
import { STRINGS } from "../runtime/strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import {
  composerDrafts,
  draftPersistence,
  newConversationChoice,
  useComposerDraft,
  type ComposerDraft,
} from "../runtime/drafts";
import { sendNewConversation } from "../runtime/new_conversation";
import {
  rememberPendingConversation,
  finishPendingConversation,
  recoverPendingConversation,
  type PendingAttempt,
} from "../runtime/pending_conversation";
import { WorkspacePopover } from "./WorkspacePopover";
import { SessionOptionsList, sessionOptions } from "./SessionOptionsMenu";
import { AgentLogo } from "./AgentLogo";
import { ReasoningControl } from "./ReasoningControl";
import { PermissionControl } from "./PermissionControl";
import { setupStorage, useSetupStorage } from "../runtime/setup_storage";
import {
  pendingPreparationRead,
  usePreparationChanges,
} from "../runtime/agent_preparation";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";
import {
  authenticationRequired,
  currentAuthenticationRequired,
  authenticationActivity,
  useAuthentication,
} from "../runtime/authentication";
import { authActive } from "../runtime/auth_activity";
import {
  agentRepairPanel,
  type AgentRepairRequest,
} from "../runtime/agent_repair";
import {
  AirplaneTiltIcon,
  BookOpenIcon,
  CompassIcon,
  CaretDownIcon,
  PencilLineIcon,
  SlidersHorizontalIcon,
} from "@phosphor-icons/react";
const suggestionIcons = [AirplaneTiltIcon, PencilLineIcon, BookOpenIcon];
const NO_HISTORY: ReadonlySet<string> = new Set();
export function EmptyState({
  agents,
  historyAgentIds,
  initialAgentId = null,
  initialAgentRevision = 0,
  initialSelection,
  onGoSettings,
  onManageServices,
  onProjectChange,
  onStarted,
  header,
  active = true,
  onPreparedKey,
  onPreparedComposerOwner,
  onPreparedSaved,
  composerTarget,
  onRestoreDraft,
  availableFeedbackOwners,
}: {
  onRestoreDraft?: (key: string) => Promise<void>;
  availableFeedbackOwners?: ReadonlySet<string>;
  onPreparedKey?: (key: string | null) => void;
  onPreparedComposerOwner?: (current: (() => boolean) | null) => void;
  onPreparedSaved?: PreparedConversationTransition;
  composerTarget?: HTMLElement | null;
  header?: ReactNode;
  active?: boolean;
  agents: AgentCardModel[];
  /** Conversation history membership for the shared "我的 Agent" rule. */
  historyAgentIds?: ReadonlySet<string>;
  /** Explicit selection from Agent discovery. */
  initialAgentId?: string | null;
  initialAgentRevision?: number;
  initialSelection?: {
    requiresReview?: boolean;
    service: ServiceChoice | null;
    config: Record<string, unknown>;
  };
  onGoSettings: (agentId?: string, repair?: AgentRepairRequest) => void;
  onManageServices?: () => void;
  onStarted: (key: string) => void;
  onProjectChange: (cwd: string | null) => void;
}) {
  const [folder, setFolder] = useState<string | null>(
    newConversationChoice.cwd,
  );
  const cwd = folder;
  useEffect(() => {
    newConversationChoice.cwd = folder;
  }, [folder]);
  const [selectionNeedsReview, setSelectionNeedsReview] = useState(
    newConversationChoice.reviewRequired === true ||
      Boolean(
        newConversationChoice.service &&
        !newConversationChoice.service.revision,
      ),
  );
  const selectionReviewRef = useRef(selectionNeedsReview);
  selectionReviewRef.current = selectionNeedsReview;
  const work = useWorkPolicy(cwd);
  const requestCwd = cwd ? (work.cwd ?? cwd) : null;
  const preparedForConversation = useConversationAgentReadiness(agents);
  const currentReadiness = useRef(preparedForConversation);
  currentReadiness.current = preparedForConversation;
  useEffect(() => onProjectChange(cwd), [cwd, onProjectChange]);
  const [agentId, setAgentId] = useState<string | null>(
    newConversationChoice.agentId,
  );
  const connectionAllowed = useAutomaticConnectionAllowed(agentId);
  const currentAgents = useRef(agents);
  currentAgents.current = agents;
  const isCurrentCandidate = (id: string | null) =>
    currentAgents.current.some(
      (card) =>
        card.id === id &&
        isAgentReadyForConversation(
          card,
          setupStorage.completed(card.id) &&
            !!setupStorage.confirmedSelection(card.id) &&
            !authActive(authenticationActivity(card.id).getSnapshot()),
        ),
    );
  const currentAgent = agents.find((agent) => agent.id === agentId);
  const candidateSelected = isCurrentCandidate(agentId);
  const history = historyAgentIds ?? NO_HISTORY;
  const hasMyAgent = agents.some((card) => isMyAgent(card, history));
  // 尚未接入任何 Agent 时给出最多三条直接接入选项：先本机已发现的，
  // 再按目录顺序补可安装条目。
  const welcomeSuggestions = hasMyAgent
    ? []
    : [
        ...agents.filter(
          (card) => isAgentPresentable(card) && card.status === "discovered",
        ),
        ...agents.filter(
          (card) =>
            isAgentPresentable(card) &&
            card.status !== "discovered" &&
            (card.installable || card.registerable),
        ),
      ].slice(0, 3);
  const initialCandidatePresentable = isCurrentCandidate(initialAgentId);
  const [service, setService] = useState<ServiceChoice | null>(
    newConversationChoice.service,
  );
  const [serviceLabel, setServiceLabel] = useState<{
    id: string;
    label: string;
  } | null>(null);
  useEffect(() => {
    const id = service?.id;
    if (!id) return;
    let current = true;
    let revision = 0;
    const read = () => {
      const request = ++revision;
      void listCredentials()
        .then((items) => {
          if (current && request === revision)
            setServiceLabel({
              id,
              label:
                items.find((item) => item.id === id)?.label ??
                STRINGS.service.unavailable,
            });
        })
        .catch(() => {
          if (current && request === revision)
            setServiceLabel({ id, label: W.savedSource });
        });
    };
    read();
    const unsubscribe = subscribeCredentialChanges(read);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [service?.id]);
  useEffect(() => {
    newConversationChoice.agentId = agentId;
    newConversationChoice.service = service;
  }, [agentId, service]);
  const [draftRevision, setDraftRevision] = useState(0);
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<UiNotice | null>(null);
  const [opening, setOpening] = useState(false);
  const [picking, setPicking] = useState(false);
  const [folderCancelled, setFolderCancelled] = useState(false);
  const [sendRequest, setSendRequest] = useState(0);
  const [choiceDialog, setChoiceDialog] = useState<"agent" | "model" | null>(
    null,
  );
  useEffect(() => {
    if (!active) setChoiceDialog(null);
  }, [active]);
  const draft = useThread(draftKey);
  useConnectionHold(
    active && draft && !draft.connectionLost && !draft.openError
      ? {
          agentId: draft.agentId,
          cwd: draft.cwd,
          serviceContext: draft.serviceContext,
          connectionId: draft.connectionId,
        }
      : null,
  );
  const unsent = useComposerDraft("new");
  useSetupStorage();
  usePreparationChanges();
  // The selected folder may alias the canonical request directory.
  const readRequired = () =>
    !!agentId &&
    (pendingPreparationRead({ agentId, cwd, service }) ||
      pendingPreparationRead({ agentId, cwd: requestCwd, service }));
  const explicitReadRequired = readRequired();
  const preparationComplete =
    !!agentId && setupStorage.completed(agentId) && !explicitReadRequired;
  const authentication = useAuthentication();
  const sourceContext =
    draft?.serviceContext ?? (service ? JSON.stringify(service) : undefined);
  const needsAuthentication =
    !!agentId &&
    authenticationRequired(authentication, agentId, requestCwd, sourceContext);
  const openRepair = () =>
    onGoSettings(agentId ?? undefined, {
      panel:
        explicitReadRequired ||
        (!needsAuthentication &&
          (draftError?.message === STRINGS.repair.configFailed ||
            draftError?.message === STRINGS.repair.confirmConfigFailed ||
            isConfigurationRestoreNotice(draftError)))
          ? "model"
          : agentRepairPanel(draft, needsAuthentication),
      needsAuthentication,
      sourceContext,
    });
  const failedPairRef = useRef<string | null>(null);
  const pendingInquiryAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!active) {
      pendingInquiryAbort.current?.abort();
      setOpening(false);
    }
    return () => pendingInquiryAbort.current?.abort();
  }, [active]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const preparationIntent = useRef<{ pair: string } | null>(null);
  if (!active) preparationIntent.current = null;
  const requestPreparation = () => {
    if (!activeRef.current) return;
    if (opening && preparationIntent.current?.pair === pair) return;
    preparationIntent.current = { pair };
    if (!draft || draft.connectionLost || draft.openError || draftError) {
      failedPairRef.current = null;
      setDraftError(null);
      setDraftRevision((value) => value + 1);
    }
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const pair = `${agentId}|${cwd}|${requestCwd}|${JSON.stringify(service)}`;
  const preparedComposerOwner = usePreparedComposerOwner(pair, active);
  const handedOffKeys = useRef(new Set<string>());
  const sendAfterFolder = useRef<DraftSendIntent | null>(null);
  const archiveGuard = useDraftArchiveGuard(
    requestCwd,
    active,
    sendAfterFolder,
  );
  const archiveBlocked = archiveGuard.blocked;
  const currentPair = useRef(pair);
  currentPair.current = pair;
  const selectionEpoch = useRef(0);
  const locationState = useRef({ draft, unsent, picking });
  locationState.current = { draft, unsent, picking };
  const locationAllowed = () => {
    const value = locationState.current;
    const saved = composerDrafts.read("new");
    return (
      mounted.current &&
      activeRef.current &&
      !value.picking &&
      !draftPersistence.snapshot().interactionLocked &&
      !value.unsent.pendingConversation &&
      !saved.pendingConversation &&
      !saved.sendPending &&
      !value.draft?.submitting &&
      !value.draft?.running
    );
  };
  const { owner: locationOwner, begin: beginWorkLocation } =
    useDraftWorkLocation({
      context: JSON.stringify([
        pair,
        initialAgentRevision,
        draftRevision,
        selectionEpoch.current,
      ]),
      active,
      allowed: locationAllowed,
      onBegin: () => {
        sendAfterFolder.current = null;
      },
      onApply: (path) => {
        sendAfterFolder.current = null;
        setDraftError(null);
        failedPairRef.current = null;
        newConversationChoice.cwd = path;
        setFolder(path);
        requestPreparation();
      },
    });
  const beginPreparation = useDraftPreparation({
    context: JSON.stringify([
      pair,
      initialAgentRevision,
      draftRevision,
      selectionEpoch.current,
      draft?.key ?? null,
    ]),
    active,
    cwd: requestCwd,
    allowed: () =>
      locationAllowed() &&
      !archiveGuard.isBlocked() &&
      !selectionReviewRef.current &&
      !locationState.current.draft?.configuring,
    onBegin: () => {
      sendAfterFolder.current = null;
      locationOwner.current.retire();
    },
  });
  const requireCurrentService = async () => {
    if (!service) return;
    const epoch = selectionEpoch.current;
    const items = await listCredentials().catch(() => []);
    if (
      !mounted.current ||
      currentPair.current !== pair ||
      selectionEpoch.current !== epoch
    )
      throw new Error(R.selectionReview);
    if (!serviceSelectionIsCurrent(service, items)) {
      selectionReviewRef.current = true;
      setSelectionNeedsReview(true);
      newConversationChoice.reviewRequired = true;
      throw new Error(R.selectionReview);
    }
  };
  const requestedAgent = useRef<{ id: string | null; revision: number }>({
    id: null,
    revision: -1,
  });
  useEffect(() => {
    if (
      !initialAgentId ||
      !initialCandidatePresentable ||
      (requestedAgent.current.id === initialAgentId &&
        requestedAgent.current.revision === initialAgentRevision)
    )
      return;
    requestedAgent.current = {
      id: initialAgentId,
      revision: initialAgentRevision,
    };
    if (activeRef.current) preparationIntent.current = { pair };
    selectionEpoch.current++;
    // Keep the new selection independent of the preceding draft's options.
    setDraftKey(null);
    setFolder(newConversationChoice.cwd);
    if (initialSelection) {
      const review =
        initialSelection.requiresReview === true ||
        Boolean(initialSelection.service && !initialSelection.service.revision);
      selectionReviewRef.current = review;
      setSelectionNeedsReview(review);
      newConversationChoice.reviewRequired = review;
      setAgentId(initialAgentId);
      setService(initialSelection.service);
      newConversationChoice.config = { ...initialSelection.config };
    } else if (agentId !== initialAgentId) {
      setAgentId(initialAgentId);
      setService(null);
      newConversationChoice.config = {};
    }
    failedPairRef.current = null;
    setDraftError(null);
    setDraftRevision((value) => value + 1);
  }, [
    initialAgentId,
    initialAgentRevision,
    initialSelection,
    initialCandidatePresentable,
  ]);
  useEffect(() => {
    const intent = preparationIntent.current;
    if (!intent) {
      setOpening(false);
      return;
    }
    if (unsent.pendingConversation) {
      setOpening(false);
      return;
    }
    if (
      !candidateSelected ||
      !connectionAllowed ||
      selectionNeedsReview ||
      archiveBlocked
    ) {
      setOpening(false);
      return;
    }
    if (
      !active ||
      !agentId ||
      !preparationComplete ||
      needsAuthentication ||
      !cwd ||
      !work.enabled(agentId)
    ) {
      setDraftKey(null);
      setOpening(false);
      return;
    }
    if (failedPairRef.current === pair) {
      setOpening(false);
      return;
    }
    let cancelled = false;
    const inquiryAbort = new AbortController();
    pendingInquiryAbort.current = inquiryAbort;
    let openedKey: string | null = null;
    const rejectOpened = () => {
      const unavailable = archiveGuard.isBlocked();
      const current = activeRef.current && preparationIntent.current === intent;
      if (!cancelled && !unavailable && current) return false;
      // Keep an open shared by a newer live effect for the same pair.
      if (
        openedKey &&
        (!mounted.current ||
          currentPair.current !== pair ||
          unavailable ||
          !activeRef.current ||
          !preparationIntent.current)
      ) {
        if (!handedOffKeys.current.has(openedKey))
          void threads.discardDraft(openedKey);
        openedKey = null;
      }
      return true;
    };
    const requestedConfig = { ...newConversationChoice.config };
    intent.pair = pair;
    setDraftKey(null);
    setOpening(true);
    const timer = setTimeout(() => {
      if (
        !activeRef.current ||
        preparationIntent.current !== intent ||
        !isCurrentCandidate(agentId) ||
        !isAutomaticConnectionAllowed(agentId) ||
        readRequired()
      ) {
        setOpening(false);
        return;
      }
      setOpening(true);
      setDraftError(null);
      (async () => {
        await requireCurrentService();
        archiveGuard.requireAvailable();
        if (
          cancelled ||
          !activeRef.current ||
          preparationIntent.current !== intent ||
          selectionReviewRef.current ||
          currentPair.current !== pair
        )
          throw new Error(R.selectionReview);
        return threads.open({
          inquirySignal: inquiryAbort.signal,
          inquiryCurrent: () =>
            !cancelled &&
            mounted.current &&
            activeRef.current &&
            preparationIntent.current === intent &&
            currentPair.current === pair &&
            !archiveGuard.isBlocked(),
          agentId,
          cwd: requestCwd!,
          service,
          serviceRevision: service?.revision,
          fresh: handedOffKeys.current.size > 0,
        });
      })()
        .then(async (state) => {
          openedKey = state.key;
          if (rejectOpened()) return;
          if (
            !isCurrentCandidate(agentId) ||
            !isAutomaticConnectionAllowed(agentId)
          )
            return;
          const sameOwner = captureConfigurationOwner(state);
          const restored = await restoreSavedConfiguration(
            state,
            configurationRestoreIntent(state, requestedConfig, service?.model),
            {
              current: () =>
                !rejectOpened() &&
                !cancelled &&
                threads.thread(state.key) === state &&
                sameOwner() &&
                state.agentId === agentId &&
                state.cwd === requestCwd &&
                (service
                  ? state.service?.id === service.id &&
                    state.service.model === service.model
                  : !state.service) &&
                isCurrentCandidate(agentId) &&
                isAutomaticConnectionAllowed(agentId) &&
                !readRequired(),
              validateService: requireCurrentService,
              set: (id, value) => threads.setConfig(state.key, id, value),
              confirm: (selection) =>
                threads.confirmRestoredConfig(state.key, selection),
            },
          );
          if (!restored || rejectOpened()) return;
          preparedComposerOwner.open(state.key, state);
          setDraftKey(state.key);
        })
        .catch((error) => {
          if (
            !cancelled &&
            mounted.current &&
            activeRef.current &&
            currentPair.current === pair &&
            preparationIntent.current === intent &&
            !(error instanceof DraftArchiveBlockedError)
          ) {
            failedPairRef.current = pair;
            setDraftError(configurationPreparationNotice(error));
          }
        })
        .finally(() => {
          if (!cancelled && preparationIntent.current === intent)
            setOpening(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      inquiryAbort.abort();
      clearTimeout(timer);
      if (
        openedKey &&
        isAutomaticConnectionAllowed(agentId) &&
        isCurrentCandidate(agentId) &&
        !handedOffKeys.current.has(openedKey)
      )
        void threads.discardDraft(openedKey);
    };
  }, [
    draftRevision,
    archiveBlocked,
    selectionNeedsReview,
    agentId,
    candidateSelected,
    connectionAllowed,
    preparationComplete,
    needsAuthentication,
    requestCwd,
    service,
    work.ready,
    agentId ? work.enabled(agentId) : false,
    unsent.pendingConversation,
  ]);
  const modelOption = draft ? modelConfigOption(draft.configOptions) : null;
  const applyingModel = useRef<string | null>(null);
  const caps = promptCapabilities(agents.find((a) => a.id === agentId) ?? null);
  const imageOk = caps.image;
  useEffect(() => {
    if (
      !candidateSelected ||
      explicitReadRequired ||
      !draft ||
      draft.agentId !== agentId ||
      draft.cwd !== requestCwd ||
      (service
        ? draft.service?.id !== service.id ||
          draft.service?.model !== service.model
        : Boolean(draft.service)) ||
      draft.configuring ||
      draft.configError ||
      draftError ||
      applyingModel.current === draft.key
    )
      return;
    newConversationChoice.config = mirroredConfigurationChoice(
      draft,
      newConversationChoice.config,
    );
  }, [
    agentId,
    candidateSelected,
    requestCwd,
    service,
    explicitReadRequired,
    draft?.key,
    draft?.configOptions,
    draft?.configCheck,
    draft?.configuring,
    draft?.configError,
    draftError,
  ]);
  const pickProject = async (): Promise<boolean> => {
    if (
      picking ||
      unsent.pendingConversation ||
      draft?.submitting ||
      draft?.running
    )
      return false;
    locationOwner.current.retire();
    const selection = pair;
    setPicking(true);
    try {
      const picked = await chooseDirectory(cwd ?? undefined);
      if (
        picked &&
        mounted.current &&
        activeRef.current &&
        currentPair.current === selection
      ) {
        setDraftError(null);
        failedPairRef.current = null;
        setFolder(picked);
        requestPreparation();
        return true;
      }
      return false;
    } catch {
      if (
        mounted.current &&
        activeRef.current &&
        currentPair.current === selection
      )
        setDraftError({ message: STRINGS.repair.directoryFailed });
      return false;
    } finally {
      setPicking(false);
    }
  };
  const requireSendSelection = () => {
    if (!mounted.current || !activeRef.current || currentPair.current !== pair)
      throw new Error(STRINGS.repair.sendFailed);
    archiveGuard.requireAvailable();
    if (selectionReviewRef.current) throw new Error(R.selectionReview);
    if (readRequired()) throw new Error(C.readRequired);
    if (
      !agentId ||
      !isAutomaticConnectionAllowed(agentId) ||
      !isCurrentCandidate(agentId) ||
      needsAuthentication ||
      !setupStorage.completed(agentId)
    )
      throw new Error(STRINGS.repair.sendFailed);
  };
  const send = async (blocks: PromptBlock[], submittedDraft: ComposerDraft) => {
    const interrupted = draftPersistence.captureInteractionInterruption();
    if (interrupted()) throw new Error(STRINGS.repair.sendFailed);
    locationOwner.current.retire();
    const authenticationBlocked = (key = draftKey) => {
      if (!agentId) return true;
      const context =
        (key ? threads.thread(key)?.serviceContext : undefined) ??
        sourceContext;
      return (
        currentAuthenticationRequired(agentId, requestCwd, context) ||
        (!!service &&
          currentAuthenticationRequired(
            agentId,
            requestCwd,
            JSON.stringify(service),
          ))
      );
    };
    requireSendSelection();
    if (service) await requireCurrentService();
    if (interrupted()) throw new Error(STRINGS.repair.sendFailed);
    archiveGuard.requireAvailable();
    if (
      !mounted.current ||
      !activeRef.current ||
      currentPair.current !== pair ||
      selectionReviewRef.current
    )
      throw new Error(R.selectionReview);
    if (
      !agentId ||
      !isAutomaticConnectionAllowed(agentId) ||
      !isCurrentCandidate(agentId) ||
      !requestCwd ||
      needsAuthentication ||
      authenticationBlocked() ||
      !setupStorage.completed(agentId)
    )
      throw new Error(STRINGS.repair.sendFailed);
    if (submittedDraft.pendingConversation)
      throw new Error(STRINGS.repair.sendFailed);
    const sentPair = pair;
    const sentIntent = preparationIntent.current;
    const key = draftKey;
    const current = key ? threads.thread(key) : null;
    const sameSource = service
      ? current?.service?.id === service.id &&
        current.service.model === service.model
      : !current?.service;
    if (
      !key ||
      !current ||
      current.identity !== "draft" ||
      current.agentId !== agentId ||
      current.cwd !== requestCwd ||
      !sameSource
    )
      throw new Error(STRINGS.repair.sendFailed);
    handedOffKeys.current.add(key);
    let pending: PendingAttempt | undefined;
    try {
      archiveGuard.requireAvailable();
      const target = threads.thread(key);
      if (!target) throw new Error(STRINGS.repair.sendFailed);
      if (
        !isCurrentCandidate(agentId) ||
        !isAutomaticConnectionAllowed(agentId) ||
        currentPair.current !== sentPair ||
        authenticationBlocked(key)
      )
        throw new Error(STRINGS.repair.sendFailed);
      if (selectionReviewRef.current) throw new Error(R.selectionReview);
      if (readRequired()) throw new Error(C.readRequired);
      pending = await rememberPendingConversation(
        "new",
        submittedDraft,
        target,
      );
      if (service) await requireCurrentService();
      if (interrupted()) throw new Error(STRINGS.repair.sendFailed);
      archiveGuard.requireAvailable();
      if (
        !isCurrentCandidate(agentId) ||
        !isAutomaticConnectionAllowed(agentId) ||
        currentPair.current !== sentPair ||
        authenticationBlocked(key)
      )
        throw new Error(STRINGS.repair.sendFailed);
      if (selectionReviewRef.current) throw new Error(R.selectionReview);
      if (readRequired()) throw new Error(C.readRequired);
      await sendNewConversation(key, blocks, pending);
      finishPendingConversation(
        pending,
        threads.thread(key)?.uncertainPrompt ? "unknown" : "accepted",
      );
    } catch (error) {
      if (pending)
        finishPendingConversation(
          pending,
          threads.thread(key)?.uncertainPrompt ? "unknown" : "rejected",
        );
      const failed = threads.thread(key);
      if (
        failed?.identity === "draft" &&
        (!pending || failed === pending.state) &&
        (!pending || failed.connectionId === pending.connectionId) &&
        !failed.uncertainPrompt &&
        !failed.items.length &&
        !failed.queued.length
      ) {
        handedOffKeys.current.delete(key);
        if (
          !mounted.current ||
          currentPair.current !== sentPair ||
          error instanceof DraftArchiveBlockedError
        )
          void threads.discardDraft(key);
      }
      if (pending?.returnedToEditor) return false;
      throw error;
    }
    if (preparationIntent.current === sentIntent)
      preparationIntent.current = null;
    if (mounted.current && currentPair.current === sentPair) {
      setDraftKey(null);
      setDraftRevision((value) => value + 1);
      if (activeRef.current) onStarted(key);
    }
  };
  const agentSendable =
    !archiveBlocked &&
    candidateSelected &&
    connectionAllowed &&
    preparationComplete &&
    !needsAuthentication &&
    agentId !== null &&
    work.enabled(agentId) &&
    !opening;
  const ready =
    agentSendable &&
    cwd !== null &&
    draft !== null &&
    draft.identity === "draft" &&
    draft.agentId === agentId &&
    draft.cwd === requestCwd &&
    (service
      ? draft.service?.id === service.id &&
        draft.service?.model === service.model
      : !draft.service) &&
    !draft.connectionLost &&
    !draft.sourceError &&
    !draft.openError &&
    !draft.configuring;
  const sendOrPickFolder = useDraftSendIntent({
    pending: sendAfterFolder,
    pair,
    cwd: requestCwd,
    active,
    ready,
    error: draftError !== null,
    draft: unsent,
    requireCurrent: requireSendSelection,
    retireLocation: () => locationOwner.current.retire(),
    prepare: requestPreparation,
    send,
    pickProject,
    requestSend: () => setSendRequest((value) => value + 1),
    folderCancelled: setFolderCancelled,
  });
  const { editorRoot, editorHome } = usePreparedComposerPortal(
    composerTarget,
    active,
  );
  const presentedDraft = useRef<string | null>(null);
  const workspaceKey =
    draft?.key === draftKey &&
    (ready ||
      handedOffKeys.current.has(draftKey) ||
      presentedDraft.current === draftKey)
      ? draftKey
      : null;
  const composerOwner = preparedComposerOwner.current(workspaceKey);
  useSavedPreparedConversation(
    draft,
    composerOwner,
    preparedComposerOwner,
    onPreparedSaved,
    (key) => {
      handedOffKeys.current.add(key);
      preparationIntent.current = null;
      setDraftKey(null);
    },
  );
  useEffect(() => {
    presentedDraft.current = workspaceKey;
    onPreparedKey?.(workspaceKey);
    onPreparedComposerOwner?.(composerOwner);
  }, [onPreparedKey, onPreparedComposerOwner, workspaceKey, composerOwner]);
  useEffect(() => () => onPreparedKey?.(null), [onPreparedKey]);
  const sendingPaused = Boolean(
    cwd && agentId && work.ready && !work.enabled(agentId),
  );
  const modelReadError = !archiveBlocked
    ? newConversationPreparationError(draftError)
    : null;
  const note =
    (selectionNeedsReview ? R.selectionReview : null) ??
    (needsAuthentication
      ? A[service ? "apiAuthRequired" : "authRequired"]
      : null) ??
    (explicitReadRequired ? C.readRequired : null) ??
    (!connectionAllowed ? A.disconnectedHint : null) ??
    work.error ??
    (sendingPaused ? STRINGS.repair.workOff : null) ??
    confirmationFeedback(draftError, draft?.configError) ??
    (draft?.connectionLost ? STRINGS.thread.connectionIdle : null) ??
    (draft?.sourceError ? STRINGS.service.reconnect : null) ??
    (!agentId
      ? STRINGS.empty.agentRequired
      : !cwd
        ? agentSendable && folderCancelled
          ? STRINGS.empty.sendNeedsFolder
          : null
        : opening
          ? STRINGS.empty.opening
          : modelReadError);

  const needsPreparation =
    needsAuthentication ||
    !(preparationComplete && currentAgent && candidateSelected);
  const pickAgent = (id: string) => {
    if (
      !activeRef.current ||
      !isCurrentCandidate(id) ||
      !currentReadiness.current(id)
    )
      return;
    locationOwner.current.retire();
    setChoiceDialog(null);
    allowAutomaticConnection(id);
    requestPreparation();
    if (id === agentId) {
      if (!connectionAllowed || draft?.connectionLost || draftError) {
        failedPairRef.current = null;
        setDraftError(null);
        setDraftRevision((value) => value + 1);
      }
      return;
    }
    const selection = setupStorage.confirmedSelection(id);
    if (!setupStorage.completed(id) || !selection) {
      onGoSettings(id);
      return;
    }
    setSelectionNeedsReview(false);
    newConversationChoice.reviewRequired = false;
    setDraftKey(null);
    setService(selection.service);
    setAgentId(id);
    setDraftError(null);
    failedPairRef.current = null;
    newConversationChoice.config = { ...selection.config };
  };
  const prepareFromChoice = (id?: string) => {
    if (
      id &&
      !currentAgents.current.some(
        (card) => card.id === id && isAgentPresentable(card),
      )
    )
      return;
    setChoiceDialog(null);
    if (choiceDialog === "model" && isConfigurationRestoreNotice(draftError))
      openRepair();
    else onGoSettings(id);
  };
  const applyDraftConfig = async (id: string, value: unknown) => {
    const state = draft;
    const request = requestedAgent.current;
    const epoch = selectionEpoch.current;
    const sameOwner = state && captureConfigurationOwner(state);
    const current = () =>
      !!state &&
      mounted.current &&
      activeRef.current &&
      !!agentId &&
      isCurrentCandidate(agentId) &&
      !readRequired() &&
      currentPair.current === pair &&
      selectionEpoch.current === epoch &&
      requestedAgent.current === request &&
      threads.thread(state.key) === state &&
      state.agentId === agentId &&
      state.cwd === requestCwd &&
      sameOwner?.() === true &&
      (service
        ? state.service?.id === service.id &&
          state.service.model === service.model
        : !state.service);
    if (!state || !current()) throw new Error(STRINGS.repair.configFailed);
    const expected = configurationRestoreIntent(
      state,
      { ...newConversationChoice.config, [id]: value },
      service?.model,
    );
    applyingModel.current = state.key;
    try {
      const restored = await restoreSavedConfiguration(state, expected, {
        current,
        validateService: requireCurrentService,
        set: (optionId, optionValue) =>
          threads.setConfig(state.key, optionId, optionValue),
        confirm: (selection) =>
          threads.confirmRestoredConfig(state.key, selection),
      });
      if (!restored || !current()) throw new Error(STRINGS.repair.configFailed);
      newConversationChoice.config = expected;
      setDraftError(null);
    } catch (reason) {
      if (current()) setDraftError(configurationApplyNotice(reason));
      throw reason;
    } finally {
      if (applyingModel.current === state.key) applyingModel.current = null;
    }
  };
  const applyModel = async (choice: NewConversationModelChoice) => {
    locationOwner.current.retire();
    if (
      !activeRef.current ||
      currentPair.current !== pair ||
      !agentId ||
      !isCurrentCandidate(agentId)
    )
      throw new Error(STRINGS.repair.configFailed);
    const sameService =
      (!choice.service && !service) ||
      (!!choice.service &&
        !!service &&
        choice.service.id === service.id &&
        choice.service.model === service.model &&
        choice.service.revision === service.revision);
    if (sameService) {
      if (readRequired()) throw new Error(C.readRequired);
      // Explicit source choice releases review; unknown old options stay unapplied.
      if (selectionReviewRef.current) {
        requestPreparation();
        setDraftKey(null);
        newConversationChoice.config = {};
        setDraftError(null);
        failedPairRef.current = null;
        return true;
      }
      if (service || choice.modelValue === null) return true;
      if (
        !draft ||
        !modelOption ||
        draft.configuring ||
        !modelOption.options.some((item) => item.value === choice.modelValue)
      )
        throw new Error(STRINGS.repair.configFailed);
      const request = requestedAgent.current;
      const epoch = selectionEpoch.current;
      try {
        await applyDraftConfig(modelOption.id, choice.modelValue);
      } catch (reason) {
        if (
          !mounted.current ||
          !activeRef.current ||
          !isCurrentCandidate(agentId) ||
          readRequired() ||
          currentPair.current !== pair ||
          selectionEpoch.current !== epoch ||
          requestedAgent.current !== request
        )
          return false;
        throw reason;
      }
      return true;
    }
    // Choosing a different source only replaces the unsent draft's selection.
    // The normal preparation path checks it before sending is allowed.
    setDraftKey(null);
    newConversationChoice.config = {};
    setService(choice.service);
    requestPreparation();
    setDraftError(null);
    failedPairRef.current = null;
    setChoiceDialog(null);
    return true;
  };
  const agentChoiceTrigger = useRef<HTMLButtonElement>(null);
  const modelChoiceTrigger = useRef<HTMLButtonElement>(null);
  const controls = (
    <>
      <button
        type="button"
        ref={agentChoiceTrigger}
        className="new-choice-trigger"
        aria-label={W.agentChoice}
        aria-haspopup="dialog"
        disabled={!active || draft?.submitting || draft?.running}
        onClick={() => setChoiceDialog("agent")}
      >
        <span className="workspace-agent-label">
          {candidateSelected && currentAgent && (
            <AgentLogo card={currentAgent} />
          )}
          <span>
            {candidateSelected
              ? (currentAgent?.name ?? W.agentChoice)
              : W.agentChoice}
          </span>
        </span>
        <CaretDownIcon size={10} />
      </button>
      <span className="workspace-control-divider" />
      <button
        type="button"
        ref={modelChoiceTrigger}
        className="new-choice-trigger workspace-model-control"
        aria-label={W.modelChoice}
        aria-haspopup="dialog"
        onClick={() => {
          requestPreparation();
          setChoiceDialog("model");
        }}
        disabled={
          !active ||
          !agentId ||
          needsPreparation ||
          draft?.submitting ||
          draft?.running
        }
      >
        <span className="workspace-model-label">
          {service?.model ??
            (modelOption
              ? configValueLabel(modelOption)
              : opening
                ? STRINGS.empty.opening
                : sendingPaused && !needsPreparation
                  ? W.modelPaused
                  : W.modelPending)}
        </span>
        <CaretDownIcon size={10} />
      </button>
      {candidateSelected && draft && (
        <ReasoningControl
          thread={draft}
          inactive={!active}
          onApply={applyDraftConfig}
        />
      )}
      {candidateSelected && draft && (
        <PermissionControl thread={draft} inactive={!active} />
      )}
      {candidateSelected && draft && sessionOptions(draft, true).length > 0 && (
        <WorkspacePopover
          label={
            <>
              <span>{R.moreSettings}</span>
              <SlidersHorizontalIcon size={15} />
            </>
          }
          title={R.moreSettings}
          disabled={!active}
        >
          <SessionOptionsList
            thread={draft}
            composer
            onApply={applyDraftConfig}
          />
        </WorkspacePopover>
      )}
    </>
  );
  const editor = (
    <>
      {onRestoreDraft && (
        <PreservedDrafts
          availableFeedbackOwners={availableFeedbackOwners}
          onRestore={async (key) => {
            preparationIntent.current = null;
            pendingInquiryAbort.current?.abort();
            locationOwner.current.retire();
            selectionEpoch.current++;
            await onRestoreDraft(key);
            const restored = newConversationChoice;
            setFolder(restored.cwd);
            setAgentId(restored.agentId);
            setService(restored.service);
            const review =
              restored.reviewRequired === true ||
              Boolean(restored.service && !restored.service.revision);
            selectionReviewRef.current = review;
            setSelectionNeedsReview(review);
            newConversationChoice.reviewRequired = review;
            setDraftKey(null);
            setDraftError(null);
            failedPairRef.current = null;
            setDraftRevision((value) => value + 1);
          }}
        />
      )}
      <div className="workspace-start-intro" hidden={!!composerTarget}>
        <span className="workspace-start-kicker">{R.startKicker}</span>
        <h1>{R.startTitle}</h1>
        <p>{R.startSubtitle}</p>
      </div>
      {!hasMyAgent && (
        <div className="workspace-welcome">
          <h2>{W.welcomeTitle}</h2>
          <p>{W.welcomeHint}</p>
          {welcomeSuggestions.map((card) => (
            <button
              key={card.id}
              type="button"
              className="workspace-welcome-card"
              onClick={() => onGoSettings(card.id)}
            >
              <AgentLogo card={card} />
              <span>{card.name}</span>
              <small>
                {
                  agentStatus({
                    card,
                    prepared: hasSavedAgentPreparation(card.id),
                  }).label
                }
              </small>
              <strong>{W.welcomeConnect}</strong>
            </button>
          ))}
          <button
            type="button"
            className="btn btn-text workspace-welcome-browse"
            onClick={() => onGoSettings()}
          >
            {W.browseAgents}
          </button>
        </div>
      )}
      {archiveGuard.notice}
      <Composer
        suppressThreadOpenError={archiveBlocked}
        thread={draft}
        workLocation={cwd}
        workContext={
          agentId && requestCwd ? { agentId, cwd: requestCwd } : undefined
        }
        active={active}
        draftKey="new"
        errorContextKey={pair}
        imageEnabled={imageOk}
        audioEnabled={audioCapability(
          agents.find((a) => a.id === agentId)?.handshake,
        )}
        embedContext={caps.embeddedContext}
        onGoSettings={openRepair}
        onSend={sendOrPickFolder}
        sendRequest={sendRequest}
        onRequireFolder={() => void pickProject()}
        onRecoverPending={async (target) => {
          preparationIntent.current = null;
          locationOwner.current.retire();
          const key = await recoverPendingConversation(target);
          handedOffKeys.current.add(key);
          if (mounted.current && activeRef.current) {
            setDraftKey(null);
            setDraftRevision((value) => value + 1);
            onStarted(key);
          }
        }}
        disabled={
          !(ready || (agentSendable && !draft)) ||
          draftError !== null ||
          needsPreparation ||
          selectionNeedsReview
        }
        editableWhenDisabled
        prepareAction={
          (folder || needsAuthentication) && needsPreparation
            ? explicitReadRequired || needsAuthentication
              ? openRepair
              : !candidateSelected
                ? () => setChoiceDialog("agent")
                : () => onGoSettings(agentId ?? undefined)
            : undefined
        }
        placeholder={W.startPlaceholder}
        controls={controls}
        caption={
          !needsPreparation && service
            ? serviceLabel?.id === service.id
              ? serviceLabel.label
              : W.savedSource
            : undefined
        }
        note={note}
        noteAction={draftError !== null}
        autofocus={active}
        fit
      />
      <NewConversationLocationBar
        folder={folder}
        active={active}
        disabled={
          picking ||
          !!unsent.pendingConversation ||
          !!draft?.submitting ||
          !!draft?.running
        }
        preparationDisabled={
          archiveBlocked || selectionNeedsReview || !!draft?.configuring
        }
        onPick={() => void pickProject()}
        onClear={() => {
          locationOwner.current.retire();
          setFolder(null);
        }}
        beginWorkLocation={beginWorkLocation}
        beginPreparation={beginPreparation}
      />
      {(draftError ||
        draft?.connectionLost ||
        draft?.sourceError ||
        !connectionAllowed) && (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            if (agentId) allowAutomaticConnection(agentId);
            preparationIntent.current = { pair };
            failedPairRef.current = null;
            setDraftError(null);
            setDraftRevision((value) => value + 1);
          }}
        >
          {STRINGS.service.retry}
        </button>
      )}
      <div className="workspace-suggestions" hidden={!!composerTarget}>
        {!unsent.text &&
          !unsent.attachments.length &&
          W.suggestions.map((item, index) => {
            const Icon = suggestionIcons[index];
            return (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  composerDrafts.update("new", (draft) => ({
                    ...draft,
                    text: draft.text
                      ? `${draft.text}\n${item.text}`
                      : item.text,
                  }));
                }}
              >
                <Icon size={16} />
                {item.label}
              </button>
            );
          })}
        <button type="button" onClick={() => onGoSettings()}>
          <CompassIcon size={16} />
          {W.discover}
        </button>
      </div>
      {active && choiceDialog === "agent" && (
        <NewConversationAgentDialog
          returnFocusRef={agentChoiceTrigger}
          cards={agents}
          picked={agentId}
          prepared={preparedForConversation}
          needsAuth={(id) => authenticationRequired(authentication, id, null)}
          onPick={pickAgent}
          onPrepare={prepareFromChoice}
          onClose={() => setChoiceDialog(null)}
        />
      )}
      {active &&
        candidateSelected &&
        choiceDialog === "model" &&
        currentAgent && (
          <NewConversationModelDialog
            returnFocusRef={modelChoiceTrigger}
            key={pair}
            agent={currentAgent}
            value={{
              service,
              modelValue:
                !service && typeof modelOption?.currentValue === "string"
                  ? modelOption.currentValue
                  : null,
            }}
            existingOption={service ? null : modelOption}
            readingModels={opening || !!draft?.configuring}
            readError={modelReadError}
            onApply={async (choice) => {
              const request = requestedAgent.current;
              const epoch = selectionEpoch.current;
              const applied = await applyModel(choice);
              if (
                !applied ||
                requestedAgent.current !== request ||
                selectionEpoch.current !== epoch ||
                currentPair.current !== pair
              )
                return;
              selectionReviewRef.current = false;
              setSelectionNeedsReview(false);
              newConversationChoice.reviewRequired = false;
            }}
            onPrepare={() => prepareFromChoice(agentId ?? undefined)}
            onManageServices={
              onManageServices
                ? () => {
                    setChoiceDialog(null);
                    onManageServices();
                  }
                : undefined
            }
            onClose={() => setChoiceDialog(null)}
          />
        )}
    </>
  );
  return (
    <main className="main workspace-start">
      {header ?? (
        <div className="topbar">
          <div className="title">{STRINGS.topbar.newChatTitle}</div>
        </div>
      )}
      <div className="empty-wrap" ref={editorHome}>
        {!editorRoot && <div className="empty-col">{editor}</div>}
      </div>
      {editorRoot && createPortal(editor, editorRoot)}
    </main>
  );
}
