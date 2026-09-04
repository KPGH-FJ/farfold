import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Brain,
  Command as CommandIcon,
  FolderOpen,
  FolderSimple,
  SidebarSimple,
  X,
} from "@phosphor-icons/react";
import appIconUrl from "../../assets/app-icon.svg";
import { appendBounded } from "../runtime/event-buffer";
import { useHostSessionDraft } from "../runtime/host-draft";
import { updateHostSessionMetadata } from "../runtime/host-session-metadata";
import { stopHostOpenCodeRuntime } from "../runtime/host-runtime-lifecycle";
import {
  hydrateOpenCodeTimeline,
  initialOpenCodeConversation,
  latestOpenCodeModel,
  reduceOpenCodeEvent,
  unwrapOpenCodeEvent,
  type OpenCodeConversationState,
} from "../runtime/opencode-conversation";
import {
  acknowledgeHostRuntimeReconciliation,
  createHostOpenCodeSession,
  hostRuntimeReconciliationRequest,
  openHostSession,
  reconcileOpenCodeHostSession,
  runtimeEnvelopeFromHostEvent,
  subscribeHostShadowState,
  subscribeHostRuntimeEvents,
  type HostSessionBinding,
  type HostShadowState,
} from "../runtime/host-shadow";
import type { ThemeMode } from "../runtime/theme";
import {
  OPENCODE_RUNTIME_IDENTITY,
  abortOpenCodeTurn,
  discoverOpenCodeRuntime,
  openCodeProviderSnapshot,
  openCodeRuntimeStatus,
  openCodeSessionMessages,
  submitOpenCodeTurn,
  respondToOpenCodePermission,
  type OpenCodeEnvelope,
  type OpenCodeProviderModel,
  type OpenCodeProviderSnapshot,
  type OpenCodeRuntimeStatus,
  type OpenCodeSessionBindingRecord,
} from "../runtime/opencode";
import {
  failClosedInjectionDecision,
  parseOpenCodeLifeModelSources,
  prepareLifeModelInjection,
  type CreateProposalInput,
  type LifeModelSnapshot,
  type LifeModelSourceCandidate,
  type UpdateProposalInput,
} from "../runtime/lifemodel";
import { Composer } from "./Composer";
import { CommandPalette } from "./CommandPalette";
import { LifeModelPanel } from "./LifeModelPanel";
import { MessageContent } from "./MessageContent";
import { OpenCodePermissionCard } from "./OpenCodePermissionCard";
import { PiActivity } from "./PiActivity";
import { RuntimeChooser, type RuntimeProduct } from "./RuntimeChooser";
import { Sidebar, type SidebarSessionItem } from "./Sidebar";
import {
  sessionNavigationDisabled,
  sidebarSessionsFromHost,
} from "./sidebar-sessions";
import { SessionContextPanel } from "./SessionContextPanel";
import { SessionDeletionDialog } from "./SessionDeletionDialog";
import { WorkingCopyManagerDialog } from "./WorkingCopyManagerDialog";

const stopOpenCodeRuntime = stopHostOpenCodeRuntime;

interface OpenCodeWorkspaceProps {
  active: boolean;
  initialProjectPath: string | null;
  requestedHostSessionId: string | null;
  onRequestedHostSessionHandled: () => void;
  onProjectPath: (path: string) => void;
  onSelectRuntime: (runtime: RuntimeProduct) => void;
  onSelectHostSession: (session: SidebarSessionItem) => void;
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
  lifeModel: {
    open: boolean;
    snapshot: LifeModelSnapshot | null;
    candidates: LifeModelSourceCandidate[];
    selectedItemIds: string[];
    unavailable: string | null;
    busy: boolean;
    onOpen: () => void;
    onClose: () => void;
    onReload: () => void;
    onSources: (candidates: LifeModelSourceCandidate[]) => void;
    onSnapshot: (snapshot: LifeModelSnapshot) => void;
    onCreate: (input: CreateProposalInput) => void;
    onUpdate: (input: UpdateProposalInput) => void;
    onApprove: (proposalId: string) => void;
    onReject: (proposalId: string) => void;
    onDelete: (itemId: string) => void;
    onWithdrawSource: (itemId: string, sourceId: string) => void;
    onEnabled: (enabled: boolean) => void;
    onSelectItem: (itemId: string, selected: boolean) => void;
    onClearSelection: () => void;
  };
}

const initialStatus: OpenCodeRuntimeStatus = {
  state: "stopped",
  running: false,
  projectPath: null,
  endpoint: null,
  generation: 0,
  version: "1.15.13",
};

function projectName(path: string | null): string {
  if (!path) return "未选择 Project";
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function modelKey(model: OpenCodeProviderModel): string {
  return `${model.providerId}:${model.modelId}`;
}

function bindingFromHostSession(
  session: HostSessionBinding,
): OpenCodeSessionBindingRecord {
  return {
    farfoldSessionId: session.farfoldSessionId,
    runtime: OPENCODE_RUNTIME_IDENTITY,
    connectionId: session.connectionId,
    nativeSessionId: session.nativeSessionId,
    projectPath: session.workingCopyPath,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function OpenCodeWorkspace({
  active,
  initialProjectPath,
  requestedHostSessionId,
  onRequestedHostSessionHandled,
  onProjectPath,
  onSelectRuntime,
  onSelectHostSession,
  themeMode,
  onThemeMode,
  lifeModel,
}: OpenCodeWorkspaceProps) {
  const [status, setStatus] = useState(initialStatus);
  const [transition, setTransition] = useState<
    "discovering" | "starting" | "stopping" | null
  >("discovering");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [projectPath, setProjectPath] = useState(initialProjectPath);
  const [hostSessions, setHostSessions] = useState<HostSessionBinding[]>([]);
  const [hostPendingInteractions, setHostPendingInteractions] = useState<
    HostShadowState["pendingInteractions"]
  >([]);
  const [hostRestoreSessionId, setHostRestoreSessionId] = useState<
    string | null
  >(null);
  const [activeBinding, setActiveBinding] =
    useState<OpenCodeSessionBindingRecord | null>(null);
  const [conversation, setConversation] = useState<OpenCodeConversationState>(
    initialOpenCodeConversation,
  );
  const [providers, setProviders] = useState<OpenCodeProviderSnapshot | null>(
    null,
  );
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sessionContextOpen, setSessionContextOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [workingCopyManagerOpen, setWorkingCopyManagerOpen] = useState(false);
  const [sessionDeletionTarget, setSessionDeletionTarget] =
    useState<SidebarSessionItem | null>(null);
  const [lifeModelWarning, setLifeModelWarning] = useState<string | null>(null);
  const [lifeModelBypassOffered, setLifeModelBypassOffered] = useState(false);
  const generation = useRef(0);
  const activeBindingRef = useRef<OpenCodeSessionBindingRecord | null>(null);
  const rawFallbackEvents = useRef<OpenCodeEnvelope[]>([]);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const lifeModelSeenEntries = useRef<Map<string, Set<string>>>(new Map());
  const latestHostShadow = useRef<HostShadowState | null>(null);
  const lastHostReconciliation = useRef<string | null>(null);
  const hostReconciliation = useRef<Promise<void>>(Promise.resolve());
  const requestedSessionInFlight = useRef<string | null>(null);

  const selectedModel =
    providers?.models.find((model) => modelKey(model) === selectedModelKey) ??
    null;
  const ready = Boolean(
    status.running &&
    activeBinding &&
    selectedModel &&
    !transition &&
    !reconciling,
  );
  const working = conversation.isWorking;
  const openCodeHostSessions = useMemo(
    () =>
      hostSessions.filter(
        (session) =>
          session.runtimeProductId === "opencode" &&
          session.archivedAt === null,
      ),
    [hostSessions],
  );
  const sidebarSessions = useMemo<SidebarSessionItem[]>(
    () => sidebarSessionsFromHost(hostSessions, hostPendingInteractions),
    [hostSessions, hostPendingInteractions],
  );
  const activeSessionKey =
    openCodeHostSessions.find(
      (session) => session.nativeSessionId === activeBinding?.nativeSessionId,
    )?.farfoldSessionId ?? null;
  const activeHostSession =
    openCodeHostSessions.find(
      (session) => session.farfoldSessionId === activeSessionKey,
    ) ?? null;
  const restoredSession =
    openCodeHostSessions.find(
      (session) => session.farfoldSessionId === hostRestoreSessionId,
    ) ?? null;
  const openCodeDraftSessionId =
    activeSessionKey ?? restoredSession?.farfoldSessionId ?? null;
  const [message, setMessage] = useHostSessionDraft(
    openCodeDraftSessionId,
    (reason) => setError(`草稿：${String(reason)}`),
  );
  const selectedLifeModelItems = useMemo(
    () =>
      lifeModel.selectedItemIds.flatMap((itemId) => {
        const item = lifeModel.snapshot?.items.find(
          (candidate) => candidate.id === itemId,
        );
        return item ? [item] : [];
      }),
    [lifeModel.selectedItemIds, lifeModel.snapshot?.items],
  );
  const groupedTimeline = useMemo(() => {
    type TimelineEntry = (typeof conversation.timeline)[number];
    type ToolEntry = Extract<TimelineEntry, { kind: "tool" }>;
    type DisplayEntry =
      TimelineEntry | { kind: "tools"; id: string; tools: ToolEntry[] };
    return conversation.timeline.reduce<DisplayEntry[]>((groups, item) => {
      if (item.kind !== "tool") {
        groups.push(item);
        return groups;
      }
      const previous = groups.at(-1);
      if (previous?.kind === "tools") previous.tools.push(item);
      else groups.push({ kind: "tools", id: item.id, tools: [item] });
      return groups;
    }, []);
  }, [conversation.timeline]);

  useEffect(() => {
    activeBindingRef.current = activeBinding;
  }, [activeBinding]);

  useEffect(() => {
    setProjectPath(initialProjectPath);
  }, [initialProjectPath]);

  async function loadHistory(
    binding: OpenCodeSessionBindingRecord,
    collectLifeModelSources = false,
  ) {
    const history = await openCodeSessionMessages(binding.nativeSessionId);
    if (activeBindingRef.current?.nativeSessionId !== binding.nativeSessionId)
      return;
    const nativeModel = latestOpenCodeModel(history);
    if (nativeModel)
      setSelectedModelKey(
        modelKey({
          providerId: nativeModel.providerId,
          modelId: nativeModel.modelId,
          name: nativeModel.modelId,
          status: "unknown",
        }),
      );
    setConversation((current) => ({
      ...current,
      timeline: hydrateOpenCodeTimeline(history),
    }));
    const candidates = parseOpenCodeLifeModelSources(
      history,
      binding.farfoldSessionId,
      binding.nativeSessionId,
    );
    const seen =
      lifeModelSeenEntries.current.get(binding.nativeSessionId) ?? new Set();
    const unseen = candidates.filter(
      (candidate) => !seen.has(candidate.nativeEntryId),
    );
    candidates.forEach((candidate) => seen.add(candidate.nativeEntryId));
    lifeModelSeenEntries.current.set(binding.nativeSessionId, seen);
    if (collectLifeModelSources && unseen.length) lifeModel.onSources(unseen);
  }

  function queueOpenCodeHostReconciliation(state: HostShadowState): void {
    latestHostShadow.current = state;
    setHostRestoreSessionId(
      state.navigation.restoreState?.lastSessionId ?? null,
    );
    setHostSessions(state.navigation.sessionIndex.sessions);
    setHostPendingInteractions(state.pendingInteractions);
    const request = hostRuntimeReconciliationRequest(
      state,
      OPENCODE_RUNTIME_IDENTITY.installationId,
    );
    const binding = activeBindingRef.current;
    if (
      !request ||
      !binding ||
      request.key === lastHostReconciliation.current
    ) {
      return;
    }
    lastHostReconciliation.current = request.key;
    setReconciling(true);
    setConversation((current) => ({ ...current, permissions: [] }));
    hostReconciliation.current = hostReconciliation.current
      .catch(() => undefined)
      .then(async () => {
        const current = await openCodeRuntimeStatus();
        generation.current = Math.max(generation.current, current.generation);
        setStatus((previous) => {
          if (previous.running && !current.running) {
            setConversation((conversation) => ({
              ...conversation,
              isWorking: false,
            }));
            setError(
              "OpenCode Server 已退出；原生 Session 绑定仍保留，可重新打开恢复。",
            );
          }
          return current;
        });
        if (!current.running) {
          acknowledgeHostRuntimeReconciliation(request);
          setReconciling(false);
          return;
        }
        const reconciled = await reconcileOpenCodeHostSession(
          binding.nativeSessionId,
        );
        if (reconciled.runtimeGeneration !== current.generation) {
          throw new Error(
            "OpenCode reconciliation returned a different Runtime generation.",
          );
        }
        await loadHistory(binding, true);
        acknowledgeHostRuntimeReconciliation(request);
        setReconciling(false);
      })
      .catch((reason) => {
        setError(`OpenCode 状态重建失败：${String(reason)}`);
      });
  }

  useEffect(() => {
    let cancelled = false;
    void openCodeRuntimeStatus()
      .then((currentStatus) => {
        if (cancelled) return;
        generation.current = currentStatus.generation;
        setStatus(currentStatus);
        if (currentStatus.projectPath)
          setProjectPath(currentStatus.projectPath);
        if (currentStatus.running) {
          void openCodeProviderSnapshot().then((snapshot) => {
            if (!cancelled) {
              setProviders(snapshot);
              const firstModel = snapshot.models[0];
              if (firstModel)
                setSelectedModelKey(
                  (current) => current ?? modelKey(firstModel),
                );
            }
          });
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    void discoverOpenCodeRuntime()
      .then(() => {
        if (!cancelled) setAvailable(true);
      })
      .catch((reason) => {
        if (!cancelled) {
          setAvailable(false);
          setError(String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setTransition(null);
      });

    function handleOpenCodeEvent(event: OpenCodeEnvelope) {
      if (event.generation < generation.current) return;
      generation.current = event.generation;
      const binding = activeBindingRef.current;
      if (!binding) return;
      setConversation((current) => {
        const next = reduceOpenCodeEvent(
          current,
          event,
          binding.nativeSessionId,
        );
        if (next.unknownEventCount > current.unknownEventCount) {
          rawFallbackEvents.current = appendBounded(
            rawFallbackEvents.current,
            event,
            64,
          );
        }
        return next;
      });
      const native = unwrapOpenCodeEvent(event.payload);
      if (
        native?.type === "session.idle" &&
        native.properties.sessionID === binding.nativeSessionId
      ) {
        void loadHistory(binding, true).catch((reason) =>
          setError(String(reason)),
        );
      }
    }

    const stopRuntimeEvents = subscribeHostRuntimeEvents((routed) => {
      if (routed.runtime.productId !== "opencode") return;
      const envelope = runtimeEnvelopeFromHostEvent(routed);
      if (
        !envelope ||
        !["sse", "protocol_error", "transport_error"].includes(envelope.kind)
      ) {
        return;
      }
      handleOpenCodeEvent(envelope as OpenCodeEnvelope);
    });
    const stopHostState = subscribeHostShadowState(
      queueOpenCodeHostReconciliation,
    );

    return () => {
      cancelled = true;
      stopRuntimeEvents();
      stopHostState();
    };
  }, []);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversation.timeline, conversation.permissions]);

  useEffect(() => {
    if (
      !requestedHostSessionId ||
      transition !== null ||
      working ||
      reconciling ||
      requestedSessionInFlight.current
    ) {
      return;
    }
    const requested = openCodeHostSessions.find(
      (session) => session.farfoldSessionId === requestedHostSessionId,
    );
    if (!requested) return;
    requestedSessionInFlight.current = requestedHostSessionId;
    void openHostOpenCodeSession(requested).finally(() => {
      requestedSessionInFlight.current = null;
      onRequestedHostSessionHandled();
    });
  }, [
    requestedHostSessionId,
    transition,
    working,
    reconciling,
    openCodeHostSessions,
  ]);

  async function chooseProject() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 OpenCode Project",
    });
    if (typeof selected !== "string") return;
    setProjectPath(selected);
    onProjectPath(selected);
  }

  async function createAndOpenSession(projectOverride?: string) {
    const targetProject = projectOverride ?? projectPath;
    if (!targetProject) return;
    if (transition || working || reconciling) {
      if (projectOverride) {
        throw new Error("当前 OpenCode Session 正忙，不能切换 Working Copy。");
      }
      return;
    }
    setError(null);
    try {
      if (status.running) {
        setTransition("stopping");
        const stopped = await stopOpenCodeRuntime();
        generation.current = stopped.generation;
        setStatus(stopped);
      }
      setTransition("starting");
      const created = await createHostOpenCodeSession(targetProject);
      if (created.runtimeProductId !== "opencode") {
        throw new Error(
          "Host created a non-OpenCode Session in this workspace.",
        );
      }
      const currentStatus = await openCodeRuntimeStatus();
      generation.current = currentStatus.generation;
      setStatus(currentStatus);
      setProjectPath(targetProject);
      onProjectPath(targetProject);
      const session = created.navigation.sessionIndex.sessions.find(
        (candidate) => candidate.farfoldSessionId === created.farfoldSessionId,
      );
      if (!session) {
        throw new Error("Host navigation omitted the new OpenCode Session.");
      }
      const binding = bindingFromHostSession(session);
      const snapshot = await openCodeProviderSnapshot();
      setProviders(snapshot);
      const firstModel = snapshot.models[0];
      if (firstModel) {
        setSelectedModelKey((current) => current ?? modelKey(firstModel));
      }
      activeBindingRef.current = binding;
      setActiveBinding(binding);
      setConversation(initialOpenCodeConversation);
      if (latestHostShadow.current) {
        queueOpenCodeHostReconciliation(latestHostShadow.current);
      }
      await loadHistory(binding);
      setTransition(null);
    } catch (reason) {
      setError(String(reason));
      setTransition(null);
      if (projectOverride) throw reason;
    }
  }

  async function openHostOpenCodeSession(session: HostSessionBinding) {
    if (
      working ||
      transition ||
      reconciling ||
      session.nativeSessionId === activeBinding?.nativeSessionId
    )
      return;
    setError(null);
    try {
      if (status.running) {
        setTransition("stopping");
        const stopped = await stopOpenCodeRuntime();
        generation.current = stopped.generation;
        setStatus(stopped);
      }
      setTransition("starting");
      const opened = await openHostSession(session.farfoldSessionId);
      if (opened.runtimeProductId !== "opencode") {
        throw new Error(
          "Host opened a non-OpenCode Session in this workspace.",
        );
      }
      const currentStatus = await openCodeRuntimeStatus();
      generation.current = currentStatus.generation;
      setStatus(currentStatus);
      setProjectPath(session.workingCopyPath);
      onProjectPath(session.workingCopyPath);
      const openedSession = opened.navigation.sessionIndex.sessions.find(
        (candidate) => candidate.farfoldSessionId === session.farfoldSessionId,
      );
      if (!openedSession) {
        throw new Error("Host navigation omitted the opened OpenCode Session.");
      }
      const binding = bindingFromHostSession(openedSession);
      const providerSnapshot = await openCodeProviderSnapshot();
      setProviders(providerSnapshot);
      const firstModel = providerSnapshot.models[0];
      if (firstModel) {
        setSelectedModelKey((current) => current ?? modelKey(firstModel));
      }
      activeBindingRef.current = binding;
      setActiveBinding(binding);
      setConversation(initialOpenCodeConversation);
      if (latestHostShadow.current) {
        queueOpenCodeHostReconciliation(latestHostShadow.current);
      }
      await loadHistory(binding);
      setTransition(null);
    } catch (reason) {
      setError(String(reason));
      setTransition(null);
    }
  }

  async function toggleOpenCodeSessionPinned(
    session: SidebarSessionItem,
  ): Promise<void> {
    if (working || submitting || transition || reconciling) return;
    setError(null);
    try {
      await updateHostSessionMetadata({
        farfoldSessionId: session.key,
        pinned: !session.pinned,
      });
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function archiveOpenCodeSession(
    session: SidebarSessionItem,
  ): Promise<void> {
    if (working || submitting || transition || reconciling) return;
    if (
      !window.confirm(
        `归档“${session.title}”？Farfold 会保留 ${session.runtimeLabel} 原生 Session 与历史。`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      if (status.running && session.key === activeSessionKey) {
        setTransition("stopping");
        const stopped = await stopOpenCodeRuntime();
        generation.current = stopped.generation;
        setStatus(stopped);
      }
      await updateHostSessionMetadata({
        farfoldSessionId: session.key,
        archived: true,
      });
      if (session.key === activeSessionKey) {
        activeBindingRef.current = null;
        setActiveBinding(null);
        setConversation(initialOpenCodeConversation);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setTransition(null);
    }
  }

  async function restoreArchivedSession(
    session: SidebarSessionItem,
  ): Promise<void> {
    if (working || submitting || transition || reconciling) return;
    setError(null);
    try {
      await updateHostSessionMetadata({
        farfoldSessionId: session.key,
        archived: false,
      });
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function send(withoutLifeModel = false) {
    const text = message.trim();
    if (!text || !ready || !activeBinding || !selectedModel || submitting)
      return;
    setSubmitting(true);
    setError(null);
    setLifeModelWarning(null);
    const wantedInjection =
      !withoutLifeModel &&
      lifeModel.snapshot?.enabled === true &&
      lifeModel.selectedItemIds.length > 0;
    let stagedManifestId: string | null = null;
    const localMessageId = `local-${Date.now()}`;
    try {
      if (!activeHostSession) {
        throw new Error(
          "Host Session binding is unavailable for this OpenCode Turn.",
        );
      }
      if (wantedInjection) {
        try {
          const preparedInjection = await prepareLifeModelInjection(
            activeHostSession.farfoldSessionId,
            lifeModel.selectedItemIds,
          );
          stagedManifestId = preparedInjection.manifestId;
        } catch (reason) {
          const decision = failClosedInjectionDecision("OpenCode", reason);
          setLifeModelWarning(decision.message);
          setLifeModelBypassOffered(decision.offerWithoutLifeModel);
          if (!decision.submitUserMessage) return;
        }
      }
      setLifeModelBypassOffered(false);
      setMessage("");
      setConversation((current) => ({
        ...current,
        isWorking: true,
        notice: null,
        timeline: [
          ...current.timeline,
          {
            kind: "message",
            id: localMessageId,
            role: "user",
            text,
          },
        ],
      }));
      await submitOpenCodeTurn({
        farfoldSessionId: activeHostSession.farfoldSessionId,
        nativeSessionId: activeBinding.nativeSessionId,
        providerId: selectedModel.providerId,
        modelId: selectedModel.modelId,
        text,
        ...(stagedManifestId ? { lifeModelManifestId: stagedManifestId } : {}),
      });
      if (wantedInjection) lifeModel.onClearSelection();
    } catch (reason) {
      setMessage(text);
      setConversation((current) => ({
        ...current,
        isWorking: false,
        timeline: current.timeline.filter(
          (item) => !(item.kind === "message" && item.id === localMessageId),
        ),
      }));
      if (stagedManifestId) {
        const decision = failClosedInjectionDecision("OpenCode", reason);
        setLifeModelWarning(decision.message);
        setLifeModelBypassOffered(decision.offerWithoutLifeModel);
      }
      setError(String(reason));
    } finally {
      setSubmitting(false);
    }
  }

  async function abort() {
    if (!activeBinding || !activeHostSession || !working) return;
    try {
      await abortOpenCodeTurn({
        farfoldSessionId: activeHostSession.farfoldSessionId,
        nativeSessionId: activeBinding.nativeSessionId,
      });
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function respondPermission(response: "once" | "always" | "reject") {
    const request = conversation.permissions[0];
    if (!request || !activeBinding || permissionBusy || reconciling) return;
    setPermissionBusy(true);
    try {
      await respondToOpenCodePermission({
        sessionId: activeBinding.nativeSessionId,
        permissionId: request.id,
        response,
      });
      setConversation((current) => ({
        ...current,
        permissions: current.permissions.filter(
          (permission) => permission.id !== request.id,
        ),
      }));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPermissionBusy(false);
    }
  }

  async function selectRuntime(runtime: RuntimeProduct) {
    if (runtime === "opencode" || transition || reconciling) return;
    onSelectRuntime(runtime);
  }

  const currentProject = status.projectPath ?? projectPath;
  const runtimeState = reconciling
    ? "OpenCode 正在重建状态"
    : working
      ? "OpenCode 正在工作"
      : transition === "starting"
        ? "OpenCode 正在启动"
        : transition === "stopping"
          ? "OpenCode 正在停止"
          : status.running
            ? "OpenCode 已启动"
            : "OpenCode 未启动";

  if (!active) return null;

  return (
    <div className={`app-shell${sessionContextOpen ? " context-open" : ""}`}>
      <Sidebar
        sessions={sidebarSessions}
        activeSessionKey={
          activeSessionKey ?? restoredSession?.farfoldSessionId ?? null
        }
        search={search}
        disabled={working || submitting || Boolean(transition) || reconciling}
        isSessionSelectionDisabled={(session) =>
          sessionNavigationDisabled(
            "opencode",
            session.runtimeProductId,
            working,
            submitting || Boolean(transition) || reconciling,
          )
        }
        connectedProviderCount={providers?.connectedProviderIds.length ?? 0}
        attentionCount={hostPendingInteractions.length}
        settingsTitle="OpenCode Provider"
        settingsSubtitle={
          providers
            ? `${providers.connectedProviderIds.length} 个原生连接 · 账户状态未知`
            : "由 OpenCode 原生配置管理"
        }
        onSearch={setSearch}
        onNew={() => void createAndOpenSession()}
        onSelect={(item) => {
          if (item.runtimeProductId !== "opencode") {
            onSelectHostSession(item);
            return;
          }
          const session = hostSessions.find(
            (candidate) => candidate.farfoldSessionId === item.key,
          );
          if (session) void openHostOpenCodeSession(session);
        }}
        onTogglePinned={(item) => void toggleOpenCodeSessionPinned(item)}
        onArchive={archiveOpenCodeSession}
        onRestore={restoreArchivedSession}
        onDelete={setSessionDeletionTarget}
        onOpenConnections={() =>
          setError(
            "OpenCode Provider 与凭据由 OpenCode 原生配置管理；Farfold 只读取官方 /provider readiness，不读取凭据。",
          )
        }
      />

      <main className="workspace">
        <header className="workspace-header">
          <div className="session-title">
            <h1>
              {activeHostSession?.title ??
                activeBinding?.title ??
                restoredSession?.title ??
                "OpenCode"}
            </h1>
          </div>
          <div className="header-meta">
            {providers?.models.length ? (
              <label className="runtime-model-select">
                <span className="sr-only">OpenCode Provider 与模型</span>
                <select
                  value={selectedModel ? modelKey(selectedModel) : ""}
                  disabled={working || Boolean(transition) || reconciling}
                  onChange={(event) => setSelectedModelKey(event.target.value)}
                >
                  {!selectedModel && (
                    <option value="" disabled>
                      {selectedModelKey
                        ? "上次使用的模型当前不可用"
                        : "选择 OpenCode 模型"}
                    </option>
                  )}
                  {providers.models.map((model) => (
                    <option key={modelKey(model)} value={modelKey(model)}>
                      {model.name} · {model.providerId}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="runtime-model-empty">Provider 未验证</span>
            )}
            <span className="header-separator" />
            <RuntimeChooser
              value="opencode"
              disabled={submitting || Boolean(transition) || reconciling}
              onChange={(runtime) => void selectRuntime(runtime)}
            />
            <span className="header-separator context-separator" />
            <button
              className="header-project"
              data-lifemodel-trigger
              onClick={lifeModel.onOpen}
              title="打开 LifeModel"
            >
              <Brain size={14} />
              LifeModel
              {lifeModel.snapshot?.items.length
                ? ` · ${lifeModel.snapshot.items.length}`
                : ""}
            </button>
            <span className="header-separator context-separator" />
            <button
              className="header-project"
              title={currentProject ?? undefined}
              onClick={() => void chooseProject()}
              disabled={working || Boolean(transition) || reconciling}
            >
              <FolderSimple size={14} />
              {projectName(currentProject)}
            </button>
            <span className="header-separator context-separator" />
            <div className={`runtime-state${working ? " working" : ""}`}>
              <i />
              {runtimeState}
            </div>
            <button
              className="header-context"
              data-session-context-trigger
              type="button"
              aria-pressed={sessionContextOpen}
              onClick={() => setSessionContextOpen((current) => !current)}
            >
              <SidebarSimple size={15} />
              详情
            </button>
            <button
              className="header-context header-command"
              type="button"
              aria-label="打开命令面板"
              title="命令面板（⌘⇧P）"
              onClick={() => setCommandPaletteOpen(true)}
            >
              <CommandIcon size={15} />
              <span>命令</span>
            </button>
          </div>
        </header>

        <div className="runtime-contract-strip" role="status">
          <span>OpenCode 1.15.13 · HTTP/SSE</span>
          <i />
          <span>Base=yes</span>
          <span>Contributes=yes</span>
          <span>Uses=yes</span>
          <em>Provider / model / account 分开判断</em>
        </div>

        <section className="conversation-scroll" aria-live="polite">
          {!status.running ? (
            <div className="start-state">
              <img src={appIconUrl} alt="" />
              <h2>
                {restoredSession
                  ? "继续最近的 OpenCode 对话"
                  : "通过 OpenCode 开始"}
              </h2>
              <p>
                Farfold 会启动固定版本的 OpenCode Server；Agent
                loop、Provider、模型与权限仍由 OpenCode 自己负责。
              </p>
              <div className="runtime-entry-state">
                <span>Runtime</span>
                <strong>OpenCode 1.15.13</strong>
                <em className={available ? "configured" : ""}>
                  {available === null
                    ? "正在发现"
                    : available
                      ? "已固定 · 待实际验证"
                      : "本机构建未准备"}
                </em>
              </div>
              <button
                className="project-picker"
                onClick={() => void chooseProject()}
                disabled={Boolean(transition) || reconciling}
              >
                <FolderOpen size={20} />
                <span>
                  <small>Project</small>
                  <strong>{projectPath ?? "选择文件夹"}</strong>
                </span>
              </button>
              <div className="start-actions">
                <button
                  className="start-primary"
                  onClick={() =>
                    void (restoredSession
                      ? openHostOpenCodeSession(restoredSession)
                      : createAndOpenSession())
                  }
                  disabled={
                    !projectPath ||
                    !available ||
                    Boolean(transition) ||
                    reconciling
                  }
                >
                  {transition === "starting"
                    ? "正在启动…"
                    : restoredSession
                      ? "继续对话"
                      : "新建 OpenCode Session"}
                </button>
                {restoredSession && (
                  <button
                    onClick={() => void createAndOpenSession()}
                    disabled={
                      !projectPath ||
                      !available ||
                      Boolean(transition) ||
                      reconciling
                    }
                  >
                    新建 Session
                  </button>
                )}
              </div>
            </div>
          ) : conversation.timeline.length === 0 ? (
            <div className="empty-conversation">
              <span className="brand-letter">F</span>
              <h2>现在想交给 OpenCode 什么？</h2>
              <p>
                当前 Farfold Session 固定绑定{" "}
                {activeBinding?.nativeSessionId ?? "新的原生 Session"}
                ，不会与 Pi Session 互换状态。
              </p>
            </div>
          ) : (
            <div className="message-list">
              {groupedTimeline.map((item) =>
                item.kind === "message" ? (
                  <article
                    className={`message ${item.role}${item.error ? " error-message" : ""}`}
                    key={`message-${item.id}`}
                  >
                    {item.role === "assistant" && (
                      <span className="assistant-mark">F</span>
                    )}
                    <div>
                      <p className="message-label">
                        {item.role === "user" ? "你" : "Farfold · OpenCode"}
                      </p>
                      {item.role === "assistant" ? (
                        <MessageContent
                          text={item.text || (item.pending ? "正在思考…" : "")}
                          thinking={item.thinking}
                        />
                      ) : (
                        <p className="message-text">{item.text}</p>
                      )}
                    </div>
                  </article>
                ) : item.kind === "tools" ? (
                  <PiActivity
                    key={`tools-${item.id}`}
                    tools={item.tools}
                    notice={null}
                    runtimeLabel="OpenCode"
                  />
                ) : null,
              )}
              <PiActivity
                tools={[]}
                notice={conversation.notice}
                runtimeLabel="OpenCode"
              />
              {conversation.permissions[0] && (
                <OpenCodePermissionCard
                  request={conversation.permissions[0]}
                  busy={permissionBusy}
                  onRespond={(response) => void respondPermission(response)}
                />
              )}
            </div>
          )}
          <div ref={transcriptEnd} />
        </section>

        <div className="runtime-notices">
          {lifeModelWarning && (
            <div className="extension-notice warning" role="status">
              <span>{lifeModelWarning}</span>
              <div className="notice-actions">
                {lifeModelBypassOffered && (
                  <button
                    className="notice-action"
                    onClick={() => void send(true)}
                    disabled={submitting}
                  >
                    不使用 LifeModel 发送
                  </button>
                )}
                <button
                  onClick={() => {
                    setLifeModelWarning(null);
                    setLifeModelBypassOffered(false);
                  }}
                  aria-label="关闭 LifeModel 通知"
                >
                  <X size={15} />
                </button>
              </div>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button onClick={() => setError(null)} aria-label="关闭错误">
                <X size={15} />
              </button>
            </div>
          )}
        </div>

        <Composer
          runtimeLabel="OpenCode"
          supportsSteering={false}
          running={
            status.running &&
            Boolean(activeBinding) &&
            !transition &&
            !reconciling
          }
          ready={ready && !working}
          working={working}
          submitting={submitting}
          message={message}
          delivery="steer"
          projectName={projectName(currentProject)}
          contextPercent={null}
          commands={[]}
          lifeModelItems={selectedLifeModelItems.map((item) => ({
            id: item.id,
            label: `${item.key}: ${item.value}`,
          }))}
          onMessage={setMessage}
          onDelivery={() => undefined}
          onSend={() => void send()}
          onAbort={() => void abort()}
          onRemoveLifeModelItem={(itemId) =>
            lifeModel.onSelectItem(itemId, false)
          }
          onOpenLifeModel={lifeModel.onOpen}
        />
      </main>
      {sessionContextOpen && (
        <SessionContextPanel
          session={activeHostSession ?? restoredSession}
          lifeModelItemCount={lifeModel.snapshot?.items.length ?? 0}
          onOpenLifeModel={lifeModel.onOpen}
          onCreateSessionInWorktree={async (workingCopyPath) => {
            await createAndOpenSession(workingCopyPath);
          }}
          onManageWorkingCopies={() => {
            setSessionContextOpen(false);
            setWorkingCopyManagerOpen(true);
          }}
          onClose={() => setSessionContextOpen(false)}
        />
      )}
      <CommandPalette
        open={commandPaletteOpen}
        themeMode={themeMode}
        onOpen={() => setCommandPaletteOpen(true)}
        onClose={() => setCommandPaletteOpen(false)}
        onThemeMode={onThemeMode}
        items={[
          {
            id: "new-opencode-session",
            label: "新建 OpenCode 对话",
            description: "在当前 Project 创建一个新的 OpenCode 原生 Session",
            keywords: ["new", "session", "opencode"],
            disabled:
              working || submitting || Boolean(transition) || reconciling,
            onSelect: () => void createAndOpenSession(),
          },
          {
            id: "search-sessions",
            label: "搜索对话",
            description: "按标题、Project、路径或 Runtime 查找",
            keywords: ["find", "project", "runtime"],
            shortcut: "⌘K",
            onSelect: () =>
              document
                .querySelector<HTMLInputElement>(".session-search input")
                ?.focus(),
          },
          {
            id: "session-details",
            label: "打开 Session 详情",
            description: "查看当前 Host 绑定、Working Copy 与连接身份",
            keywords: ["context", "working copy", "identity"],
            disabled: !(activeHostSession ?? restoredSession),
            onSelect: () => setSessionContextOpen(true),
          },
          {
            id: "lifemodel",
            label: "打开 LifeModel",
            description: "查看用户批准的长期上下文与来源",
            keywords: ["memory", "proposal"],
            onSelect: lifeModel.onOpen,
          },
          {
            id: "working-copy-manager",
            label: "管理 Working Copies",
            description: "检查并安全移除 Farfold 管理的未绑定 Worktree",
            keywords: ["worktree", "git", "storage", "working copy"],
            onSelect: () => setWorkingCopyManagerOpen(true),
          },
          {
            id: "opencode-provider",
            label: "查看 OpenCode Provider 边界",
            description: "说明 Farfold 可验证的 Provider 与账户状态",
            keywords: ["model", "connection", "provider"],
            onSelect: () =>
              setError(
                "OpenCode Provider 与凭据由 OpenCode 原生配置管理；Farfold 只读取官方 /provider readiness，不读取凭据。",
              ),
          },
          {
            id: "switch-pi",
            label: "切换到 Pi",
            description: "切换 Runtime 工作区，不移植当前 Session",
            keywords: ["runtime", "workspace"],
            disabled: submitting || Boolean(transition) || reconciling,
            onSelect: () => void selectRuntime("pi"),
          },
        ]}
      />
      {workingCopyManagerOpen && (
        <WorkingCopyManagerDialog
          onClose={() => setWorkingCopyManagerOpen(false)}
        />
      )}
      {sessionDeletionTarget && (
        <SessionDeletionDialog
          sessionId={sessionDeletionTarget.key}
          sessionTitle={sessionDeletionTarget.title}
          onClose={() => setSessionDeletionTarget(null)}
        />
      )}
      {lifeModel.open && (
        <LifeModelPanel
          snapshot={lifeModel.snapshot}
          candidates={lifeModel.candidates}
          selectedItemIds={lifeModel.selectedItemIds}
          unavailable={lifeModel.unavailable}
          busy={lifeModel.busy || working || reconciling}
          onClose={lifeModel.onClose}
          onReload={lifeModel.onReload}
          onCreate={lifeModel.onCreate}
          onUpdate={lifeModel.onUpdate}
          onApprove={lifeModel.onApprove}
          onReject={lifeModel.onReject}
          onDelete={lifeModel.onDelete}
          onWithdrawSource={lifeModel.onWithdrawSource}
          onEnabled={lifeModel.onEnabled}
          onSelectItem={lifeModel.onSelectItem}
        />
      )}
    </div>
  );
}
