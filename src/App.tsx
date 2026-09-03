import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Brain,
  FolderOpen,
  FolderSimple,
  PencilSimple,
  X,
} from "@phosphor-icons/react";
import appIconUrl from "../assets/app-icon.svg";
import { Composer } from "./components/Composer";
import { parsePiCommands, type PiCommandInfo } from "./runtime/commands";
import { appendBounded } from "./runtime/event-buffer";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { HostShadowQaBadge } from "./components/HostShadowQaBadge";
import { MessageContent } from "./components/MessageContent";
import { LifeModelPanel } from "./components/LifeModelPanel";
import { ModelPicker, modelKey } from "./components/ModelPicker";
import { OpenCodeWorkspace } from "./components/OpenCodeWorkspace";
import { PiActivity, QueueNotice } from "./components/PiActivity";
import { ProjectReadinessCard } from "./components/ProjectReadinessCard";
import {
  ProviderSettings,
  type ProviderAuthFlow,
  type ProviderValidation,
} from "./components/ProviderSettings";
import { Sidebar, type SidebarSessionItem } from "./components/Sidebar";
import {
  RuntimeChooser,
  type RuntimeProduct,
} from "./components/RuntimeChooser";
import {
  formatProviderError,
  hydrateTimeline,
  initialConversation,
  projectUnknownPiEvent,
  reducePiEvent,
  type ConversationState,
} from "./runtime/conversation";
import {
  cancelProviderLogin,
  getCapabilitySnapshot,
  loginProvider,
  logoutProvider,
  pollCapabilityEvents,
  refreshCapabilitySnapshot,
  rejectCapabilityRequests,
  respondToAuthPrompt,
  resolveActiveProvider,
  setDefaultModel,
  settleCapabilityEvent,
  startCapabilities,
  testProviderConnection,
  upsertCustomProvider,
  type AuthType,
  type CapabilityEvent,
  type CustomProviderInput,
  type PiCapabilitySnapshot,
  type PiModel,
  type ThinkingLevel,
} from "./runtime/capabilities";
import {
  approveLifeModelProposal,
  createLifeModelProposal,
  deleteLifeModelItem,
  finishLifeModelInjection,
  getLifeModelSnapshot,
  parseLifeModelSources,
  prepareLifeModelInjection,
  rejectLifeModelProposal,
  setLifeModelEnabled,
  updateLifeModelProposal,
  withdrawLifeModelSource,
  type CreateProposalInput,
  type LifeModelSnapshot,
  type LifeModelSourceCandidate,
  type UpdateProposalInput,
} from "./runtime/lifemodel";
import {
  acceptsRuntimeEvent,
  isRuntimeCommandReady,
  lifecycleFailureMessage,
  parseExtensionUiRequest,
  PI_RUNTIME_IDENTITY,
  piRuntimeAdapter,
  resumableSessionFile,
  type PiEnvelope,
  type ExtensionDialogRequest,
  type ProjectTrust,
  type ProjectReadiness,
  type RuntimeStatus,
  type SessionSummary,
} from "./runtime/pi";
import {
  acknowledgeHostRuntimeReconciliation,
  hostShadowQaEnabled,
  hostRuntimeReconciliationRequest,
  openHostSession,
  reconcilePiHostSession,
  refreshHostNavigation,
  runtimeEnvelopeFromHostEvent,
  startHostShadow,
  subscribeHostRuntimeEvents,
  type HostResumeCursor,
  type HostShadowHandle,
  type HostShadowState,
} from "./runtime/host-shadow";
import {
  cleanManualSessionTitle,
  cleanSessionTitle,
} from "./runtime/session-title";

const {
  projectReadiness: getProjectReadiness,
  listSessions,
  rejectPending: rejectPendingRpc,
  rememberSession,
  status: runtimeStatus,
  send: sendRpc,
  settleResponse: settleRpcResponse,
  start: startRuntime,
  stop: stopRuntime,
} = piRuntimeAdapter;

interface PiState {
  model: PiModel | null;
  isStreaming: boolean;
  sessionFile: string | null;
  sessionId: string | null;
  sessionName: string | null;
  pendingMessageCount: number;
  contextPercent: number | null;
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
}

const initialStatus: RuntimeStatus = {
  state: "stopped",
  running: false,
  projectPath: null,
  sessionDir: null,
  generation: 0,
  savedProjectPath: null,
  savedSessionFile: null,
};

const initialPiState: PiState = {
  model: null,
  isStreaming: false,
  sessionFile: null,
  sessionId: null,
  sessionName: null,
  pendingMessageCount: 0,
  contextPercent: null,
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isResponse(value: unknown): value is Record<string, unknown> {
  return asRecord(value)?.type === "response";
}

function parseModel(value: unknown, available = true): PiModel | null {
  const model = asRecord(value);
  const cost = asRecord(model?.cost);
  if (
    !model ||
    typeof model.provider !== "string" ||
    typeof model.id !== "string" ||
    typeof model.name !== "string" ||
    typeof model.api !== "string" ||
    typeof model.contextWindow !== "number" ||
    typeof model.maxTokens !== "number"
  ) {
    return null;
  }
  const input = Array.isArray(model.input)
    ? model.input.filter(
        (item): item is "text" | "image" => item === "text" || item === "image",
      )
    : ["text" as const];
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning === true,
    input,
    cost: {
      input: typeof cost?.input === "number" ? cost.input : 0,
      output: typeof cost?.output === "number" ? cost.output : 0,
      cacheRead: typeof cost?.cacheRead === "number" ? cost.cacheRead : 0,
      cacheWrite: typeof cost?.cacheWrite === "number" ? cost.cacheWrite : 0,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(asRecord(model.thinkingLevelMap)
      ? {
          thinkingLevelMap: model.thinkingLevelMap as Partial<
            Record<ThinkingLevel, string | number | null>
          >,
        }
      : {}),
    thinkingLevels: (Array.isArray(model.thinkingLevels)
      ? model.thinkingLevels
      : model.reasoning === true
        ? ["off", "minimal", "low", "medium", "high"]
        : ["off"]
    ).filter(
      (level): level is ThinkingLevel =>
        level === "off" ||
        level === "minimal" ||
        level === "low" ||
        level === "medium" ||
        level === "high" ||
        level === "xhigh" ||
        level === "max",
    ),
    available,
  };
}

function projectName(path: string | null): string {
  if (!path) return "未选择 Project";
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function elapsedLabel(startedAt: number | null, now: number): string {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

const hostShadowQaProject = hostShadowQaEnabled
  ? import.meta.env.VITE_FARFOLD_QA_PROJECT_PATH?.trim() || null
  : null;
const hostShadowQaReconciliationCount = 4;

export default function App() {
  const [selectedRuntime, setSelectedRuntime] = useState<RuntimeProduct>("pi");
  const [status, setStatus] = useState(initialStatus);
  const [runtimeTransition, setRuntimeTransition] = useState<
    "starting" | "stopping" | null
  >(null);
  const [runtimeReadyGeneration, setRuntimeReadyGeneration] = useState<
    number | null
  >(null);
  const [runtimeReconciling, setRuntimeReconciling] = useState(false);
  const [projectPath, setProjectPath] = useState<string | null>(
    hostShadowQaProject,
  );
  const [hostShadowState, setHostShadowState] =
    useState<HostShadowState | null>(null);
  const [hostShadowUnavailable, setHostShadowUnavailable] = useState(false);
  const [projectTrust, setProjectTrust] = useState<ProjectTrust>("saved");
  const [projectReadiness, setProjectReadiness] =
    useState<ProjectReadiness | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [conversation, setConversation] =
    useState<ConversationState>(initialConversation);
  const [piState, setPiState] = useState(initialPiState);
  const [models, setModels] = useState<PiModel[]>([]);
  const [modelDiscovery, setModelDiscovery] = useState<
    "idle" | "loading" | "ready"
  >("idle");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [capabilities, setCapabilities] = useState<PiCapabilitySnapshot | null>(
    null,
  );
  const [capabilityState, setCapabilityState] = useState<
    "idle" | "loading" | "ready" | "refreshing" | "failed"
  >("idle");
  const [commands, setCommands] = useState<PiCommandInfo[]>([]);
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [lifeModelOpen, setLifeModelOpen] = useState(false);
  const [lifeModelSnapshot, setLifeModelSnapshot] =
    useState<LifeModelSnapshot | null>(null);
  const [lifeModelUnavailable, setLifeModelUnavailable] = useState<
    string | null
  >(null);
  const [lifeModelBusy, setLifeModelBusy] = useState(false);
  const [lifeModelSources, setLifeModelSources] = useState<
    LifeModelSourceCandidate[]
  >([]);
  const [selectedLifeModelItemIds, setSelectedLifeModelItemIds] = useState<
    string[]
  >([]);
  const [providerSettingsTarget, setProviderSettingsTarget] = useState<
    string | null
  >(null);
  const [providerSettingsBusy, setProviderSettingsBusy] = useState(false);
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [providerValidations, setProviderValidations] = useState<
    Record<string, ProviderValidation>
  >({});
  const [authFlow, setAuthFlow] = useState<ProviderAuthFlow | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [delivery, setDelivery] = useState<"steer" | "follow_up">("steer");
  const [error, setError] = useState<string | null>(null);
  const [extensionDialogs, setExtensionDialogs] = useState<
    ExtensionDialogRequest[]
  >([]);
  const [extensionNotice, setExtensionNotice] = useState<{
    message: string;
    type: "info" | "warning" | "error";
  } | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<
    Record<string, string>
  >({});
  const [extensionWidgets, setExtensionWidgets] = useState<
    Record<
      string,
      { lines: string[]; placement: "aboveEditor" | "belowEditor" }
    >
  >({});
  const [workStartedAt, setWorkStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const runtimeGeneration = useRef(0);
  const lifecycleActionInFlight = useRef(false);
  const currentProvider = useRef<string | null>(null);
  const currentModelName = useRef<string | null>(null);
  const currentNativeSessionId = useRef<string | null>(null);
  const lifeModelSourceCursor = useRef<string | null>(null);
  const lifeModelSourcePrimedFor = useRef<string | null>(null);
  const lifeModelExtensionReady = useRef(false);
  const unknownRuntimeEvents = useRef<PiEnvelope[]>([]);
  const lastPiHostReconciliation = useRef<string | null>(null);
  const piHostReconciliation = useRef<Promise<void>>(Promise.resolve());
  const hostShadowHandle = useRef<HostShadowHandle | null>(null);
  const [hostGapQaBusy, setHostGapQaBusy] = useState(false);

  const working = piState.isStreaming || conversation.isWorking;
  const runtimePhase = runtimeTransition ?? status.state;
  const transitioning =
    runtimePhase === "starting" || runtimePhase === "stopping";
  const runtimeCommandReady =
    !runtimeReconciling &&
    isRuntimeCommandReady(status, runtimeReadyGeneration);
  const extensionStatus = Object.values(extensionStatuses).join(" · ");
  const extensionWidgetAbove = Object.values(extensionWidgets)
    .filter((widget) => widget.placement === "aboveEditor")
    .flatMap((widget) => widget.lines);
  const extensionWidgetBelow = Object.values(extensionWidgets)
    .filter((widget) => widget.placement === "belowEditor")
    .flatMap((widget) => widget.lines);
  const activeSession = useMemo(
    () =>
      sessions.find((session) => session.sessionFile === piState.sessionFile),
    [piState.sessionFile, sessions],
  );
  const piHostSessions = useMemo(
    () =>
      (hostShadowState?.navigation.sessionIndex.sessions ?? []).filter(
        (session) =>
          session.runtimeProductId === "pi" && session.archivedAt === null,
      ),
    [hostShadowState?.navigation.sessionIndex.sessions],
  );
  const piSidebarSessions = useMemo<SidebarSessionItem[]>(
    () =>
      piHostSessions.map((session) => ({
        key: session.farfoldSessionId,
        nativeSessionId: session.nativeSessionId,
        projectPath: session.workingCopyPath,
        title: session.title,
        updatedAt: session.updatedAt,
        runtimeLabel: "Pi",
      })),
    [piHostSessions],
  );
  const activePiHostSessionKey =
    piHostSessions.find(
      (session) => session.nativeSessionId === piState.sessionId,
    )?.farfoldSessionId ?? null;
  const resumableCurrentSession = resumableSessionFile(
    piState.sessionFile,
    sessions,
  );
  const displayTimeline = useMemo(() => {
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
      if (previous?.kind === "tools") {
        previous.tools.push(item);
      } else {
        groups.push({ kind: "tools", id: item.id, tools: [item] });
      }
      return groups;
    }, []);
  }, [conversation.timeline]);
  const firstUserMessage = conversation.timeline.find(
    (item) => item.kind === "message" && item.role === "user" && item.text,
  );
  const automaticConversationTitle = cleanSessionTitle(
    activeSession?.title ||
      (firstUserMessage?.kind === "message" ? firstUserMessage.text : "") ||
      "新对话",
  );
  const conversationTitle = piState.sessionName
    ? cleanManualSessionTitle(piState.sessionName, 34)
    : automaticConversationTitle;
  const currentProject = status.projectPath ?? projectPath;
  const providers = capabilities?.providers ?? [];
  const connectedProviderCount = providers.filter(
    (provider) => provider.configured,
  ).length;
  const mergedModels = useMemo(() => {
    const merged = new Map(
      (capabilities?.models ?? []).map((model) => [modelKey(model), model]),
    );
    for (const model of models)
      merged.set(modelKey(model), { ...model, available: true });
    if (piState.model) {
      const key = modelKey(piState.model);
      merged.set(key, {
        ...(merged.get(key) ?? piState.model),
        available: true,
      });
    }
    return [...merged.values()];
  }, [capabilities?.models, models, piState.model]);
  const defaultModel =
    capabilities?.settings.defaultProvider && capabilities.settings.defaultModel
      ? (mergedModels.find(
          (model) =>
            model.provider === capabilities.settings.defaultProvider &&
            model.id === capabilities.settings.defaultModel,
        ) ?? null)
      : null;
  const currentModel = piState.model
    ? (mergedModels.find(
        (model) => modelKey(model) === modelKey(piState.model!),
      ) ?? piState.model)
    : defaultModel;
  const activeProvider = resolveActiveProvider(
    providers,
    currentModel?.provider ?? null,
  );
  const currentThinkingLevel = status.running
    ? piState.thinkingLevel
    : (capabilities?.settings.defaultThinkingLevel ?? piState.thinkingLevel);
  const currentThinkingLevels = status.running
    ? piState.availableThinkingLevels
    : (currentModel?.thinkingLevels ?? ["off"]);
  const providerStateLabel = activeProvider?.configured
    ? providerValidations[activeProvider.id]?.state === "verified-success"
      ? "连接可用"
      : providerValidations[activeProvider.id]?.state === "verified-failure"
        ? "验证失败"
        : "已配置 · 待验证"
    : "未配置";
  const canResume = Boolean(
    status.savedSessionFile && status.savedProjectPath === projectPath,
  );
  const projectCommands = commands.filter(
    (command) => command.location === "project",
  );
  const startupMode =
    projectTrust === "approve"
      ? "本次：载入项目资源"
      : projectTrust === "ignore"
        ? "本次：不载入受保护项目资源"
        : "本次：遵循 Pi 已保存选择";
  const selectedLifeModelItems = useMemo(
    () =>
      selectedLifeModelItemIds.flatMap((itemId) => {
        const item = lifeModelSnapshot?.items.find(
          (candidate) => candidate.id === itemId,
        );
        return item ? [item] : [];
      }),
    [lifeModelSnapshot?.items, selectedLifeModelItemIds],
  );

  function applyRuntimeStatus(next: RuntimeStatus): boolean {
    if (next.generation < runtimeGeneration.current) return false;
    if (next.generation > runtimeGeneration.current) {
      rejectPendingRpc("Pi 运行状态已切换，请重试未完成的请求。");
      currentNativeSessionId.current = null;
      lifeModelSourceCursor.current = null;
      lifeModelSourcePrimedFor.current = null;
      lifeModelExtensionReady.current = false;
      setRuntimeReadyGeneration(null);
    }
    runtimeGeneration.current = next.generation;
    setStatus(next);
    return true;
  }

  function reloadSessions() {
    void listSessions().then(
      (next) => {
        setSessions(next);
        void refreshHostNavigation().catch(() => undefined);
      },
      (reason) => setError(String(reason)),
    );
  }

  async function loadLifeModel(): Promise<LifeModelSnapshot | null> {
    try {
      const snapshot = await getLifeModelSnapshot();
      setLifeModelSnapshot(snapshot);
      setLifeModelUnavailable(null);
      setSelectedLifeModelItemIds((current) =>
        current.filter((itemId) =>
          snapshot.items.some((item) => item.id === itemId),
        ),
      );
      return snapshot;
    } catch (reason) {
      setLifeModelSnapshot(null);
      setLifeModelUnavailable(String(reason));
      setSelectedLifeModelItemIds([]);
      return null;
    }
  }

  async function runLifeModelMutation(
    mutation: () => Promise<unknown>,
  ): Promise<void> {
    if (lifeModelBusy) return;
    setLifeModelBusy(true);
    try {
      await mutation();
      await loadLifeModel();
    } catch (reason) {
      setError(`LifeModel：${String(reason)}`);
    } finally {
      setLifeModelBusy(false);
    }
  }

  function collectLifeModelSources(): void {
    const nativeSessionId = currentNativeSessionId.current;
    if (!nativeSessionId) return;
    const since = lifeModelSourceCursor.current;
    void sendRpc({
      type: "get_entries",
      ...(since ? { since } : {}),
    })
      .then((response) => {
        if (!response) return;
        const parsed = parseLifeModelSources(response, nativeSessionId);
        if (parsed.leafId) lifeModelSourceCursor.current = parsed.leafId;
        if (!parsed.candidates.length) return;
        mergeLifeModelSources(parsed.candidates);
      })
      .catch(() => {
        setExtensionNotice({
          type: "warning",
          message: "本轮 LifeModel 来源读取失败；普通 Pi 对话不受影响。",
        });
      });
  }

  function mergeLifeModelSources(candidates: LifeModelSourceCandidate[]): void {
    if (!candidates.length) return;
    setLifeModelSources((current) => {
      const merged = new Map(
        [...current, ...candidates].map((candidate) => [
          candidate.candidateId,
          candidate,
        ]),
      );
      return [...merged.values()].slice(-30);
    });
  }

  function primeLifeModelSourceCursor(nativeSessionId: string): void {
    const primeKey = `${runtimeGeneration.current}:${nativeSessionId}`;
    if (lifeModelSourcePrimedFor.current === primeKey) return;
    lifeModelSourcePrimedFor.current = primeKey;
    void sendRpc({ type: "get_entries" })
      .then((response) => {
        if (!response || lifeModelSourcePrimedFor.current !== primeKey) return;
        const parsed = parseLifeModelSources(response, nativeSessionId);
        lifeModelSourceCursor.current = parsed.leafId;
      })
      .catch(() => {
        if (lifeModelSourcePrimedFor.current === primeKey) {
          lifeModelSourcePrimedFor.current = null;
        }
        setExtensionNotice({
          type: "warning",
          message: "LifeModel 来源游标未建立；普通 Pi 对话不受影响。",
        });
      });
  }

  function selectLifeModelItem(itemId: string, selected: boolean): void {
    setSelectedLifeModelItemIds((current) => {
      if (!selected) return current.filter((candidate) => candidate !== itemId);
      if (current.includes(itemId) || current.length >= 3) return current;
      return [...current, itemId];
    });
  }

  async function loadCapabilities(refresh = false) {
    setCapabilityState(refresh ? "refreshing" : "loading");
    try {
      const snapshot = refresh
        ? await refreshCapabilitySnapshot(currentProject)
        : await getCapabilitySnapshot(currentProject);
      setCapabilities(snapshot);
      setCapabilityState("ready");
    } catch (reason) {
      setCapabilityState("failed");
      setError(String(reason));
      throw reason;
    }
  }

  function hydratePiFromRuntime(): Promise<void> {
    return Promise.all([
      sendRpc({ type: "get_state" }),
      sendRpc({ type: "get_available_models" }),
      sendRpc({ type: "get_available_thinking_levels" }),
      sendRpc({ type: "get_messages" }),
      sendRpc({ type: "get_commands" }),
      sendRpc({ type: "get_session_stats" }),
    ]).then(() => undefined);
  }

  function refreshPi(running: boolean) {
    if (!running) return;
    void hydratePiFromRuntime().catch((reason) => setError(String(reason)));
  }

  function handleResponse(response: Record<string, unknown>) {
    if (response.success !== true) {
      setError(
        typeof response.error === "string" ? response.error : "Pi 拒绝了请求。",
      );
      return;
    }
    const data = asRecord(response.data);
    if (response.command === "get_state") {
      const model = asRecord(data?.model);
      const thinkingLevel = data?.thinkingLevel;
      const next: PiState = {
        model: parseModel(model),
        isStreaming: data?.isStreaming === true,
        sessionFile:
          typeof data?.sessionFile === "string" ? data.sessionFile : null,
        sessionId: typeof data?.sessionId === "string" ? data.sessionId : null,
        sessionName:
          typeof data?.sessionName === "string" ? data.sessionName : null,
        pendingMessageCount:
          typeof data?.pendingMessageCount === "number"
            ? data.pendingMessageCount
            : 0,
        contextPercent: null,
        thinkingLevel:
          thinkingLevel === "off" ||
          thinkingLevel === "minimal" ||
          thinkingLevel === "low" ||
          thinkingLevel === "medium" ||
          thinkingLevel === "high" ||
          thinkingLevel === "xhigh" ||
          thinkingLevel === "max"
            ? thinkingLevel
            : "off",
        availableThinkingLevels: piState.availableThinkingLevels,
      };
      currentNativeSessionId.current = next.sessionId;
      if (next.sessionId) primeLifeModelSourceCursor(next.sessionId);
      setRuntimeReadyGeneration(runtimeGeneration.current);
      setPiState((current) => ({
        ...next,
        contextPercent: current.contextPercent,
        availableThinkingLevels: current.availableThinkingLevels,
      }));
      if (next.isStreaming) {
        setWorkStartedAt((current) => current ?? Date.now());
      }
      if (next.sessionFile) {
        void rememberSession(next.sessionFile).then(
          (saved) => {
            if (saved) {
              void runtimeStatus().then(setStatus);
              reloadSessions();
            }
          },
          (reason) => setError(String(reason)),
        );
      }
    } else if (response.command === "get_session_stats") {
      const context = asRecord(data?.contextUsage);
      setPiState((current) => ({
        ...current,
        contextPercent:
          typeof context?.percent === "number" ? context.percent : null,
      }));
    } else if (response.command === "get_available_models") {
      setModels(
        (Array.isArray(data?.models) ? data.models : []).flatMap(
          (candidate) => {
            const model = parseModel(candidate);
            return model ? [model] : [];
          },
        ),
      );
      setModelDiscovery("ready");
    } else if (response.command === "get_available_thinking_levels") {
      const levels = (Array.isArray(data?.levels) ? data.levels : []).filter(
        (level): level is ThinkingLevel =>
          level === "off" ||
          level === "minimal" ||
          level === "low" ||
          level === "medium" ||
          level === "high" ||
          level === "xhigh" ||
          level === "max",
      );
      setPiState((current) => ({
        ...current,
        availableThinkingLevels: levels.length ? levels : ["off"],
      }));
    } else if (response.command === "get_messages") {
      setConversation((current) => ({
        ...current,
        timeline: hydrateTimeline(data?.messages),
      }));
    } else if (response.command === "get_commands") {
      const discoveredCommands = parsePiCommands(data?.commands);
      const commandNames = new Set(
        discoveredCommands.map((command) => command.name),
      );
      lifeModelExtensionReady.current =
        commandNames.has("farfold-lifemodel-context") &&
        commandNames.has("farfold-lifemodel-clear");
      setCommands(
        discoveredCommands.filter(
          (command) => !command.name.startsWith("farfold-lifemodel-"),
        ),
      );
    } else if (response.command === "set_model") {
      refreshPi(true);
    } else if (response.command === "set_thinking_level") {
      void sendRpc({ type: "get_state" });
      void sendRpc({ type: "get_available_thinking_levels" });
    } else if (
      response.command === "new_session" ||
      response.command === "switch_session"
    ) {
      if (asRecord(response.data)?.cancelled === true) return;
      currentNativeSessionId.current = null;
      lifeModelSourceCursor.current = null;
      lifeModelSourcePrimedFor.current = null;
      setRuntimeReadyGeneration(null);
      setConversation(initialConversation);
      setPiState((current) => ({ ...current, contextPercent: null }));
      refreshPi(true);
      reloadSessions();
    }
  }

  function queuePiHostReconciliation(state: HostShadowState): Promise<void> {
    const request = hostRuntimeReconciliationRequest(
      state,
      PI_RUNTIME_IDENTITY.installationId,
    );
    if (!request || request.key === lastPiHostReconciliation.current) {
      return piHostReconciliation.current;
    }
    lastPiHostReconciliation.current = request.key;
    setRuntimeReconciling(true);
    setRuntimeReadyGeneration(null);
    setExtensionDialogs([]);
    piHostReconciliation.current = piHostReconciliation.current
      .catch(() => undefined)
      .then(async () => {
        const current = await runtimeStatus();
        if (!current.running) {
          acknowledgeHostRuntimeReconciliation(request);
          setRuntimeReconciling(false);
          return;
        }
        const reconciled = await reconcilePiHostSession();
        if (reconciled.runtimeGeneration !== current.generation) {
          throw new Error(
            "Pi reconciliation returned a different Runtime generation.",
          );
        }
        await hydratePiFromRuntime();
        acknowledgeHostRuntimeReconciliation(request);
        setRuntimeReconciling(false);
      })
      .catch((reason) => {
        setError(`Pi 状态重建失败：${String(reason)}`);
      });
    return piHostReconciliation.current;
  }

  function applyHostShadowState(state: HostShadowState): void {
    queuePiHostReconciliation(state);
    setHostShadowState(state);
    if (hostShadowQaEnabled) {
      setHostShadowUnavailable(false);
    }
  }

  async function injectHostSequenceGapForQa(): Promise<void> {
    if (!hostShadowQaEnabled || hostGapQaBusy) return;
    const handle = hostShadowHandle.current;
    if (!handle) {
      setError("P3 Host Channel 尚未就绪，不能注入 sequence gap。");
      return;
    }
    let resumeCursor: HostResumeCursor | null = null;
    setHostGapQaBusy(true);
    try {
      const current = await runtimeStatus();
      if (!current.running) {
        throw new Error("请先启动 Pi，再运行 P3 sequence-gap 恢复检查。");
      }
      const snapshot = handle.snapshot();
      resumeCursor = {
        streamId: snapshot.streamId,
        latestSequence: snapshot.latestSequence,
      };
      await handle.stop();
      if (hostShadowHandle.current === handle) hostShadowHandle.current = null;

      for (let index = 0; index < hostShadowQaReconciliationCount; index += 1) {
        await reconcilePiHostSession();
      }
      const resumed = await startHostShadow(
        applyHostShadowState,
        undefined,
        resumeCursor,
      );
      hostShadowHandle.current = resumed;
      const recovery = hostRuntimeReconciliationRequest(
        resumed.snapshot(),
        PI_RUNTIME_IDENTITY.installationId,
      );
      if (!recovery?.reasons.includes("host_sequence_gap")) {
        throw new Error("P3 QA ring 未产生可验证的 sequence gap。");
      }
      await queuePiHostReconciliation(resumed.snapshot());
    } catch (reason) {
      setError(`P3 sequence-gap 恢复检查失败：${String(reason)}`);
    } finally {
      if (!hostShadowHandle.current && resumeCursor) {
        try {
          hostShadowHandle.current = await startHostShadow(
            applyHostShadowState,
            undefined,
            resumeCursor,
          );
        } catch {
          setHostShadowUnavailable(true);
        }
      }
      setHostGapQaBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void startHostShadow(applyHostShadowState)
      .then((handle) => {
        if (cancelled) {
          void handle.stop();
          return;
        }
        hostShadowHandle.current = handle;
      })
      .catch(() => {
        if (hostShadowQaEnabled) setHostShadowUnavailable(true);
      });
    return () => {
      cancelled = true;
      const handle = hostShadowHandle.current;
      hostShadowHandle.current = null;
      if (handle) void handle.stop();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let capabilityPolling = false;
    void runtimeStatus().then((next) => {
      if (!cancelled) {
        if (applyRuntimeStatus(next)) {
          setProjectPath(
            next.projectPath ?? next.savedProjectPath ?? hostShadowQaProject,
          );
          refreshPi(next.running);
        }
      }
    });
    reloadSessions();
    void loadLifeModel();
    void startCapabilities()
      .then(() => loadCapabilities(false))
      .catch((reason) => setError(String(reason)));

    function handlePiEvent(event: PiEnvelope) {
      if (!acceptsRuntimeEvent(runtimeGeneration.current, event)) return;
      if (event.generation > runtimeGeneration.current) {
        rejectPendingRpc("Pi 已切换到新的运行代际，请重试请求。");
      }
      runtimeGeneration.current = event.generation;
      if (event.kind === "rpc") {
        if (isResponse(event.payload)) {
          settleRpcResponse(event.payload);
          handleResponse(event.payload);
        } else {
          const extensionRequest = parseExtensionUiRequest(event.payload);
          if (extensionRequest) {
            if (
              extensionRequest.method === "select" ||
              extensionRequest.method === "confirm" ||
              extensionRequest.method === "input" ||
              extensionRequest.method === "editor"
            ) {
              setExtensionDialogs((current) =>
                current.some((request) => request.id === extensionRequest.id)
                  ? current
                  : [...current, extensionRequest],
              );
            } else if (extensionRequest.method === "notify") {
              setExtensionNotice({
                message: extensionRequest.message ?? "Pi Extension 通知",
                type: extensionRequest.notifyType ?? "info",
              });
            } else if (extensionRequest.method === "setStatus") {
              const key = extensionRequest.statusKey ?? extensionRequest.id;
              setExtensionStatuses((current) => {
                const next = { ...current };
                if (extensionRequest.statusText) {
                  next[key] = extensionRequest.statusText;
                } else {
                  delete next[key];
                }
                return next;
              });
            } else if (extensionRequest.method === "setWidget") {
              setExtensionWidgets((current) => {
                const next = { ...current };
                const key = extensionRequest.widgetKey ?? extensionRequest.id;
                if (extensionRequest.widgetLines?.length) {
                  next[key] = {
                    lines: extensionRequest.widgetLines,
                    placement:
                      extensionRequest.widgetPlacement ?? "aboveEditor",
                  };
                } else {
                  delete next[key];
                }
                return next;
              });
            } else if (extensionRequest.method === "setTitle") {
              document.title = extensionRequest.title || "Farfold";
            } else if (extensionRequest.method === "set_editor_text") {
              setMessage(extensionRequest.text ?? "");
            }
          }
          const type = asRecord(event.payload)?.type;
          if (type === "message_end") {
            const message = asRecord(asRecord(event.payload)?.message);
            const providerId = currentProvider.current;
            if (providerId && message?.role === "assistant") {
              const failed =
                message.stopReason === "error" ||
                typeof message.errorMessage === "string";
              setProviderValidations((current) => ({
                ...current,
                [providerId]: {
                  state: failed ? "verified-failure" : "verified-success",
                  checkedAt: Date.now(),
                  ...(currentModelName.current
                    ? { modelName: currentModelName.current }
                    : {}),
                  ...(failed && typeof message.errorMessage === "string"
                    ? { error: formatProviderError(message.errorMessage) }
                    : {}),
                },
              }));
            }
          }
          if (type === "agent_start") setWorkStartedAt(Date.now());
          if (type === "agent_settled") {
            setWorkStartedAt(null);
            void sendRpc({ type: "get_state" });
            void sendRpc({ type: "get_messages" });
            void sendRpc({ type: "get_session_stats" });
            collectLifeModelSources();
            reloadSessions();
          }
          const fallback = projectUnknownPiEvent(event.payload);
          if (fallback) {
            unknownRuntimeEvents.current = appendBounded(
              unknownRuntimeEvents.current,
              event,
              32,
            );
          }
          setConversation((current) => {
            const next = reducePiEvent(current, event.payload);
            return fallback ? { ...next, notice: fallback.notice } : next;
          });
        }
      }
      if (event.kind === "lifecycle") {
        void runtimeStatus().then((next) => {
          if (applyRuntimeStatus(next)) refreshPi(next.running);
        });
      }
      if (event.kind === "lifecycle" && event.payload.state === "terminated") {
        rejectPendingRpc("Pi 已停止，未完成的请求已取消。");
        currentNativeSessionId.current = null;
        lifeModelSourceCursor.current = null;
        lifeModelSourcePrimedFor.current = null;
        lifeModelExtensionReady.current = false;
        setRuntimeReadyGeneration(null);
        setRuntimeTransition(null);
        setWorkStartedAt(null);
        const failure = lifecycleFailureMessage(event.payload);
        if (failure) setError(failure);
      }
      if (event.kind === "stderr")
        setError(`Pi sidecar：${event.payload.trim()}`);
      if (event.kind === "protocol_error") {
        setError(`Pi 协议错误：${event.payload.error}`);
      }
    }

    const stopRuntimeEvents = subscribeHostRuntimeEvents((routed) => {
      if (routed.runtime.productId !== "pi") return;
      const envelope = runtimeEnvelopeFromHostEvent(routed);
      if (
        !envelope ||
        !["rpc", "stderr", "lifecycle", "protocol_error"].includes(
          envelope.kind,
        )
      ) {
        return;
      }
      handlePiEvent(envelope as PiEnvelope);
    });

    function handleCapabilityEvent(event: CapabilityEvent) {
      if (settleCapabilityEvent(event)) return;
      if (event.type === "auth_prompt") {
        setAuthFlow((current) => ({
          providerId: event.providerId,
          requestId: event.requestId,
          prompt: { id: event.promptId, value: event.prompt },
          notice:
            current?.providerId === event.providerId ? current.notice : null,
          error: null,
        }));
      } else if (event.type === "auth_event") {
        setAuthFlow((current) => ({
          providerId: event.providerId,
          requestId: event.requestId,
          prompt:
            current?.providerId === event.providerId ? current.prompt : null,
          notice: event.event,
          error: null,
        }));
        if (event.event.type === "auth_url") {
          void openUrl(event.event.url).catch((reason) =>
            setError(String(reason)),
          );
        }
      } else if (event.type === "bridge_error") {
        setError(event.error);
      } else if (event.type === "bridge_lifecycle") {
        rejectCapabilityRequests("Pi capability bridge 已停止，请重试。");
      }
    }

    const interval = window.setInterval(() => {
      if (!capabilityPolling) {
        capabilityPolling = true;
        void pollCapabilityEvents()
          .then((events) => events.forEach(handleCapabilityEvent))
          .catch((reason) => setError(String(reason)))
          .finally(() => {
            capabilityPolling = false;
          });
      }
    }, 200);
    return () => {
      cancelled = true;
      stopRuntimeEvents();
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    currentProvider.current = piState.model?.provider ?? null;
    currentModelName.current = piState.model?.name ?? null;
  }, [piState.model]);

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [working]);

  useEffect(() => {
    if (!currentProject) {
      setProjectReadiness(null);
      setReadinessLoading(false);
      return;
    }
    let cancelled = false;
    setReadinessLoading(true);
    void getProjectReadiness(currentProject)
      .then((next) => {
        if (!cancelled) setProjectReadiness(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setReadinessLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentProject]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversation.timeline, conversation.steering]);

  async function chooseProject(switchRunning = false) {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 Farfold Project",
    });
    if (typeof selected !== "string") return;
    setProjectPath(selected);
    if (!switchRunning || !status.running) return;

    setError(null);
    try {
      setRuntimeTransition("stopping");
      const stopped = await stopRuntime();
      applyRuntimeStatus(stopped);
      setConversation(initialConversation);
      setPiState(initialPiState);
      setModels([]);
      setCommands([]);
      setModelDiscovery("loading");
      setRuntimeTransition("starting");
      const restarted = await startRuntime({
        projectPath: selected,
        sessionFile: null,
        resumePrevious: false,
        projectTrust,
      });
      applyRuntimeStatus(restarted);
      refreshPi(restarted.running);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRuntimeTransition(null);
    }
  }

  async function start(resumePrevious: boolean): Promise<void> {
    if (transitioning || lifecycleActionInFlight.current) return;
    lifecycleActionInFlight.current = true;
    setError(null);
    setRuntimeTransition("starting");
    try {
      const next = await startRuntime({
        projectPath,
        sessionFile: null,
        resumePrevious,
        projectTrust,
      });
      applyRuntimeStatus(next);
      setProjectPath(next.projectPath ?? projectPath);
      setModels([]);
      setCommands([]);
      setModelDiscovery("loading");
      refreshPi(next.running);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRuntimeTransition(null);
      lifecycleActionInFlight.current = false;
    }
  }

  async function changeProjectTrust(nextTrust: ProjectTrust): Promise<void> {
    if (nextTrust === projectTrust) return;
    if (!status.running || working || !currentProject) {
      setProjectTrust(nextTrust);
      return;
    }
    if (transitioning || lifecycleActionInFlight.current) return;
    lifecycleActionInFlight.current = true;
    setProjectTrust(nextTrust);

    setError(null);
    setRuntimeTransition("stopping");
    try {
      const stopped = await stopRuntime();
      applyRuntimeStatus(stopped);
      setModels([]);
      setCommands([]);
      setModelDiscovery("loading");
      setRuntimeTransition("starting");
      const restarted = await startRuntime({
        projectPath: currentProject,
        sessionFile: resumableCurrentSession,
        resumePrevious: Boolean(resumableCurrentSession),
        projectTrust: nextTrust,
      });
      applyRuntimeStatus(restarted);
      refreshPi(restarted.running);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRuntimeTransition(null);
      lifecycleActionInFlight.current = false;
    }
  }

  async function saveSessionTitle(): Promise<void> {
    const nextTitle = cleanManualSessionTitle(titleDraft, 80);
    if (nextTitle === "新对话") {
      setError("请填写一个可识别的对话标题。");
      return;
    }
    try {
      await sendRpc({ type: "set_session_name", name: nextTitle });
      setPiState((current) => ({ ...current, sessionName: nextTitle }));
      setSessions((current) =>
        current.map((session) =>
          session.sessionFile === piState.sessionFile
            ? { ...session, title: nextTitle }
            : session,
        ),
      );
      setEditingTitle(false);
      reloadSessions();
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function send() {
    const text = message.trim();
    if (!text || !runtimeCommandReady || submitting) return;
    setError(null);
    setSubmitting(true);
    const wantedInjection =
      !working &&
      lifeModelSnapshot?.enabled === true &&
      selectedLifeModelItemIds.length > 0;
    let preparedInjection: Awaited<
      ReturnType<typeof prepareLifeModelInjection>
    > | null = null;
    let stagedManifestId: string | null = null;
    try {
      if (
        wantedInjection &&
        piState.sessionId &&
        lifeModelExtensionReady.current
      ) {
        try {
          preparedInjection = await prepareLifeModelInjection(
            "pi",
            piState.sessionId,
            selectedLifeModelItemIds,
          );
          if (!preparedInjection.commandArgument) {
            throw new Error("LifeModel 未生成 Pi Extension 参数");
          }
          stagedManifestId = preparedInjection.manifestId;
          await sendRpc({
            type: "prompt",
            message: `/farfold-lifemodel-context ${preparedInjection.commandArgument}`,
          });
        } catch (reason) {
          if (preparedInjection) {
            void finishLifeModelInjection(
              stagedManifestId ?? preparedInjection.manifestId,
              false,
            ).catch(() => undefined);
          }
          preparedInjection = null;
          void sendRpc({
            type: "prompt",
            message: "/farfold-lifemodel-clear",
          }).catch(() => undefined);
          setExtensionNotice({
            type: "warning",
            message: `LifeModel 上下文未注入，本条消息仍按普通 Pi 对话发送：${String(reason)}`,
          });
        }
      } else if (wantedInjection) {
        setExtensionNotice({
          type: "warning",
          message: piState.sessionId
            ? "LifeModel Pi Extension 未就绪；本条消息不注入上下文。"
            : "尚未取得 Pi native Session ID；本条消息不注入 LifeModel。",
        });
      }
      await sendRpc({ type: working ? delivery : "prompt", message: text });
      if (preparedInjection) {
        try {
          const snapshot = await finishLifeModelInjection(
            stagedManifestId ?? preparedInjection.manifestId,
            true,
          );
          setLifeModelSnapshot(snapshot);
        } catch (reason) {
          setExtensionNotice({
            type: "warning",
            message: `Pi 已收到消息，但 Injection Manifest 完成状态写入失败：${String(reason)}`,
          });
        }
      }
      if (!working) {
        setConversation((current) => ({
          ...current,
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
      }
      if (wantedInjection) setSelectedLifeModelItemIds([]);
      setMessage("");
    } catch (reason) {
      if (stagedManifestId) {
        void finishLifeModelInjection(stagedManifestId, false).catch(
          () => undefined,
        );
        void sendRpc({
          type: "prompt",
          message: "/farfold-lifemodel-clear",
        }).catch(() => undefined);
      }
      setError(String(reason));
    } finally {
      setSubmitting(false);
    }
  }

  async function abort() {
    setError(null);
    try {
      await sendRpc({ type: "abort" });
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function newSession() {
    if (transitioning) return;
    if (!status.running) {
      await start(false);
      return;
    }
    if (working) return;
    setError(null);
    try {
      await sendRpc({ type: "new_session" });
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function openHostPiSession(farfoldSessionId: string) {
    if (working || transitioning || lifecycleActionInFlight.current) return;
    lifecycleActionInFlight.current = true;
    setError(null);
    try {
      if (status.running) {
        setRuntimeTransition("stopping");
        const stopped = await stopRuntime();
        applyRuntimeStatus(stopped);
      }
      setRuntimeTransition("starting");
      const opened = await openHostSession(farfoldSessionId, projectTrust);
      if (opened.runtimeProductId !== "pi") {
        throw new Error("Host opened a non-Pi Session in the Pi workspace.");
      }
      const next = await runtimeStatus();
      applyRuntimeStatus(next);
      const binding = opened.navigation.sessionIndex.sessions.find(
        (session) => session.farfoldSessionId === farfoldSessionId,
      );
      setProjectPath(
        next.projectPath ?? binding?.workingCopyPath ?? projectPath,
      );
      setConversation(initialConversation);
      setPiState(initialPiState);
      setModels([]);
      setCommands([]);
      setModelDiscovery("loading");
      refreshPi(next.running);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRuntimeTransition(null);
      lifecycleActionInFlight.current = false;
    }
  }

  async function selectModel(model: PiModel) {
    setError(null);
    try {
      if (status.running) {
        await sendRpc({
          type: "set_model",
          provider: model.provider,
          modelId: model.id,
        });
      } else {
        await makeDefaultModel(model, piState.thinkingLevel);
      }
    } catch (reason) {
      setError(String(reason));
      throw reason;
    }
  }

  async function selectThinkingLevel(level: ThinkingLevel) {
    setError(null);
    try {
      if (status.running) {
        await sendRpc({ type: "set_thinking_level", level });
      } else if (currentModel) {
        await makeDefaultModel(currentModel, level);
      }
    } catch (reason) {
      setError(String(reason));
      throw reason;
    }
  }

  async function makeDefaultModel(model: PiModel, level: ThinkingLevel) {
    const settings = await setDefaultModel(
      model.provider,
      model.id,
      level,
      currentProject,
    );
    setCapabilities((current) =>
      current ? { ...current, settings } : current,
    );
  }

  async function restartAfterCapabilityChange(
    wasRunning: boolean,
    previousProject: string | null,
    previousSession: string | null,
  ) {
    if (wasRunning) {
      setRuntimeTransition("stopping");
      const stopped = await stopRuntime();
      applyRuntimeStatus(stopped);
    }
    await loadCapabilities(false);
    if (!wasRunning) return;

    setRuntimeTransition("starting");
    const restarted = await startRuntime({
      projectPath: previousProject,
      sessionFile: previousSession,
      resumePrevious: Boolean(previousSession),
      projectTrust,
    });
    applyRuntimeStatus(restarted);
    setModels([]);
    setModelDiscovery("loading");
    refreshPi(restarted.running);
  }

  function startProviderLogin(providerId: string, authType: AuthType) {
    if (working) return;
    const wasRunning = status.running;
    const previousProject = status.projectPath ?? projectPath;
    const previousSession = resumableCurrentSession;
    setAuthFlow({
      providerId,
      requestId: null,
      prompt: null,
      notice: null,
      error: null,
    });
    setProviderSettingsBusy(true);
    setError(null);
    void loginProvider(providerId, authType)
      .then((result) => {
        setProviderValidations((current) => {
          const next = { ...current };
          delete next[result.providerId];
          return next;
        });
      })
      .then(() =>
        restartAfterCapabilityChange(
          wasRunning,
          previousProject,
          previousSession,
        ),
      )
      .then(() => setAuthFlow(null))
      .catch((reason) => {
        setError(String(reason));
        setAuthFlow((current) =>
          current
            ? {
                ...current,
                requestId: null,
                error: String(reason),
                prompt: null,
              }
            : current,
        );
      })
      .finally(() => {
        setRuntimeTransition(null);
        setProviderSettingsBusy(false);
      });
  }

  function answerProviderPrompt(
    requestId: string,
    promptId: string,
    value: string,
  ) {
    setAuthFlow((current) =>
      current ? { ...current, prompt: null } : current,
    );
    void respondToAuthPrompt(requestId, promptId, value).catch((reason) => {
      setError(String(reason));
      setAuthFlow((current) =>
        current ? { ...current, error: String(reason) } : current,
      );
    });
  }

  function cancelLogin(requestId: string) {
    void cancelProviderLogin(requestId)
      .catch((reason) => setError(String(reason)))
      .finally(() => setAuthFlow(null));
  }

  function testConnection(providerId: string) {
    if (working || testingProvider) return;
    setTestingProvider(providerId);
    setError(null);
    void testProviderConnection(providerId)
      .then((result) => {
        setProviderValidations((current) => ({
          ...current,
          [providerId]: {
            state: "verified-success",
            checkedAt: result.checkedAt,
            modelName: result.model.name,
          },
        }));
      })
      .catch((reason) => {
        const message =
          reason instanceof Error ? reason.message : String(reason);
        setProviderValidations((current) => ({
          ...current,
          [providerId]: {
            state: "verified-failure",
            checkedAt: Date.now(),
            error: formatProviderError(message),
          },
        }));
      })
      .finally(() => setTestingProvider(null));
  }

  async function removeProvider(providerId: string) {
    if (working) throw new Error("Pi 工作时不能修改当前 Provider 凭据");
    const wasRunning = status.running;
    const previousProject = status.projectPath ?? projectPath;
    const previousSession = resumableCurrentSession;
    setProviderSettingsBusy(true);
    setError(null);
    try {
      await logoutProvider(providerId);
      await restartAfterCapabilityChange(
        wasRunning,
        previousProject,
        previousSession,
      );
      setProviderValidations((current) => {
        const next = { ...current };
        delete next[providerId];
        return next;
      });
    } catch (reason) {
      setError(String(reason));
      throw reason;
    } finally {
      setRuntimeTransition(null);
      setProviderSettingsBusy(false);
    }
  }

  async function saveCustomProvider(input: CustomProviderInput) {
    if (working) throw new Error("Pi 工作时不能修改自定义 Provider");
    const wasRunning = status.running;
    const previousProject = status.projectPath ?? projectPath;
    const previousSession = resumableCurrentSession;
    setProviderSettingsBusy(true);
    setError(null);
    try {
      if (wasRunning) {
        setRuntimeTransition("stopping");
        const stopped = await stopRuntime();
        applyRuntimeStatus(stopped);
      }
      const snapshot = await upsertCustomProvider(input, currentProject);
      setCapabilities(snapshot);
      setCapabilityState("ready");
      if (wasRunning) {
        setRuntimeTransition("starting");
        const restarted = await startRuntime({
          projectPath: previousProject,
          sessionFile: previousSession,
          resumePrevious: Boolean(previousSession),
          projectTrust,
        });
        applyRuntimeStatus(restarted);
        setModels([]);
        setModelDiscovery("loading");
        refreshPi(restarted.running);
      }
    } catch (reason) {
      setError(String(reason));
      throw reason;
    } finally {
      setRuntimeTransition(null);
      setProviderSettingsBusy(false);
    }
  }

  function answerExtensionDialog(response: {
    value?: string;
    confirmed?: boolean;
    cancelled?: boolean;
  }) {
    const request = extensionDialogs[0];
    if (!request || runtimeReconciling) return;
    setExtensionDialogs((current) => current.slice(1));
    void sendRpc({
      type: "extension_ui_response",
      id: request.id,
      ...response,
    }).catch((reason) => setError(String(reason)));
  }

  function expireExtensionDialog() {
    setExtensionDialogs((current) => current.slice(1));
  }

  function openLifeModel(): void {
    setLifeModelOpen(true);
    void loadLifeModel();
  }

  function createProposal(input: CreateProposalInput): void {
    void runLifeModelMutation(() => createLifeModelProposal(input));
  }

  function updateProposal(input: UpdateProposalInput): void {
    void runLifeModelMutation(() => updateLifeModelProposal(input));
  }

  function approveProposal(proposalId: string): void {
    void runLifeModelMutation(() => approveLifeModelProposal(proposalId));
  }

  function rejectProposal(proposalId: string): void {
    void runLifeModelMutation(() => rejectLifeModelProposal(proposalId));
  }

  function deleteCanonicalItem(itemId: string): void {
    if (
      !window.confirm(
        "删除后，所有 Runtime 都不能再注入这条 canonical LifeModel 内容。来源 Proposal 审计会保留。确认删除？",
      )
    ) {
      return;
    }
    void runLifeModelMutation(async () => {
      await deleteLifeModelItem(itemId);
      setSelectedLifeModelItemIds((current) =>
        current.filter((candidate) => candidate !== itemId),
      );
    });
  }

  function withdrawCanonicalSource(itemId: string, sourceId: string): void {
    if (
      !window.confirm(
        "这只会撤销来源与 canonical item 的关联，不会修改 Pi 或 OpenCode 的原生历史。确认撤销？",
      )
    ) {
      return;
    }
    void runLifeModelMutation(() => withdrawLifeModelSource(itemId, sourceId));
  }

  function changeLifeModelEnabled(enabled: boolean): void {
    void runLifeModelMutation(async () => {
      await setLifeModelEnabled(enabled);
      if (!enabled) setSelectedLifeModelItemIds([]);
    });
  }

  async function selectRuntime(runtime: RuntimeProduct): Promise<void> {
    if (
      runtime === selectedRuntime ||
      working ||
      submitting ||
      transitioning ||
      lifecycleActionInFlight.current
    ) {
      return;
    }
    setError(null);
    lifecycleActionInFlight.current = true;
    try {
      if (status.running) {
        setRuntimeTransition("stopping");
        const stopped = await stopRuntime();
        applyRuntimeStatus(stopped);
      }
      setSelectedRuntime(runtime);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRuntimeTransition(null);
      lifecycleActionInFlight.current = false;
    }
  }

  if (selectedRuntime === "opencode") {
    return (
      <>
        <OpenCodeWorkspace
          initialProjectPath={projectPath}
          onProjectPath={setProjectPath}
          onSelectRuntime={setSelectedRuntime}
          lifeModel={{
            open: lifeModelOpen,
            snapshot: lifeModelSnapshot,
            candidates: lifeModelSources,
            selectedItemIds: selectedLifeModelItemIds,
            unavailable: lifeModelUnavailable,
            busy: lifeModelBusy,
            onOpen: openLifeModel,
            onClose: () => setLifeModelOpen(false),
            onReload: () => void loadLifeModel(),
            onSources: mergeLifeModelSources,
            onSnapshot: setLifeModelSnapshot,
            onCreate: createProposal,
            onUpdate: updateProposal,
            onApprove: approveProposal,
            onReject: rejectProposal,
            onDelete: deleteCanonicalItem,
            onWithdrawSource: withdrawCanonicalSource,
            onEnabled: changeLifeModelEnabled,
            onSelectItem: selectLifeModelItem,
            onClearSelection: () => setSelectedLifeModelItemIds([]),
          }}
        />
        {hostShadowQaEnabled && (
          <HostShadowQaBadge
            state={hostShadowState}
            unavailable={hostShadowUnavailable}
            injectingGap={hostGapQaBusy}
            onInjectGap={() => void injectHostSequenceGapForQa()}
          />
        )}
      </>
    );
  }

  return (
    <div className="app-shell">
      {hostShadowQaEnabled && (
        <HostShadowQaBadge
          state={hostShadowState}
          unavailable={hostShadowUnavailable}
          injectingGap={hostGapQaBusy}
          onInjectGap={() => void injectHostSequenceGapForQa()}
        />
      )}
      <Sidebar
        sessions={piSidebarSessions}
        activeSessionKey={activePiHostSessionKey}
        search={sessionSearch}
        projectFilter={projectFilter}
        disabled={
          working ||
          submitting ||
          transitioning ||
          (status.running && !runtimeCommandReady)
        }
        connectedProviderCount={connectedProviderCount}
        onSearch={setSessionSearch}
        onProjectFilter={setProjectFilter}
        onNew={() => void newSession()}
        onSelect={(item) => {
          void openHostPiSession(item.key);
        }}
        onOpenConnections={() => {
          setProviderSettingsTarget(null);
          setProviderSettingsOpen(true);
        }}
      />

      <main className="workspace">
        <header className="workspace-header">
          {editingTitle ? (
            <form
              className="session-title-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void saveSessionTitle();
              }}
            >
              <input
                autoFocus
                aria-label="对话标题"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditingTitle(false);
                }}
              />
              <button type="submit">保存</button>
              <button type="button" onClick={() => setEditingTitle(false)}>
                取消
              </button>
            </form>
          ) : (
            <div className="session-title">
              <h1>{conversationTitle}</h1>
              {status.running && piState.sessionFile && !working && (
                <button
                  className="session-title-edit"
                  aria-label="重命名对话"
                  title="重命名对话"
                  onClick={() => {
                    setTitleDraft(piState.sessionName ?? conversationTitle);
                    setEditingTitle(true);
                  }}
                >
                  <PencilSimple size={14} />
                </button>
              )}
            </div>
          )}
          <div className="header-meta">
            <ModelPicker
              current={currentModel}
              thinkingLevel={currentThinkingLevel}
              availableThinkingLevels={currentThinkingLevels}
              models={mergedModels}
              providers={providers}
              settings={capabilities?.settings ?? null}
              running={status.running}
              working={working || transitioning || runtimeReconciling}
              refreshing={
                capabilityState === "loading" ||
                capabilityState === "refreshing"
              }
              onSelect={selectModel}
              onThinkingLevel={selectThinkingLevel}
              onSetDefault={makeDefaultModel}
              onConfigureProvider={(providerId) => {
                setProviderSettingsTarget(providerId ?? null);
                setProviderSettingsOpen(true);
              }}
              onRefresh={() => void loadCapabilities(true)}
            />
            <span className="header-separator" />
            <RuntimeChooser
              value="pi"
              disabled={
                working || submitting || transitioning || runtimeReconciling
              }
              onChange={(runtime) => void selectRuntime(runtime)}
            />
            <span className="header-separator" />
            <button
              className="header-project"
              onClick={openLifeModel}
              title="打开 LifeModel"
            >
              <Brain size={14} />
              LifeModel
              {lifeModelSnapshot?.items.length
                ? ` · ${lifeModelSnapshot.items.length}`
                : ""}
            </button>
            <span className="header-separator" />
            <button
              className="header-project"
              title={currentProject ?? undefined}
              onClick={() => void chooseProject(true)}
              disabled={
                working || submitting || transitioning || runtimeReconciling
              }
            >
              <FolderSimple size={14} />
              {projectName(currentProject)}
            </button>
            <span className="header-separator" />
            <div className={`runtime-state${working ? " working" : ""}`}>
              <i />
              {runtimeReconciling
                ? "Pi 正在重建状态"
                : working
                  ? `Pi 正在工作 · ${elapsedLabel(workStartedAt, now)}`
                  : runtimePhase === "starting"
                    ? "Pi 正在启动"
                    : runtimePhase === "stopping"
                      ? "Pi 正在停止"
                      : status.running
                        ? runtimeCommandReady
                          ? "Pi 已启动"
                          : "Pi 正在连接"
                        : "Pi 未启动"}
            </div>
            {extensionStatus && (
              <span className="extension-status" title={extensionStatus}>
                {extensionStatus}
              </span>
            )}
          </div>
        </header>

        {status.running && (
          <div className="startup-strip" role="status">
            <span>{startupMode}</span>
            <i />
            <span>
              Pi 当前可调用：
              {projectCommands.length
                ? `${projectCommands.length} 项项目命令`
                : "未发现项目命令"}
            </span>
            <label>
              <span className="sr-only">本次启动策略</span>
              <select
                value={projectTrust}
                disabled={working || transitioning}
                onChange={(event) =>
                  void changeProjectTrust(event.target.value as ProjectTrust)
                }
              >
                <option value="approve">载入受保护项目资源</option>
                <option value="ignore">不载入受保护项目资源</option>
                <option value="saved">遵循 Pi 已保存选择</option>
              </select>
            </label>
          </div>
        )}

        <section className="conversation-scroll" aria-live="polite">
          {!status.running ? (
            <div className="start-state">
              <img src={appIconUrl} alt="" />
              <h2>{canResume ? "继续最近的对话" : "开始一段新对话"}</h2>
              <p>选择一个 Project，Farfold 会在其中启动原生 Pi Session。</p>
              <button
                className="connection-entry"
                data-provider-settings-trigger
                onClick={() => {
                  setProviderSettingsTarget(null);
                  setProviderSettingsOpen(true);
                }}
                disabled={transitioning}
              >
                <span className="connection-entry-mark">
                  {activeProvider?.name.slice(0, 1) ?? "P"}
                </span>
                <span>
                  <small>Provider</small>
                  <strong>{activeProvider?.name ?? "连接模型服务"}</strong>
                </span>
                <em className={activeProvider?.configured ? "configured" : ""}>
                  {providerStateLabel}
                </em>
              </button>
              <button
                className="project-picker"
                onClick={() => void chooseProject(false)}
                disabled={transitioning}
              >
                <FolderOpen size={20} />
                <span>
                  <small>Project</small>
                  <strong>{projectPath ?? "选择文件夹"}</strong>
                </span>
              </button>
              <ProjectReadinessCard
                projectPath={projectPath}
                readiness={projectReadiness}
                loading={readinessLoading}
                trust={projectTrust}
                providerState={providerStateLabel}
                disabled={transitioning}
                onTrust={(value) => void changeProjectTrust(value)}
              />
              <div className="start-actions">
                <button
                  className="start-primary"
                  onClick={() => void start(canResume)}
                  disabled={transitioning}
                >
                  {runtimePhase === "starting"
                    ? "正在启动…"
                    : canResume
                      ? "继续对话"
                      : "启动 Agent"}
                </button>
                {canResume && (
                  <button
                    onClick={() => void start(false)}
                    disabled={transitioning}
                  >
                    新建 Session
                  </button>
                )}
              </div>
            </div>
          ) : conversation.timeline.length === 0 ? (
            <div className="empty-conversation">
              <span className="brand-letter">F</span>
              <h2>现在想完成什么？</h2>
              <p>直接描述目标，Farfold 会把任务交给当前 Pi Session。</p>
            </div>
          ) : (
            <div className="message-list">
              {displayTimeline.map((item) =>
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
                        {item.role === "user" ? "你" : "Farfold"}
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
                  />
                ) : null,
              )}
              <PiActivity tools={[]} notice={conversation.notice} />
              <QueueNotice
                steering={conversation.steering}
                followUp={conversation.followUp}
              />
            </div>
          )}
          {status.running &&
            modelDiscovery === "ready" &&
            models.length === 0 && (
              <div className="inline-warning">
                <span>Pi 未返回可用模型。请检查 Provider 凭据后重试。</span>
                <button
                  data-provider-settings-trigger
                  onClick={() => {
                    setProviderSettingsTarget(null);
                    setProviderSettingsOpen(true);
                  }}
                >
                  打开 Provider 设置
                </button>
              </div>
            )}
          <div ref={transcriptEnd} />
        </section>

        <div className="runtime-notices">
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button onClick={() => setError(null)} aria-label="关闭错误">
                <X size={15} />
              </button>
            </div>
          )}

          {extensionNotice && (
            <div
              className={`extension-notice ${extensionNotice.type}`}
              role={extensionNotice.type === "error" ? "alert" : "status"}
            >
              <span>{extensionNotice.message}</span>
              <button
                onClick={() => setExtensionNotice(null)}
                aria-label="关闭通知"
              >
                <X size={15} />
              </button>
            </div>
          )}

          {extensionWidgetAbove.length > 0 && (
            <div className="extension-widget">
              {extensionWidgetAbove.map((line, index) => (
                <span key={`${index}-${line}`}>{line}</span>
              ))}
            </div>
          )}
        </div>

        <Composer
          running={status.running && !transitioning && !runtimeReconciling}
          ready={runtimeCommandReady}
          working={working}
          submitting={submitting}
          message={message}
          delivery={delivery}
          projectName={projectName(currentProject)}
          contextPercent={piState.contextPercent}
          commands={commands}
          lifeModelItems={selectedLifeModelItems.map((item) => ({
            id: item.id,
            label: `${item.key}: ${item.value}`,
          }))}
          onMessage={setMessage}
          onDelivery={setDelivery}
          onSend={() => void send()}
          onAbort={() => void abort()}
          onRemoveLifeModelItem={(itemId) => selectLifeModelItem(itemId, false)}
          onOpenLifeModel={openLifeModel}
        />
        {extensionWidgetBelow.length > 0 && (
          <div className="extension-widget below-editor">
            {extensionWidgetBelow.map((line, index) => (
              <span key={`${index}-${line}`}>{line}</span>
            ))}
          </div>
        )}
      </main>
      {extensionDialogs[0] && (
        <ExtensionDialog
          request={extensionDialogs[0]}
          onRespond={answerExtensionDialog}
          onExpire={expireExtensionDialog}
        />
      )}
      {providerSettingsOpen && (
        <ProviderSettings
          providers={providers}
          preferredProvider={providerSettingsTarget ?? piState.model?.provider}
          activeModel={currentModel}
          orphanCredentials={capabilities?.orphanCredentials ?? []}
          customProviderIds={capabilities?.customProviderIds ?? []}
          validations={providerValidations}
          busy={providerSettingsBusy}
          taskLocked={working || runtimeReconciling}
          refreshing={capabilityState === "refreshing"}
          testingProvider={testingProvider}
          authFlow={authFlow}
          onClose={() => {
            setProviderSettingsOpen(false);
            setProviderSettingsTarget(null);
          }}
          onLogin={startProviderLogin}
          onAuthResponse={answerProviderPrompt}
          onCancelLogin={cancelLogin}
          onDismissAuth={() => setAuthFlow(null)}
          onTestConnection={testConnection}
          onSaveCustom={saveCustomProvider}
          onLogout={removeProvider}
          onRefresh={() => void loadCapabilities(true)}
        />
      )}
      {lifeModelOpen && (
        <LifeModelPanel
          snapshot={lifeModelSnapshot}
          candidates={lifeModelSources}
          selectedItemIds={selectedLifeModelItemIds}
          unavailable={lifeModelUnavailable}
          busy={lifeModelBusy || working || runtimeReconciling}
          onClose={() => setLifeModelOpen(false)}
          onReload={() => void loadLifeModel()}
          onCreate={createProposal}
          onUpdate={updateProposal}
          onApprove={approveProposal}
          onReject={rejectProposal}
          onDelete={deleteCanonicalItem}
          onWithdrawSource={withdrawCanonicalSource}
          onEnabled={changeLifeModelEnabled}
          onSelectItem={selectLifeModelItem}
        />
      )}
    </div>
  );
}
