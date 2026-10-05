/**
 * 空态/开始页（F-start-empty）：项目选择 + Agent 选择 + 模型选择 +
 * 消息栏。Agent 选定后预开草稿会话以拿到模型选项；发送即把草稿变成
 * 真会话并切到会话页。
 */
import { createPortal } from "react-dom";
import { chooseDirectory } from "../runtime/dialogs";
import { uiError } from "../runtime/ui_error";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ServiceChoice } from "./ServicePicker";
import {
  listCredentials,
  subscribeCredentialChanges,
} from "../runtime/credentials";
import {
  NewConversationAgentDialog,
  NewConversationModelDialog,
  type NewConversationModelChoice,
} from "./NewConversationPickers";
import { Composer } from "./Composer";
import type { AgentCardModel } from "../runtime/agents";
import { promptCapabilities } from "../runtime/agents";
import {
  isAgentPresentable,
  isAgentReadyForConversation,
} from "../runtime/agent_directory";
import { useConversationAgentReadiness } from "../runtime/agent_readiness";
import {
  allowAutomaticConnection,
  isAutomaticConnectionAllowed,
  useAutomaticConnectionAllowed,
} from "../runtime/connection_intent";
import { useConnectionHold } from "../runtime/connection_hold";
import { ACCESS_STRINGS as A } from "../runtime/access_strings";
import {
  basename,
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
  FolderSimpleIcon,
  PencilLineIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "@phosphor-icons/react";

const suggestionIcons = [AirplaneTiltIcon, PencilLineIcon, BookOpenIcon];

export function EmptyState({
  agents,
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
  composerTarget,
}: {
  onPreparedKey?: (key: string | null) => void;
  composerTarget?: HTMLElement | null;
  header?: ReactNode;
  active?: boolean;
  agents: AgentCardModel[];
  defaultCwd: string | null;
  /** Explicit selection from Agent discovery. */
  initialAgentId?: string | null;
  initialAgentRevision?: number;
  initialSelection?: {
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
  // A new conversation starts only in a folder explicitly chosen by the user.
  // The application's preparation directory remains available to global setup.
  const cwd = folder;
  useEffect(() => {
    newConversationChoice.cwd = folder;
  }, [folder]);
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
  const [draftError, setDraftError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [picking, setPicking] = useState(false);
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
        (!needsAuthentication && draftError === STRINGS.repair.configFailed)
          ? "model"
          : agentRepairPanel(draft, needsAuthentication),
      needsAuthentication,
      sourceContext,
    });

  // Agent+项目确定 → 预开草稿会话，拿到 configOptions（模型选项）。
  // 草稿不写索引；切换/离开时丢弃并记墓碑（B1：不再产生幽灵会话）。
  // 选择变化防抖 250ms（划选项不起进程）；打开失败的组合不自动重试。
  const failedPairRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const pair = `${agentId}|${cwd}|${requestCwd}|${JSON.stringify(service)}`;
  const handedOffKeys = useRef(new Set<string>());
  const currentPair = useRef(pair);
  currentPair.current = pair;
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
    // Do not let the previous prepared conversation copy its options over a
    // newly confirmed selection while the replacement is opening.
    setDraftKey(null);
    if (initialSelection) {
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
  // Opening a search/settings page keeps the prepared draft. Returning only
  // opens when there is no draft and no request already in flight.
  useEffect(() => {
    if (active && !draftKey && !opening) setDraftRevision((value) => value + 1);
  }, [active]);

  useEffect(() => {
    if (unsent.pendingConversation) {
      setOpening(false);
      return;
    }
    if (!candidateSelected || !connectionAllowed) {
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
    let openedKey: string | null = null;
    const requestedConfig = { ...newConversationChoice.config };
    setDraftKey(null);
    setOpening(true);
    const timer = setTimeout(() => {
      if (
        !isCurrentCandidate(agentId) ||
        !isAutomaticConnectionAllowed(agentId) ||
        readRequired()
      ) {
        setOpening(false);
        return;
      }
      setOpening(true);
      setDraftError(null);
      threads
        .open({
          agentId,
          cwd: requestCwd!,
          service,
          serviceRevision: service?.revision,
          fresh: handedOffKeys.current.size > 0,
        })
        .then(async (state) => {
          openedKey = state.key;
          if (
            !isCurrentCandidate(agentId) ||
            !isAutomaticConnectionAllowed(agentId)
          )
            return;
          if (cancelled) {
            // A later effect can be awaiting the same store-deduplicated open.
            if (!mounted.current || currentPair.current !== pair)
              void threads.discardDraft(state.key);
            return;
          }
          const modelId = modelConfigOption(state.configOptions)?.id;
          const choices = Object.entries(requestedConfig).sort(
            ([a], [b]) => Number(b === modelId) - Number(a === modelId),
          );
          for (const [id, value] of choices) {
            if (
              cancelled ||
              !isCurrentCandidate(agentId) ||
              !isAutomaticConnectionAllowed(agentId) ||
              readRequired()
            )
              return;
            const option = threads
              .thread(state.key)
              ?.configOptions.find((item) => item.id === id);
            if (
              !option ||
              (value !== option.currentValue &&
                option.type === "select" &&
                !option.options.some((item) => item.value === value))
            )
              throw new Error(STRINGS.repair.configFailed);
            if (value !== option.currentValue)
              await threads.setConfig(state.key, id, value);
            if (
              threads
                .thread(state.key)
                ?.configOptions.find((item) => item.id === id)?.currentValue !==
              value
            )
              throw new Error(STRINGS.repair.configFailed);
          }
          if (
            !cancelled &&
            choices.some(
              ([id, value]) =>
                threads
                  .thread(state.key)
                  ?.configOptions.find((item) => item.id === id)
                  ?.currentValue !== value,
            )
          )
            throw new Error(STRINGS.repair.configFailed);
          if (cancelled) {
            // A later effect can be awaiting the same store-deduplicated open.
            if (!mounted.current || currentPair.current !== pair)
              void threads.discardDraft(state.key);
            return;
          }
          setDraftKey(state.key);
        })
        .catch((error) => {
          if (!cancelled) {
            failedPairRef.current = pair;
            setDraftError(uiError(error, STRINGS.repair.requestFailed));
          }
        })
        .finally(() => {
          if (!cancelled) setOpening(false);
        });
    }, 250);
    return () => {
      cancelled = true;
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
    newConversationChoice.config = Object.fromEntries(
      draft.configOptions.map((option) => [option.id, option.currentValue]),
    );
  }, [
    agentId,
    candidateSelected,
    requestCwd,
    service,
    explicitReadRequired,
    draft?.key,
    draft?.configOptions,
    draft?.configuring,
    draft?.configError,
    draftError,
  ]);

  const pickProject = async () => {
    if (
      picking ||
      unsent.pendingConversation ||
      draft?.submitting ||
      draft?.running
    )
      return;
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
      }
    } catch {
      if (
        mounted.current &&
        activeRef.current &&
        currentPair.current === selection
      )
        setDraftError(STRINGS.repair.directoryFailed);
    } finally {
      setPicking(false);
    }
  };

  const send = async (blocks: PromptBlock[], submittedDraft: ComposerDraft) => {
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
    if (!mounted.current || !activeRef.current || currentPair.current !== pair)
      throw new Error(STRINGS.repair.sendFailed);
    if (readRequired()) throw new Error(C.readRequired);
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
    let key = draftKey;
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
    ) {
      // Stale/discarded draft or the eager open still in flight — the
      // store dedupes a concurrent open for the same pair.
      const state = await threads.open({
        agentId,
        cwd: requestCwd,
        service,
        serviceRevision: service?.revision,
      });
      key = state.key;
    }
    // This waits for admission only; the actual agent work continues in the store.
    handedOffKeys.current.add(key);
    let pending: PendingAttempt | undefined;
    try {
      const target = threads.thread(key);
      if (!target) throw new Error(STRINGS.repair.sendFailed);
      if (
        !isCurrentCandidate(agentId) ||
        !isAutomaticConnectionAllowed(agentId) ||
        currentPair.current !== sentPair ||
        authenticationBlocked(key)
      )
        throw new Error(STRINGS.repair.sendFailed);
      if (readRequired()) throw new Error(C.readRequired);
      pending = await rememberPendingConversation(
        "new",
        submittedDraft,
        target,
      );
      if (
        !isCurrentCandidate(agentId) ||
        !isAutomaticConnectionAllowed(agentId) ||
        currentPair.current !== sentPair ||
        authenticationBlocked(key)
      )
        throw new Error(STRINGS.repair.sendFailed);
      if (readRequired()) throw new Error(C.readRequired);
      await sendNewConversation(key, blocks);
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
        !failed.uncertainPrompt &&
        !failed.items.length &&
        !failed.queued.length
      ) {
        handedOffKeys.current.delete(key);
        if (!mounted.current || currentPair.current !== sentPair)
          void threads.discardDraft(key);
      }
      throw error;
    }
    if (mounted.current && currentPair.current === sentPair) {
      setDraftKey(null);
      setDraftRevision((value) => value + 1);
      if (activeRef.current) onStarted(key);
    }
  };

  const ready =
    candidateSelected &&
    connectionAllowed &&
    preparationComplete &&
    !needsAuthentication &&
    agentId !== null &&
    cwd !== null &&
    work.enabled(agentId) &&
    !opening &&
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
  // Keep the original editor and its in-flight attachment/send state mounted.
  // Only its DOM host moves; the draft remains in the existing `new` slot.
  const [editorRoot] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );
  const editorHome = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const destination = composerTarget ?? editorHome.current;
    if (!editorRoot || !destination) return;
    const focused = editorRoot.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : null;
    editorRoot.className = "empty-col";
    destination.appendChild(editorRoot);
    if (activeRef.current) focused?.focus({ preventScroll: true });
  }, [editorRoot, composerTarget]);
  useEffect(() => () => editorRoot?.remove(), [editorRoot]);
  const presentedDraft = useRef<string | null>(null);
  const workspaceKey =
    draftKey &&
    (ready ||
      handedOffKeys.current.has(draftKey) ||
      presentedDraft.current === draftKey)
      ? draftKey
      : null;
  useEffect(() => {
    presentedDraft.current = workspaceKey;
    onPreparedKey?.(workspaceKey);
  }, [onPreparedKey, workspaceKey]);
  useEffect(() => () => onPreparedKey?.(null), [onPreparedKey]);

  const sendingPaused = Boolean(
    cwd && agentId && work.ready && !work.enabled(agentId),
  );
  const note =
    (explicitReadRequired ? C.readRequired : null) ??
    (!connectionAllowed ? A.disconnectedHint : null) ??
    work.error ??
    (sendingPaused ? STRINGS.repair.workOff : null) ??
    draft?.configError ??
    (draft?.connectionLost ? STRINGS.thread.connectionIdle : null) ??
    (draft?.sourceError ? STRINGS.service.reconnect : null) ??
    (!cwd
      ? STRINGS.empty.projectRequired
      : !agentId
        ? STRINGS.empty.agentRequired
        : opening
          ? STRINGS.empty.opening
          : draftError
            ? `${STRINGS.empty.openFailed}：${draftError}`
            : null);

  // Sending policy never changes whether the selected program is prepared.
  const needsPreparation =
    !preparationComplete || !currentAgent || !candidateSelected;
  const pickAgent = (id: string) => {
    if (!isCurrentCandidate(id) || !currentReadiness.current(id)) return;
    setChoiceDialog(null);
    allowAutomaticConnection(id);
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
    onGoSettings(id);
  };
  const applyModel = async (choice: NewConversationModelChoice) => {
    if (
      !activeRef.current ||
      currentPair.current !== pair ||
      !agentId ||
      !isCurrentCandidate(agentId)
    )
      throw new Error(STRINGS.repair.configFailed);
    const request = requestedAgent.current;
    const ownsApplication = () =>
      mounted.current &&
      isCurrentCandidate(agentId) &&
      !readRequired() &&
      currentPair.current === pair &&
      requestedAgent.current === request;
    const sameService =
      (!choice.service && !service) ||
      (!!choice.service &&
        !!service &&
        choice.service.id === service.id &&
        choice.service.model === service.model &&
        choice.service.revision === service.revision);
    if (sameService) {
      if (readRequired()) throw new Error(C.readRequired);
      if (service || choice.modelValue === null) return;
      if (
        !draft ||
        !modelOption ||
        draft.configuring ||
        !modelOption.options.some((item) => item.value === choice.modelValue)
      )
        throw new Error(STRINGS.repair.configFailed);
      if (modelOption.currentValue === choice.modelValue && !draftError) return;
      const expected = {
        ...newConversationChoice.config,
        [modelOption.id]: choice.modelValue,
      };
      applyingModel.current = draft.key;
      try {
        if (modelOption.currentValue !== choice.modelValue)
          await threads.setConfig(draft.key, modelOption.id, choice.modelValue);
        if (!ownsApplication()) return;
        if (
          threads
            .thread(draft.key)
            ?.configOptions.find((item) => item.id === modelOption.id)
            ?.currentValue !== choice.modelValue
        )
          throw new Error(STRINGS.repair.configFailed);
        for (const [id, value] of Object.entries(expected)) {
          if (!ownsApplication()) return;
          const current = threads.thread(draft.key);
          const option = current?.configOptions.find((item) => item.id === id);
          if (
            !option ||
            current?.configError ||
            current?.configuring ||
            (option.type === "select" &&
              value !== option.currentValue &&
              !option.options.some((item) => item.value === value))
          )
            throw new Error(STRINGS.repair.configFailed);
          if (value !== option.currentValue)
            await threads.setConfig(draft.key, id, value);
          if (
            threads
              .thread(draft.key)
              ?.configOptions.find((item) => item.id === id)?.currentValue !==
            value
          )
            throw new Error(STRINGS.repair.configFailed);
        }
        const confirmed = threads.thread(draft.key);
        if (
          !confirmed ||
          confirmed.configError ||
          confirmed.configuring ||
          Object.entries(expected).some(
            ([id, value]) =>
              confirmed.configOptions.find((item) => item.id === id)
                ?.currentValue !== value,
          )
        )
          throw new Error(STRINGS.repair.configFailed);
        if (ownsApplication()) {
          newConversationChoice.config = Object.fromEntries(
            confirmed.configOptions.map((option) => [
              option.id,
              option.currentValue,
            ]),
          );
          setDraftError(null);
        }
      } catch (reason) {
        if (ownsApplication()) setDraftError(STRINGS.repair.configFailed);
        throw reason;
      } finally {
        if (applyingModel.current === draft.key) applyingModel.current = null;
      }
      return;
    }
    // Choosing a different source only replaces the unsent draft's selection.
    // The normal preparation path checks it before sending is allowed.
    setDraftKey(null);
    newConversationChoice.config = {};
    setService(choice.service);
    setDraftError(null);
    failedPairRef.current = null;
    setChoiceDialog(null);
  };
  const agentChoiceTrigger = useRef<HTMLButtonElement>(null);
  const modelChoiceTrigger = useRef<HTMLButtonElement>(null);
  const controls = active ? (
    <>
      <button
        type="button"
        ref={agentChoiceTrigger}
        className="new-choice-trigger"
        aria-label={W.agentChoice}
        aria-haspopup="dialog"
        disabled={draft?.submitting || draft?.running}
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
        onClick={() => setChoiceDialog("model")}
        disabled={
          !agentId || needsPreparation || draft?.submitting || draft?.running
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
      {candidateSelected && draft && <ReasoningControl thread={draft} />}
      {candidateSelected && draft && <PermissionControl thread={draft} />}
      {candidateSelected && draft && sessionOptions(draft, true).length > 0 && (
        <WorkspacePopover
          label={<SlidersHorizontalIcon size={17} />}
          title={W.options}
          iconOnly
        >
          <SessionOptionsList thread={draft} composer />
        </WorkspacePopover>
      )}
    </>
  ) : null;

  const editor = (
    <>
      <div className="workspace-start-intro" hidden={!!composerTarget}>
        <h1>{W.startTitle}</h1>
        <p>{W.startSubtitle}</p>
      </div>
      <div className="workspace-folder-bar">
        <span className="workspace-folder-label">{W.workingFolder}</span>
        <button
          type="button"
          className={`workspace-folder-button${folder ? " selected" : ""}`}
          aria-label={folder ? W.changeFolder : W.folder}
          title={folder ?? undefined}
          disabled={
            picking ||
            !!unsent.pendingConversation ||
            draft?.submitting ||
            draft?.running
          }
          onClick={() => void pickProject()}
        >
          <FolderSimpleIcon size={18} />
          <span>{folder ? basename(folder) : W.folder}</span>
          <CaretDownIcon size={12} />
        </button>
        {folder && (
          <button
            type="button"
            className="workspace-folder-clear icon-btn"
            aria-label={W.clearFolder}
            disabled={
              picking ||
              !!unsent.pendingConversation ||
              draft?.submitting ||
              draft?.running
            }
            onClick={() => setFolder(null)}
          >
            <XIcon size={14} />
          </button>
        )}
      </div>
      <Composer
        thread={draft}
        workContext={
          agentId && requestCwd ? { agentId, cwd: requestCwd } : undefined
        }
        active={active}
        draftKey="new"
        errorContextKey={pair}
        imageEnabled={imageOk}
        embedContext={caps.embeddedContext}
        onGoSettings={openRepair}
        onSend={send}
        onRecoverPending={async (target) => {
          const key = await recoverPendingConversation(target);
          handedOffKeys.current.add(key);
          if (mounted.current && activeRef.current) {
            setDraftKey(null);
            setDraftRevision((value) => value + 1);
            onStarted(key);
          }
        }}
        disabled={!ready || draftError !== null || needsPreparation}
        editableWhenDisabled
        prepareAction={
          folder && needsPreparation
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
      {(draftError ||
        draft?.connectionLost ||
        draft?.sourceError ||
        !connectionAllowed) && (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            if (agentId) allowAutomaticConnection(agentId);
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
            onApply={applyModel}
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
