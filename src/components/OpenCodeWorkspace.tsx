import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Brain, FolderOpen, FolderSimple, X } from "@phosphor-icons/react";
import appIconUrl from "../../assets/app-icon.svg";
import { appendBounded } from "../runtime/event-buffer";
import { useHostSessionDraft } from "../runtime/host-draft";
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
  hostRuntimeReconciliationRequest,
  openHostSession,
  reconcileOpenCodeHostSession,
  refreshHostNavigation,
  runtimeEnvelopeFromHostEvent,
  subscribeHostShadowState,
  subscribeHostRuntimeEvents,
  type HostSessionBinding,
  type HostShadowState,
} from "../runtime/host-shadow";
import {
  OPENCODE_RUNTIME_IDENTITY,
  abortOpenCodeSession,
  createOpenCodeSession,
  discoverOpenCodeRuntime,
  listOpenCodeBindings,
  listOpenCodeSessions,
  openCodeProviderSnapshot,
  openCodeRuntimeStatus,
  openCodeSessionMessages,
  promptOpenCode,
  rememberOpenCodeBinding,
  respondToOpenCodePermission,
  startOpenCodeRuntime,
  stopOpenCodeRuntime,
  type OpenCodeEnvelope,
  type OpenCodeProviderModel,
  type OpenCodeProviderSnapshot,
  type OpenCodeRuntimeStatus,
  type OpenCodeSessionBindingRecord,
} from "../runtime/opencode";
import {
  finishLifeModelInjection,
  parseOpenCodeLifeModelSources,
  prepareLifeModelInjection,
  type CreateProposalInput,
  type LifeModelSnapshot,
  type LifeModelSourceCandidate,
  type UpdateProposalInput,
} from "../runtime/lifemodel";
import { Composer } from "./Composer";
import { LifeModelPanel } from "./LifeModelPanel";
import { MessageContent } from "./MessageContent";
import { OpenCodePermissionCard } from "./OpenCodePermissionCard";
import { PiActivity } from "./PiActivity";
import { RuntimeChooser, type RuntimeProduct } from "./RuntimeChooser";
import { Sidebar, type SidebarSessionItem } from "./Sidebar";

interface OpenCodeWorkspaceProps {
  initialProjectPath: string | null;
  onProjectPath: (path: string) => void;
  onSelectRuntime: (runtime: RuntimeProduct) => void;
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

export function OpenCodeWorkspace({
  initialProjectPath,
  onProjectPath,
  onSelectRuntime,
  lifeModel,
}: OpenCodeWorkspaceProps) {
  const [status, setStatus] = useState(initialStatus);
  const [transition, setTransition] = useState<
    "discovering" | "starting" | "stopping" | null
  >("discovering");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [projectPath, setProjectPath] = useState(initialProjectPath);
  const [hostSessions, setHostSessions] = useState<HostSessionBinding[]>([]);
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
  const [projectFilter, setProjectFilter] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [lifeModelWarning, setLifeModelWarning] = useState<string | null>(null);
  const generation = useRef(0);
  const activeBindingRef = useRef<OpenCodeSessionBindingRecord | null>(null);
  const rawFallbackEvents = useRef<OpenCodeEnvelope[]>([]);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const statusPolling = useRef(false);
  const lifeModelSeenEntries = useRef<Map<string, Set<string>>>(new Map());
  const latestHostShadow = useRef<HostShadowState | null>(null);
  const lastHostReconciliation = useRef<string | null>(null);
  const hostReconciliation = useRef<Promise<void>>(Promise.resolve());

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
  const sidebarSessions = useMemo<SidebarSessionItem[]>(
    () =>
      hostSessions.map((session) => ({
        key: session.farfoldSessionId,
        nativeSessionId: session.nativeSessionId,
        projectPath: session.workingCopyPath,
        title: session.title,
        updatedAt: session.updatedAt,
        runtimeLabel: "OpenCode",
      })),
    [hostSessions],
  );
  const activeSessionKey =
    hostSessions.find(
      (session) => session.nativeSessionId === activeBinding?.nativeSessionId,
    )?.farfoldSessionId ?? null;
  const restoredSession =
    hostSessions.find(
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

  async function reloadBindings(): Promise<OpenCodeSessionBindingRecord[]> {
    const next = await listOpenCodeBindings();
    await refreshHostNavigation().catch(() => undefined);
    return next;
  }

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

  async function refreshNativeSessionBinding(
    binding: OpenCodeSessionBindingRecord,
  ) {
    const sessions = await listOpenCodeSessions();
    const native = sessions.find(
      (session) => session.id === binding.nativeSessionId,
    );
    if (!native) return;
    const remembered = await rememberOpenCodeBinding(native);
    if (
      activeBindingRef.current?.nativeSessionId === remembered.nativeSessionId
    )
      setActiveBinding(remembered);
    await reloadBindings();
  }

  function queueOpenCodeHostReconciliation(state: HostShadowState): void {
    latestHostShadow.current = state;
    setHostRestoreSessionId(
      state.navigation.restoreState?.lastSessionId ?? null,
    );
    setHostSessions(
      state.navigation.sessionIndex.sessions.filter(
        (session) =>
          session.runtimeProductId === "opencode" &&
          session.archivedAt === null,
      ),
    );
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
        await refreshNativeSessionBinding(binding);
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
        void refreshNativeSessionBinding(binding).catch(() => undefined);
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

    const statusInterval = window.setInterval(() => {
      if (statusPolling.current) return;
      statusPolling.current = true;
      void openCodeRuntimeStatus()
        .then((next) => {
          if (cancelled) return;
          generation.current = Math.max(generation.current, next.generation);
          setStatus((current) => {
            if (current.running && !next.running) {
              setConversation((conversation) => ({
                ...conversation,
                isWorking: false,
              }));
              setError(
                "OpenCode Server 已退出；原生 Session 绑定仍保留，可重新打开恢复。",
              );
            }
            return next;
          });
        })
        .catch((reason) => {
          if (!cancelled) setError(String(reason));
        })
        .finally(() => {
          statusPolling.current = false;
        });
    }, 1_000);
    return () => {
      cancelled = true;
      stopRuntimeEvents();
      stopHostState();
      window.clearInterval(statusInterval);
    };
  }, []);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversation.timeline, conversation.permissions]);

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

  async function startForProject(path: string) {
    let currentStatus = status;
    if (
      currentStatus.running &&
      currentStatus.projectPath &&
      currentStatus.projectPath !== path
    ) {
      setTransition("stopping");
      currentStatus = await stopOpenCodeRuntime();
      setStatus(currentStatus);
    }
    if (!currentStatus.running) {
      setTransition("starting");
      currentStatus = await startOpenCodeRuntime({ projectPath: path });
      generation.current = currentStatus.generation;
      setStatus(currentStatus);
    }
    const snapshot = await openCodeProviderSnapshot();
    setProviders(snapshot);
    const firstModel = snapshot.models[0];
    if (firstModel)
      setSelectedModelKey((current) => current ?? modelKey(firstModel));
    setTransition(null);
  }

  async function createAndOpenSession() {
    if (!projectPath || transition || working || reconciling) return;
    setError(null);
    try {
      await startForProject(projectPath);
      const native = await createOpenCodeSession("新对话");
      const binding = await rememberOpenCodeBinding(native);
      activeBindingRef.current = binding;
      setActiveBinding(binding);
      setConversation(initialOpenCodeConversation);
      if (latestHostShadow.current) {
        queueOpenCodeHostReconciliation(latestHostShadow.current);
      }
      await reloadBindings();
      await loadHistory(binding);
    } catch (reason) {
      setError(String(reason));
      setTransition(null);
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
      const binding: OpenCodeSessionBindingRecord = {
        runtime: OPENCODE_RUNTIME_IDENTITY,
        connectionId: openedSession.connectionId,
        nativeSessionId: openedSession.nativeSessionId,
        projectPath: openedSession.workingCopyPath,
        title: openedSession.title,
        createdAt: openedSession.createdAt,
        updatedAt: openedSession.updatedAt,
      };
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

  async function send() {
    const text = message.trim();
    if (!text || !ready || !activeBinding || !selectedModel || submitting)
      return;
    setSubmitting(true);
    setError(null);
    setLifeModelWarning(null);
    setMessage("");
    setConversation((current) => ({
      ...current,
      isWorking: true,
      notice: null,
      timeline: [
        ...current.timeline,
        {
          kind: "message",
          id: `local-${Date.now()}`,
          role: "user",
          text,
        },
      ],
    }));
    const wantedInjection =
      lifeModel.snapshot?.enabled === true &&
      lifeModel.selectedItemIds.length > 0;
    let preparedInjection: Awaited<
      ReturnType<typeof prepareLifeModelInjection>
    > | null = null;
    let stagedManifestId: string | null = null;
    try {
      if (wantedInjection) {
        try {
          preparedInjection = await prepareLifeModelInjection(
            "opencode",
            activeBinding.nativeSessionId,
            lifeModel.selectedItemIds,
          );
          stagedManifestId = preparedInjection.manifestId;
        } catch (reason) {
          setLifeModelWarning(
            `LifeModel 上下文未注入，本条消息仍按普通 OpenCode 对话发送：${String(reason)}`,
          );
        }
      }
      await promptOpenCode({
        sessionId: activeBinding.nativeSessionId,
        providerId: selectedModel.providerId,
        modelId: selectedModel.modelId,
        text,
        ...(preparedInjection ? { system: preparedInjection.contextText } : {}),
      });
      if (preparedInjection) {
        try {
          lifeModel.onSnapshot(
            await finishLifeModelInjection(
              stagedManifestId ?? preparedInjection.manifestId,
              true,
            ),
          );
        } catch (reason) {
          setLifeModelWarning(
            `OpenCode 已收到消息，但 Injection Manifest 完成状态写入失败：${String(reason)}`,
          );
        }
      }
      if (wantedInjection) lifeModel.onClearSelection();
    } catch (reason) {
      if (stagedManifestId) {
        void finishLifeModelInjection(stagedManifestId, false)
          .then(lifeModel.onSnapshot)
          .catch(() => undefined);
      }
      setConversation((current) => ({ ...current, isWorking: false }));
      setError(String(reason));
    } finally {
      setSubmitting(false);
    }
  }

  async function abort() {
    if (!activeBinding || !working) return;
    try {
      await abortOpenCodeSession(activeBinding.nativeSessionId);
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
    if (runtime === "opencode" || working || transition || reconciling) return;
    setError(null);
    try {
      if (status.running) {
        setTransition("stopping");
        setStatus(await stopOpenCodeRuntime());
      }
      onSelectRuntime(runtime);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setTransition(null);
    }
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

  return (
    <div className="app-shell">
      <Sidebar
        sessions={sidebarSessions}
        activeSessionKey={
          activeSessionKey ?? restoredSession?.farfoldSessionId ?? null
        }
        search={search}
        projectFilter={projectFilter}
        disabled={working || submitting || Boolean(transition) || reconciling}
        connectedProviderCount={providers?.connectedProviderIds.length ?? 0}
        settingsTitle="OpenCode Provider"
        settingsSubtitle={
          providers
            ? `${providers.connectedProviderIds.length} 个原生连接 · 账户状态未知`
            : "由 OpenCode 原生配置管理"
        }
        onSearch={setSearch}
        onProjectFilter={setProjectFilter}
        onNew={() => void createAndOpenSession()}
        onSelect={(item) => {
          const session = hostSessions.find(
            (candidate) => candidate.farfoldSessionId === item.key,
          );
          if (session) void openHostOpenCodeSession(session);
        }}
        onOpenConnections={() =>
          setError(
            "OpenCode Provider 与凭据由 OpenCode 原生配置管理；Farfold 只读取官方 /provider readiness，不读取凭据。",
          )
        }
      />

      <main className="workspace">
        <header className="workspace-header">
          <div className="session-title">
            <h1>{activeBinding?.title ?? "OpenCode"}</h1>
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
              disabled={
                working || submitting || Boolean(transition) || reconciling
              }
              onChange={(runtime) => void selectRuntime(runtime)}
            />
            <span className="header-separator" />
            <button
              className="header-project"
              onClick={lifeModel.onOpen}
              title="打开 LifeModel"
            >
              <Brain size={14} />
              LifeModel
              {lifeModel.snapshot?.items.length
                ? ` · ${lifeModel.snapshot.items.length}`
                : ""}
            </button>
            <span className="header-separator" />
            <button
              className="header-project"
              title={currentProject ?? undefined}
              onClick={() => void chooseProject()}
              disabled={working || Boolean(transition) || reconciling}
            >
              <FolderSimple size={14} />
              {projectName(currentProject)}
            </button>
            <span className="header-separator" />
            <div className={`runtime-state${working ? " working" : ""}`}>
              <i />
              {runtimeState}
            </div>
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
              <button
                onClick={() => setLifeModelWarning(null)}
                aria-label="关闭 LifeModel 通知"
              >
                <X size={15} />
              </button>
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
