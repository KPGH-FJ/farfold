import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type PiModel,
  type ThinkingLevel,
} from "../runtime/capabilities";
import { parsePiCommands, type PiCommandInfo } from "../runtime/commands";
import {
  hydrateTimeline,
  initialConversation,
  projectUnknownPiEvent,
  reducePiEvent,
  type ConversationState,
} from "../runtime/conversation";
import { useHostSessionDraft } from "../runtime/host-draft";
import { stopHostPiAcpRuntime } from "../runtime/host-runtime-lifecycle";
import {
  focusHostSession,
  updateHostSessionMetadata,
} from "../runtime/host-session-metadata";
import {
  acknowledgeHostRuntimeReconciliation,
  hostRuntimeReconciliationRequest,
  hostSessionCanResume,
  refreshHostNavigation,
  subscribeHostRuntimeEvents,
  subscribeHostShadowState,
  type HostShadowState,
  type HostSessionBinding,
} from "../runtime/host-shadow";
import { traceAfterPaint } from "../runtime/performance-trace";
import {
  getProjectReadiness,
  parseExtensionUiRequest,
  type ExtensionDialogRequest,
  type ProjectReadiness,
  type ProjectTrust,
} from "../runtime/pi";
import {
  PI_ACP_ADAPTER_ID,
  abortPiAcpTurn,
  appendPiAcpControlOutput,
  applyPiAcpProvider,
  intervenePiAcpTurn,
  piAcpActiveTurn,
  piAcpCleanupTargetForBinding,
  piAcpControlOutput,
  piAcpControlScope,
  piAcpNativeEvent,
  piAcpPendingDialogs,
  piAcpProviderProjection,
  piAcpStatus,
  piAcpTargetForBinding,
  readPiAcpWorkspace,
  readPiAcpWorkspaceSnapshot,
  respondPiAcpDialog,
  setPiAcpConfigOption,
  submitPiAcpTurn,
  type PiAcpControlOutput,
  type PiAcpStatus,
  type PiAcpTarget,
  type PiAcpWorkspaceSection,
} from "../runtime/pi-acp";
import type { ActiveHostTurn } from "../runtime/host-turns";
import {
  activatePiSession,
  type PiSessionActivation,
} from "../runtime/pi-session-activation";
import {
  providerTargetProjectionLabel,
  readHostProviderProjection,
  type HostProviderProjectionSnapshot,
} from "../runtime/provider-projection";
import {
  saveManagedProviderApiKey,
  type ManagedProviderConnectionSummary,
  type ManagedProviderInput,
} from "../runtime/managed-provider";
import {
  describeSessionOpening,
  sessionOpeningError,
  type SessionOpeningTarget,
} from "../runtime/session-opening";
import {
  cleanManualSessionTitle,
  cleanSessionTitle,
} from "../runtime/session-title";
import { useNativeInteractionReply } from "../runtime/use-native-interaction-reply";
import { useNativeStop } from "../runtime/use-native-stop";
import { useSessionFocus } from "../runtime/use-session-focus";
import type { RuntimePanelProps } from "../runtime/workspace-contract";
import { CommandPalette } from "./CommandPalette";
import { Composer } from "./Composer";
import { ExtensionDialog } from "./ExtensionDialog";
import { LifeModelPanel } from "./LifeModelPanel";
import { MessageContent } from "./MessageContent";
import { modelKey, ModelPicker } from "./ModelPicker";
import { PiActivity, QueueNotice } from "./PiActivity";
import { ProjectReadinessCard } from "./ProjectReadinessCard";
import { ProviderSettingsDialog } from "./ProviderSettingsDialog";
import { ManagedProviderEditor } from "./ManagedProviderEditor";
import { PiNativeAuthentication } from "./PiNativeAuthentication";
import { RuntimeChooser, type RuntimeProduct } from "./RuntimeChooser";
import { SessionContextPanel } from "./SessionContextPanel";
import { SessionOpeningPanel } from "./SessionOpeningPanel";
import { SessionStartPanel } from "./SessionStartPanel";
import type { SidebarSessionItem } from "./Sidebar";
import { WorkingCopyManagerDialog } from "./WorkingCopyManagerDialog";
import { WorkspaceError } from "./WorkspaceError";
import { WorkspaceHeader } from "./WorkspaceHeader";

const stopRuntime = stopHostPiAcpRuntime;

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

// Pi ACP Runtime panel for the unified Workspace shell. The owned Pi ACP
// connection is the only Runtime surface: sessions open/create through the
// shared Host activation, turns go through Host Turn authorities, and native
// events project only from the bound ACP envelope. The retired Pi RPC
// transport has no path here; stale pi-rpc-jsonl bindings fail closed.
export function PiPanel({
  active,
  initialProjectPath,
  requestedHostSessionId,
  requestedHostSession,
  onRequestedHostSessionHandled,
  restoredHostSession,
  onProjectPath,
  onSelectRuntime,
  themeMode,
  onThemeMode,
  onOpenUpdate,
  lifeModel,
  notice,
  shellActions,
  onShellMeta,
}: RuntimePanelProps) {
  const {
    open: lifeModelOpen,
    snapshot: lifeModelSnapshot,
    candidates: lifeModelSources,
    selectedItemIds: selectedLifeModelItemIds,
    unavailable: lifeModelUnavailable,
    busy: lifeModelBusy,
    onOpen: openLifeModel,
    onClose: closeLifeModel,
    onReload: loadLifeModel,
    onSelectItem: selectLifeModelItem,
    onCreate: createProposal,
    onUpdate: updateProposal,
    onApprove: approveProposal,
    onReject: rejectProposal,
    onDelete: deleteCanonicalItem,
    onWithdrawSource: withdrawCanonicalSource,
    onPreviewLastSource: previewCanonicalLastSource,
    onResolveLastSource: resolveCanonicalLastSource,
    onEnabled: changeLifeModelEnabled,
  } = lifeModel;
  const [sessionContextOpen, setSessionContextOpen] = useState(false);
  const [piOpeningTarget, setPiOpeningTarget] =
    useState<SessionOpeningTarget | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [workingCopyManagerOpen, setWorkingCopyManagerOpen] = useState(false);
  const [acpStatus, setAcpStatus] = useState<PiAcpStatus | null>(null);
  const acpStatusRef = useRef<PiAcpStatus | null>(null);
  const acpBindingRef = useRef<HostSessionBinding | null>(null);
  const [acpControlOutputs, setAcpControlOutputs] = useState<{
    scope: string;
    outputs: PiAcpControlOutput[];
  }>({ scope: "", outputs: [] });
  const acpEventRevision = useRef(0);
  const acpTurnRef = useRef<ActiveHostTurn | null>(null);
  const [acpTurn, setAcpTurn] = useState<ActiveHostTurn | null>(null);
  const acpTurnRead = useRef<Promise<ActiveHostTurn | null> | null>(null);
  const acpSubmission = useRef<{
    target: PiAcpTarget;
    draft: string;
    admitted: boolean;
    timelineOffset: number;
  } | null>(null);
  const acpNeedsSnapshot = useRef(false);
  const acpReconciliation =
    useRef<ReturnType<typeof hostRuntimeReconciliationRequest>>(null);
  const acpReadFlight = useRef<{ key: string; promise: Promise<void> } | null>(
    null,
  );
  const [runtimeTransition, setRuntimeTransition] = useState<
    "starting" | "stopping" | null
  >(null);
  const [runtimeReadyGeneration, setRuntimeReadyGeneration] = useState<
    number | null
  >(null);
  const [runtimeReconciling, setRuntimeReconciling] = useState(false);
  const [hostShadowState, setHostShadowState] =
    useState<HostShadowState | null>(null);
  const [projectTrust, setProjectTrust] = useState<ProjectTrust>("saved");
  const [projectReadiness, setProjectReadiness] =
    useState<ProjectReadiness | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [conversation, setConversation] =
    useState<ConversationState>(initialConversation);
  const [piState, setPiState] = useState(initialPiState);
  const [models, setModels] = useState<PiModel[]>([]);
  const [modelSelectionBusy, setModelSelectionBusy] = useState(false);
  const [modelDiscovery, setModelDiscovery] = useState<
    "idle" | "loading" | "ready"
  >("idle");
  const [commands, setCommands] = useState<PiCommandInfo[]>([]);
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [managedCreatePath, setManagedCreatePath] = useState<string | null>(
    null,
  );
  const [providerSettingsBusy, setProviderSettingsBusy] = useState(false);
  const [nativeAuthBusy, setNativeAuthBusy] = useState(false);
  const [acpProviderTab, setAcpProviderTab] = useState<"managed" | "native">(
    "managed",
  );
  const [providerProjection, setProviderProjection] =
    useState<HostProviderProjectionSnapshot | null>(null);
  const [providerProjectionReadFailed, setProviderProjectionReadFailed] =
    useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [delivery, setDelivery] = useState<"steer" | "follow_up">("steer");
  const [error, setError] = useState<string | null>(null);
  const [extensionNotice, setExtensionNotice] = useState<{
    message: string;
    type: "info" | "warning" | "error";
    source?: "acp_queue";
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
  const piHistoryRevision = useRef(0);
  const runtimeRunning = useRef(false);
  const lifecycleActionInFlight = useRef(false);
  const currentFarfoldSessionId = useRef<string | null>(null);
  const lastPiHostReconciliation = useRef<string | null>(null);
  const [projectPath, setProjectPath] = useState(initialProjectPath);

  const running = acpStatus?.running === true;
  const working =
    acpStatus !== null &&
    (acpTurn !== null || piState.isStreaming || conversation.isWorking);
  const runtimePhase = runtimeTransition ?? (running ? "running" : "stopped");
  const transitioning =
    runtimePhase === "starting" ||
    runtimePhase === "stopping" ||
    modelSelectionBusy;
  const runtimeCommandReady =
    !acpTurn?.outcomeUnknown &&
    !acpTurn?.abortRequested &&
    !runtimeReconciling &&
    running &&
    runtimeReadyGeneration === acpStatus?.generation &&
    !providerProjectionReadFailed;
  const extensionStatus = Object.values(extensionStatuses).join(" · ");
  const extensionWidgetAbove = Object.values(extensionWidgets)
    .filter((widget) => widget.placement === "aboveEditor")
    .flatMap((widget) => widget.lines);
  const extensionWidgetBelow = Object.values(extensionWidgets)
    .filter((widget) => widget.placement === "belowEditor")
    .flatMap((widget) => widget.lines);
  const piHostSessions = useMemo(
    () =>
      (hostShadowState?.navigation.sessionIndex.sessions ?? []).filter(
        (session) =>
          session.runtimeProductId === "pi" && session.archivedAt === null,
      ),
    [hostShadowState?.navigation.sessionIndex.sessions],
  );
  const activePiHostSessionKey = acpStatus
    ? (piHostSessions.find((session) =>
        piAcpTargetForBinding(acpStatus, session),
      )?.farfoldSessionId ?? null)
    : null;
  const piRequestedOpening: SessionOpeningTarget | null =
    active &&
    requestedHostSessionId &&
    (!running || requestedHostSessionId !== activePiHostSessionKey)
      ? {
          kind: "open",
          sessionId: requestedHostSessionId,
          session:
            requestedHostSession ??
            piHostSessions.find(
              (session) => session.farfoldSessionId === requestedHostSessionId,
            ) ??
            null,
        }
      : null;
  const piOpening = piOpeningTarget ?? piRequestedOpening;
  const piOpeningView = piOpening
    ? describeSessionOpening(piOpening, "pi")
    : null;
  const restoredPiSession =
    restoredHostSession?.runtimeProductId === "pi"
      ? restoredHostSession
      : null;
  const resumablePiSession =
    restoredPiSession &&
    restoredPiSession.adapterId === PI_ACP_ADAPTER_ID &&
    hostSessionCanResume(restoredPiSession)
      ? restoredPiSession
      : null;
  const stalePiSession =
    restoredPiSession && restoredPiSession.adapterId !== PI_ACP_ADAPTER_ID
      ? restoredPiSession
      : null;
  const activePiHostSession =
    piHostSessions.find(
      (session) => session.farfoldSessionId === activePiHostSessionKey,
    ) ?? resumablePiSession;

  useEffect(() => {
    currentFarfoldSessionId.current = activePiHostSessionKey;
  }, [activePiHostSessionKey]);
  const piDraftSessionId =
    activePiHostSessionKey ?? restoredPiSession?.farfoldSessionId ?? null;
  useSessionFocus(active, piDraftSessionId, requestedHostSessionId, setError);
  const { stopping, requestStop } = useNativeStop(
    activePiHostSessionKey && acpStatus
      ? `${activePiHostSessionKey}:${acpStatus.generation}`
      : null,
    working,
    setError,
  );
  const [message, setMessage] = useHostSessionDraft(
    piDraftSessionId,
    (reason) => setError(`草稿：${String(reason)}`),
  );
  const draftRef = useRef({ sessionId: piDraftSessionId, message, setMessage });
  draftRef.current = { sessionId: piDraftSessionId, message, setMessage };
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
    (firstUserMessage?.kind === "message" ? firstUserMessage.text : "") ||
      "新对话",
  );
  const conversationTitle = activePiHostSession?.title
    ? cleanManualSessionTitle(activePiHostSession.title, 34)
    : running
      ? piState.sessionName
        ? cleanManualSessionTitle(piState.sessionName, 34)
        : automaticConversationTitle
      : "新对话";
  const currentProject = acpStatus?.cwd ?? projectPath;
  const mergedModels = useMemo(() => {
    const merged = new Map<string, PiModel>();
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
  }, [models, piState.model]);
  const currentModel = piState.model
    ? (mergedModels.find(
        (model) => modelKey(model) === modelKey(piState.model!),
      ) ?? piState.model)
    : null;
  useEffect(() => {
    const providerConnectionId =
      acpStatus?.managedProvider?.providerConnectionId ??
      currentModel?.provider;
    if (!providerConnectionId) {
      setProviderProjection(null);
      setProviderProjectionReadFailed(false);
      return;
    }
    let cancelled = false;
    void readHostProviderProjection(providerConnectionId)
      .then((snapshot) => {
        if (!cancelled) {
          setProviderProjection(snapshot);
          setProviderProjectionReadFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProviderProjection(null);
          setProviderProjectionReadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    currentModel?.provider,
    currentModel?.id,
    acpStatus?.managedProvider?.providerConnectionId,
    acpStatus?.managedProvider?.providerConfigVersionId,
    acpStatus?.generation,
    acpTurn?.turnId,
  ]);
  const currentThinkingLevel = running
    ? piState.thinkingLevel
    : (currentModel?.thinkingLevels?.[0] ?? piState.thinkingLevel);
  const currentThinkingLevels = running
    ? piState.availableThinkingLevels
    : (currentModel?.thinkingLevels ?? ["off"]);
  const acpProviderProjection =
    acpStatus && activePiHostSession
      ? piAcpProviderProjection(
          acpStatus,
          activePiHostSession,
          providerProjection,
        )
      : null;
  const acpDisplayedProvider =
    acpStatus?.managedProvider ??
    (acpStatus?.lastConfirmedModelSource?.kind === "managed_version"
      ? acpStatus.lastConfirmedModelSource.binding
      : null);
  const providerStateLabel = !acpStatus
    ? "Pi ACP 未连接"
    : acpStatus.configurationState === "unknown"
      ? "配置结果未知，当前模型未确认"
      : acpStatus.configurationState === "changing" ||
          providerSettingsBusy ||
          nativeAuthBusy
        ? "正在应用配置，当前模型待确认"
        : acpStatus.nativeFirstUse?.phase === "authentication_required"
          ? "需要配置 Pi Provider 凭据"
          : acpStatus.nativeFirstUse?.phase === "model_selection_required"
            ? "请选择 Pi 原生模型"
            : acpStatus.modelSource?.kind === "native_observation"
              ? acpStatus.nativeAdmissionReady
                ? "原生模型已选择，认证由 Pi 管理"
                : "原生模型尚未确认选择"
              : acpProviderProjection
                ? providerTargetProjectionLabel(acpProviderProjection)
                : "Pi 绑定的 Provider 投影未读取";
  const canResume = Boolean(resumablePiSession);
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

  function applyAcpStatus(next: PiAcpStatus): boolean {
    const previous = acpStatusRef.current;
    if (previous && next.generation < previous.generation) return false;
    if (
      !previous ||
      previous.generation !== next.generation ||
      previous.runtimeConnectionId !== next.runtimeConnectionId
    ) {
      currentFarfoldSessionId.current = null;
      acpBindingRef.current = null;
      acpTurnRef.current = null;
      setAcpTurn(null);
      acpNeedsSnapshot.current = true;
      acpReconciliation.current = null;
      setRuntimeReconciling(false);
      piHistoryRevision.current += 1;
      setRuntimeReadyGeneration(null);
      setProviderSettingsOpen(false);
      setExtensionStatuses({});
      setExtensionWidgets({});
      setExtensionNotice(null);
    }
    acpStatusRef.current = next;
    setAcpStatus(next);
    runtimeRunning.current = next.running;
    return true;
  }

  function refreshAcpTurn(): Promise<ActiveHostTurn | null> {
    if (acpTurnRead.current) return acpTurnRead.current;
    const binding = acpBindingRef.current;
    const acp = acpStatusRef.current;
    if (!binding || !acp) return Promise.resolve(null);
    const promise = piAcpActiveTurn(binding, acp.generation).then((turn) => {
      if (
        acpBindingRef.current !== binding ||
        acpStatusRef.current?.generation !== acp.generation
      )
        return null;
      const previous = acpTurnRef.current;
      acpTurnRef.current = turn;
      setAcpTurn(turn);
      if (turn) {
        setWorkStartedAt(turn.startedAt);
        const pending = acpSubmission.current;
        if (
          pending &&
          pending.target.farfoldSessionId === turn.farfoldSessionId &&
          pending.target.runtimeGeneration === turn.runtimeGeneration &&
          pending.target.nativeSessionId === turn.nativeSessionId
        ) {
          acknowledgeAcpSubmission(pending);
        }
      }
      if (previous && !turn) {
        setPiState((current) => ({ ...current, isStreaming: false }));
        setConversation((current) => ({ ...current, isWorking: false }));
        setWorkStartedAt(null);
        acpNeedsSnapshot.current = true;
      }
      if (!turn && acpNeedsSnapshot.current && acpStatusRef.current?.running) {
        void hydratePiFromRuntime().catch((reason) => {
          acpNeedsSnapshot.current = false;
          setError(String(reason));
        });
      }
      return turn;
    });
    acpTurnRead.current = promise;
    void promise
      .finally(() => {
        if (acpTurnRead.current === promise) acpTurnRead.current = null;
      })
      .catch(() => undefined);
    return promise;
  }

  function acknowledgeAcpSubmission(
    pending: NonNullable<typeof acpSubmission.current>,
  ) {
    if (pending.admitted || acpSubmission.current !== pending) return;
    pending.admitted = true;
    if (
      acpBindingRef.current?.farfoldSessionId !==
        pending.target.farfoldSessionId ||
      acpStatusRef.current?.generation !== pending.target.runtimeGeneration
    )
      return;
    setSubmitting(false);
    const draft = draftRef.current;
    if (
      draft.sessionId === pending.target.farfoldSessionId &&
      draft.message === pending.draft
    )
      draft.setMessage("");
    setConversation((current) => ({
      ...current,
      timeline: [
        ...current.timeline.slice(0, pending.timelineOffset),
        {
          kind: "message",
          id: `local-${Date.now()}`,
          role: "user",
          text: pending.draft.trim(),
        },
        ...current.timeline.slice(pending.timelineOffset),
      ],
    }));
  }

  function hydratePiFromRuntime(runtimeReadyAt?: number): Promise<void> {
    const acp = acpStatusRef.current;
    if (!acp)
      return Promise.reject(new Error("Pi ACP 工作台缺少当前连接。"));
    const binding = acpBindingRef.current;
    const target = binding && piAcpTargetForBinding(acp, binding);
    if (!target)
      return Promise.reject(
        new Error("Pi ACP 工作台缺少当前完整会话绑定。"),
      );
    const key = `${target.farfoldSessionId}:${target.runtimeGeneration}`;
    if (acpReadFlight.current?.key === key)
      return acpReadFlight.current.promise;
    const revision = piHistoryRevision.current;
    const eventRevision = acpEventRevision.current;
    setRuntimeReadyGeneration(null);
    const promise = (async () => {
      const snapshots = await readPiAcpWorkspaceSnapshot(
        target,
        () =>
          revision === piHistoryRevision.current &&
          eventRevision === acpEventRevision.current &&
          acpStatusRef.current?.generation === target.runtimeGeneration &&
          acpBindingRef.current?.farfoldSessionId === target.farfoldSessionId,
      );
      if (!snapshots) {
        acpNeedsSnapshot.current = true;
        return;
      }
      for (const [section, value] of snapshots)
        applyPiWorkspaceData(section, value);
      setRuntimeReadyGeneration(target.runtimeGeneration);
      acpNeedsSnapshot.current = false;
      const reconciliation = acpReconciliation.current;
      if (reconciliation && !acpTurnRef.current) {
        acknowledgeHostRuntimeReconciliation(reconciliation);
        acpReconciliation.current = null;
        setRuntimeReconciling(false);
      }
      if (runtimeReadyAt !== undefined)
        traceAfterPaint("pi_resume", runtimeReadyAt);
    })();
    acpReadFlight.current = { key, promise };
    void promise
      .finally(() => {
        if (acpReadFlight.current?.promise === promise)
          acpReadFlight.current = null;
      })
      .catch(() => undefined);
    return promise;
  }

  function applyPiWorkspaceData(
    section: PiAcpWorkspaceSection,
    value: unknown,
  ) {
    const data = asRecord(value);
    if (section === "state") {
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
      setPiState((current) => ({
        ...next,
        contextPercent: current.contextPercent,
        availableThinkingLevels: current.availableThinkingLevels,
      }));
      if (next.isStreaming) {
        setWorkStartedAt((current) => current ?? Date.now());
      }
    } else if (section === "stats") {
      const context = asRecord(data?.contextUsage);
      setPiState((current) => ({
        ...current,
        contextPercent:
          typeof context?.percent === "number" ? context.percent : null,
      }));
    } else if (section === "models") {
      setModels(
        (Array.isArray(data?.models) ? data.models : []).flatMap(
          (candidate) => {
            const model = parseModel(candidate);
            return model ? [model] : [];
          },
        ),
      );
      setModelDiscovery("ready");
    } else if (section === "thinking_levels") {
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
    } else if (section === "messages") {
      setConversation((current) => ({
        ...current,
        timeline: hydrateTimeline(data?.messages),
      }));
    } else if (section === "commands") {
      const discoveredCommands = parsePiCommands(data?.commands);
      setCommands(
        discoveredCommands.filter(
          (command) => !command.name.startsWith("farfold-lifemodel-"),
        ),
      );
    }
  }

  function queuePiHostReconciliation(state: HostShadowState): Promise<void> {
    const binding = acpBindingRef.current;
    const request =
      binding &&
      hostRuntimeReconciliationRequest(state, binding.installationId);
    if (
      !request ||
      request.key === lastPiHostReconciliation.current ||
      request.runtimeGeneration !== acpStatusRef.current?.generation
    )
      return Promise.resolve();
    lastPiHostReconciliation.current = request.key;
    acpReconciliation.current = request;
    acpEventRevision.current += 1;
    acpNeedsSnapshot.current = true;
    setRuntimeReconciling(true);
    setRuntimeReadyGeneration(null);
    return refreshAcpTurn().then(() => undefined);
  }

  useEffect(
    () =>
      subscribeHostShadowState((state) => {
        void queuePiHostReconciliation(state);
        setHostShadowState(state);
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const bootstrapRevision = piHistoryRevision.current;
    void (async () => {
      const acp = await piAcpStatus();
      if (cancelled || bootstrapRevision !== piHistoryRevision.current) return;
      if (acp.running || acp.runtime) {
        const navigation = await refreshHostNavigation();
        if (cancelled || bootstrapRevision !== piHistoryRevision.current)
          return;
        const binding = navigation.sessionIndex.sessions.find((session) =>
          piAcpCleanupTargetForBinding(acp, session),
        );
        if (!binding)
          throw new Error(
            "Pi ACP 当前进程未匹配到 Host 会话，未加载其他历史。",
          );
        applyAcpStatus(acp);
        acpBindingRef.current = binding;
        currentFarfoldSessionId.current = binding.farfoldSessionId;
        setProjectPath(binding.workingCopyPath);
        onProjectPath(binding.workingCopyPath);
        if (acp.running) await hydratePiFromRuntime();
        else
          setError(acp.lastError ?? "Pi ACP 原进程已退出，连接尚待显式清理。");
      }
    })().catch((reason) => setError(String(reason)));

    function handlePiPayload(payload: unknown) {
      const extensionRequest = parseExtensionUiRequest(payload);
      if (extensionRequest) {
        if (extensionRequest.method === "notify") {
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
                placement: extensionRequest.widgetPlacement ?? "aboveEditor",
              };
            } else {
              delete next[key];
            }
            return next;
          });
        } else if (extensionRequest.method === "setTitle") {
          document.title = extensionRequest.title || "Farfold";
        } else if (extensionRequest.method === "set_editor_text") {
          draftRef.current.setMessage(extensionRequest.text ?? "");
        }
      }
      const type = asRecord(payload)?.type;
      if (type === "agent_start") setWorkStartedAt(Date.now());
      if (type === "agent_settled") {
        setWorkStartedAt(null);
        setPiState((current) => ({ ...current, isStreaming: false }));
      }
      const fallback = projectUnknownPiEvent(payload);
      setConversation((current) => {
        const next = reducePiEvent(current, payload);
        return fallback ? { ...next, notice: fallback.notice } : next;
      });
    }

    const stopRuntimeEvents = subscribeHostRuntimeEvents((routed) => {
      const acp = acpStatusRef.current;
      const binding = acpBindingRef.current;
      if (!acp || !binding) return;
      const output = piAcpControlOutput(routed, binding, acp.generation);
      if (output) {
        const scope = piAcpControlScope(binding, acp.generation);
        setAcpControlOutputs((current) => ({
          scope,
          outputs: appendPiAcpControlOutput(
            current.scope === scope ? current.outputs : [],
            output,
          ),
        }));
      }
      const payload = piAcpNativeEvent(routed, binding, acp.generation);
      if (payload) {
        acpEventRevision.current += 1;
        if (payload.type === "agent_settled") acpNeedsSnapshot.current = true;
        handlePiPayload(payload);
        if (payload.type === "message_update")
          traceAfterPaint("pi_event_paint", routed.receivedAtMs);
      }
    });

    let acpPolling = false;
    const acpInterval = window.setInterval(() => {
      const previous = acpStatusRef.current;
      if (!previous || !acpBindingRef.current || acpPolling) return;
      acpPolling = true;
      void (async () => {
        await refreshAcpTurn();
        const next = await piAcpStatus();
        if (
          !cancelled &&
          acpStatusRef.current === previous &&
          next.generation === previous.generation &&
          next.runtimeConnectionId === previous.runtimeConnectionId
        ) {
          applyAcpStatus(next);
          if (next.lastError) setError(next.lastError);
        }
      })()
        .catch((reason) => {
          if (!cancelled) setError(String(reason));
        })
        .finally(() => {
          acpPolling = false;
        });
    }, 500);
    return () => {
      cancelled = true;
      stopRuntimeEvents();
      window.clearInterval(acpInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  useEffect(() => {
    if (!active || !requestedHostSessionId || !hostShadowState) {
      return;
    }
    const target = hostShadowState.navigation.sessionIndex.sessions.find(
      (session) =>
        session.farfoldSessionId === requestedHostSessionId &&
        session.runtimeProductId === "pi" &&
        session.archivedAt === null,
    );
    if (!target) return;
    onRequestedHostSessionHandled(target.farfoldSessionId);
    void openHostPiSession(target.farfoldSessionId);
  }, [active, requestedHostSessionId, hostShadowState]);

  async function activatePi(
    target: PiSessionActivation,
    trust = projectTrust,
    beforeStart?: () => Promise<void>,
    managedProvider?: {
      providerConnectionId: string;
      providerConfigVersionId: string;
    },
    nativeFirstUse = false,
  ): Promise<void> {
    const openingTarget: SessionOpeningTarget =
      target.kind === "create"
        ? { kind: "create", projectPath: target.workingCopyPath }
        : {
            kind: "open",
            sessionId: target.farfoldSessionId,
            session:
              piHostSessions.find(
                (session) =>
                  session.farfoldSessionId === target.farfoldSessionId,
              ) ?? null,
          };
    setPiOpeningTarget(openingTarget);
    try {
      if (providerSettingsBusy || nativeAuthBusy)
        throw new Error("Pi 认证或 Provider 操作尚未结束，未切换连接。");
      const runningAcp = acpStatusRef.current;
      const runningAcpTarget =
        runningAcp?.running && acpBindingRef.current
          ? piAcpTargetForBinding(runningAcp, acpBindingRef.current)
          : null;
      if (runningAcp?.running && !runningAcpTarget)
        throw new Error("Pi ACP 缺少精确停止目标，未改变当前连接。");
      await activatePiSession(target, {
        projectTrust: trust,
        running: runtimeRunning.current,
        phase: setRuntimeTransition,
        applyStatus: () => false,
        applyAcpStatus,
        adapterId: PI_ACP_ADAPTER_ID,
        ...(managedProvider ? { managedProvider } : {}),
        ...(nativeFirstUse ? { nativeFirstUse: true } : {}),
        ...(runningAcpTarget ? { runningAcpTarget } : {}),
        beforeStart,
        applyOpened: async (opened, verifiedProjectPath) => {
          const binding = opened.navigation.sessionIndex.sessions.find(
            (session) => session.farfoldSessionId === opened.farfoldSessionId,
          );
          if (
            !binding ||
            !acpStatusRef.current ||
            !piAcpTargetForBinding(acpStatusRef.current, binding)
          ) {
            throw new Error("Pi ACP 工作台绑定已失效，未加载历史。");
          }
          acpBindingRef.current = binding;
          currentFarfoldSessionId.current = opened.farfoldSessionId;
          piHistoryRevision.current += 1;
          setRuntimeReadyGeneration(null);
          setProjectPath(verifiedProjectPath);
          onProjectPath(verifiedProjectPath);
          setConversation(initialConversation);
          setPiState(initialPiState);
          setModels([]);
          setCommands([]);
          setModelDiscovery("loading");
          await hydratePiFromRuntime(opened.runtimeReadyAt);
        },
      });
    } catch (reason) {
      throw new Error(sessionOpeningError(openingTarget, "pi", reason));
    } finally {
      setPiOpeningTarget(null);
    }
  }

  async function chooseProject(switchRunning = false) {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 Farfold Project",
    });
    if (typeof selected !== "string") return;
    if (!switchRunning || !runtimeRunning.current) {
      setProjectPath(selected);
      onProjectPath(selected);
      return;
    }
    try {
      await createPiSessionInWorktree(selected);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function start(): Promise<void> {
    if (
      working ||
      submitting ||
      transitioning ||
      lifecycleActionInFlight.current
    )
      return;
    if (!projectPath) {
      setError("请先选择 Farfold Project。");
      return;
    }
    setManagedCreatePath(projectPath);
    setProviderSettingsOpen(true);
  }

  async function createPiSessionInWorktree(
    workingCopyPath: string,
  ): Promise<void> {
    if (working || transitioning || lifecycleActionInFlight.current) {
      throw new Error("当前 Pi Session 正忙，不能切换 Working Copy。");
    }
    setManagedCreatePath(workingCopyPath);
    setProviderSettingsOpen(true);
  }

  async function saveAcpManagedProvider(input: ManagedProviderInput) {
    if (working || submitting || transitioning || providerSettingsBusy)
      throw new Error("当前 Pi 操作结束后才能保存连接。");
    setProviderSettingsBusy(true);
    try {
      const saved = await saveManagedProviderApiKey(input);
      if (
        saved.providerConnectionId ===
        acpStatusRef.current?.managedProvider?.providerConnectionId
      )
        setProviderProjection(saved.projectionSnapshot);
    } finally {
      setProviderSettingsBusy(false);
    }
  }

  async function applyAcpManagedProvider(
    connection: ManagedProviderConnectionSummary,
  ) {
    if (
      working ||
      submitting ||
      transitioning ||
      runtimeReconciling ||
      lifecycleActionInFlight.current
    )
      throw new Error("Pi 当前操作未结束，不能应用 Provider。");
    const acp = acpStatusRef.current;
    const binding = acpBindingRef.current;
    const target = acp && binding && piAcpTargetForBinding(acp, binding);
    if (!target || !connection.currentConfigVersionId)
      throw new Error("Pi 原会话或已保存的 Provider 版本不可用。");
    lifecycleActionInFlight.current = true;
    setProviderSettingsBusy(true);
    setError(null);
    try {
      const next = await applyPiAcpProvider({
        ...target,
        provider: {
          providerConnectionId: connection.providerConnectionId,
          providerConfigVersionId: connection.currentConfigVersionId,
        },
      });
      const currentBinding = acpBindingRef.current;
      if (
        !currentBinding ||
        currentBinding.farfoldSessionId !== target.farfoldSessionId ||
        !piAcpTargetForBinding(next, currentBinding) ||
        next.generation !== target.runtimeGeneration
      )
        throw new Error("Pi Provider 回执不属于当前原会话，未更新显示。");
      applyAcpStatus(next);
      await hydratePiFromRuntime();
      setProviderSettingsOpen(false);
    } catch (reason) {
      const current = await piAcpStatus().catch(() => null);
      const currentBinding = acpBindingRef.current;
      if (
        currentBinding &&
        currentBinding.farfoldSessionId === target.farfoldSessionId
      ) {
        if (
          current &&
          current.generation === target.runtimeGeneration &&
          piAcpCleanupTargetForBinding(current, currentBinding)
        )
          applyAcpStatus(current);
        setError(String(reason));
      }
      throw reason;
    } finally {
      setProviderSettingsBusy(false);
      lifecycleActionInFlight.current = false;
    }
  }

  async function createAcpManagedSession(
    connection: ManagedProviderConnectionSummary,
  ) {
    if (
      working ||
      submitting ||
      transitioning ||
      runtimeReconciling ||
      lifecycleActionInFlight.current
    )
      throw new Error("Pi 当前工作尚未结束，未新建会话。");
    const workingCopyPath = managedCreatePath ?? currentProject;
    if (!workingCopyPath || !connection.currentConfigVersionId)
      throw new Error(
        "缺少 Project 或已保存的 Provider 版本，未改变当前连接。",
      );
    lifecycleActionInFlight.current = true;
    setError(null);
    try {
      await activatePi(
        { kind: "create", workingCopyPath, replaceRunning: true },
        projectTrust,
        undefined,
        {
          providerConnectionId: connection.providerConnectionId,
          providerConfigVersionId: connection.currentConfigVersionId,
        },
      );
      setManagedCreatePath(null);
      setProviderSettingsOpen(false);
    } catch (reason) {
      setError(String(reason));
      throw reason;
    } finally {
      setRuntimeTransition(null);
      lifecycleActionInFlight.current = false;
    }
  }

  async function createAcpNativeFirstUseSession() {
    if (
      working ||
      submitting ||
      transitioning ||
      runtimeReconciling ||
      lifecycleActionInFlight.current
    )
      throw new Error("Pi 当前工作尚未结束，未启动原生 Provider 首次配置。");
    const workingCopyPath = managedCreatePath ?? currentProject;
    if (!workingCopyPath) throw new Error("缺少 Project，未改变当前连接。");
    lifecycleActionInFlight.current = true;
    setError(null);
    try {
      setAcpProviderTab("native");
      await activatePi(
        { kind: "create", workingCopyPath, replaceRunning: true },
        projectTrust,
        undefined,
        undefined,
        true,
      );
      setManagedCreatePath(null);
      setProviderSettingsOpen(true);
    } catch (reason) {
      setError(String(reason));
      throw reason;
    } finally {
      setRuntimeTransition(null);
      lifecycleActionInFlight.current = false;
    }
  }

  async function changeProjectTrust(nextTrust: ProjectTrust): Promise<void> {
    if (nextTrust === projectTrust) return;
    if (!running || working || !currentProject) {
      setProjectTrust(nextTrust);
      return;
    }
    if (transitioning || lifecycleActionInFlight.current) return;
    lifecycleActionInFlight.current = true;
    setProjectTrust(nextTrust);

    setError(null);
    setRuntimeTransition("stopping");
    try {
      const farfoldSessionId = activePiHostSession?.farfoldSessionId;
      if (!farfoldSessionId) {
        throw new Error(
          "当前 Pi Session 尚未取得 Host 绑定，不能安全地用新 Project trust 重启。",
        );
      }
      await activatePi({ kind: "open", farfoldSessionId }, nextTrust);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRuntimeTransition(null);
      lifecycleActionInFlight.current = false;
    }
  }

  async function togglePiSessionPinned(
    session: SidebarSessionItem,
  ): Promise<void> {
    if (working || submitting || transitioning || runtimeReconciling) return;
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

  async function archivePiSession(session: SidebarSessionItem): Promise<void> {
    if (working || submitting || transitioning || runtimeReconciling) return;
    lifecycleActionInFlight.current = true;
    setError(null);
    try {
      if (running && session.key === activePiHostSessionKey) {
        setRuntimeTransition("stopping");
        const acp = acpStatusRef.current;
        const target =
          acp &&
          acpBindingRef.current &&
          piAcpTargetForBinding(acp, acpBindingRef.current);
        if (!target) throw new Error("Pi ACP 停止目标不可用。");
        applyAcpStatus(await stopRuntime(target));
      }
      await updateHostSessionMetadata({
        farfoldSessionId: session.key,
        archived: true,
      });
      if (session.key === activePiHostSessionKey) {
        setConversation(initialConversation);
        setPiState(initialPiState);
        setModels([]);
        setCommands([]);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRuntimeTransition(null);
      lifecycleActionInFlight.current = false;
    }
  }

  async function restoreArchivedSession(
    session: SidebarSessionItem,
  ): Promise<void> {
    if (working || submitting || transitioning || runtimeReconciling) return;
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

  async function send() {
    const text = message.trim();
    if (!text || piOpeningView || !runtimeCommandReady || submitting) return;
    await sendAcpMessage(message);
  }

  async function sendAcpMessage(draft: string) {
    const acp = acpStatusRef.current;
    const binding = acpBindingRef.current;
    const target = acp && binding && piAcpTargetForBinding(acp, binding);
    if (!target) {
      setError("Pi ACP 当前完整会话绑定不可用。");
      return;
    }
    const isCurrent = () =>
      acpBindingRef.current?.farfoldSessionId === target.farfoldSessionId &&
      acpStatusRef.current?.generation === target.runtimeGeneration;
    setError(null);
    setSubmitting(true);
    let pending: typeof acpSubmission.current = null;
    try {
      const turn = await refreshAcpTurn();
      if (!isCurrent()) return;
      if (acpReadFlight.current) await acpReadFlight.current.promise;
      if (!isCurrent()) return;
      if (draft.trim() === "/session") {
        // Adapter control output is a bound read, not an Agent/Provider turn.
        await readPiAcpWorkspace({ ...target, section: "session_command" });
        if (
          isCurrent() &&
          draftRef.current.sessionId === target.farfoldSessionId &&
          draftRef.current.message === draft
        )
          draftRef.current.setMessage("");
        return;
      }
      if (turn) {
        if (turn.outcomeUnknown || turn.abortRequested)
          throw new Error("Pi 当前任务尚未确认终态，不能追加消息。");
        const result = await intervenePiAcpTurn({
          ...target,
          turnId: turn.turnId,
          kind: delivery,
          message: draft.trim(),
        });
        if (!isCurrent()) return;
        if (result.outcome === "unknown") throw new Error(result.detail);
        if (
          draftRef.current.sessionId === target.farfoldSessionId &&
          draftRef.current.message === draft
        )
          draftRef.current.setMessage("");
        setExtensionNotice({
          type: "info",
          source: "acp_queue",
          message:
            result.delivery === "steer"
              ? "Pi 已接收插话并加入原生队列，尚不代表已执行。"
              : "Pi 已接收 follow-up 并加入原生队列，尚不代表已执行。",
        });
      } else {
        if (acpSubmission.current || working)
          throw new Error("Pi 任务状态正在确认，未重复提交。");
        if (lifeModelSnapshot?.enabled && selectedLifeModelItemIds.length)
          throw new Error("Pi ACP 尚未接入 LifeModel 注入；本条消息未发送。");
        pending = {
          target,
          draft,
          admitted: false,
          timelineOffset: conversation.timeline.length,
        };
        acpSubmission.current = pending;
        acpEventRevision.current += 1;
        const result = await submitPiAcpTurn({ ...target, text: draft.trim() });
        if (!isCurrent()) return;
        if (result.outcome !== "unknown") acknowledgeAcpSubmission(pending);
        if (result.outcome === "cancelled")
          setExtensionNotice({ type: "info", message: result.detail });
        else if (result.outcome !== "accepted") setError(result.detail);
        else
          setExtensionNotice((current) =>
            current?.source === "acp_queue" ? null : current,
          );
        acpNeedsSnapshot.current = result.outcome !== "unknown";
      }
    } catch (reason) {
      if (isCurrent()) setError(String(reason));
    } finally {
      if (pending && acpSubmission.current === pending)
        acpSubmission.current = null;
      if (isCurrent()) {
        setSubmitting(false);
        void refreshAcpTurn().catch((reason) => setError(String(reason)));
      }
    }
  }

  async function abort() {
    setError(null);
    if (conversation.manualCompaction) {
      setError("固定 Pi 0.84.3 不支持停止手动压缩；本次未取消。");
      return;
    }
    await requestStop(async () => {
      const turn = await refreshAcpTurn();
      if (!turn) throw new Error("Pi ACP 没有可停止的当前 Host 任务。");
      const acknowledged = await abortPiAcpTurn({
        farfoldSessionId: turn.farfoldSessionId,
        nativeSessionId: turn.nativeSessionId,
        runtimeGeneration: turn.runtimeGeneration,
        turnId: turn.turnId,
      });
      if (!acknowledged)
        throw new Error("Pi ACP 停止未获确认，任务占用仍保留。");
    });
  }

  async function disconnectAcpForRecovery() {
    const binding = acpBindingRef.current;
    const acp = acpStatusRef.current;
    if (!binding || !acp || lifecycleActionInFlight.current) return;
    lifecycleActionInFlight.current = true;
    setRuntimeTransition("stopping");
    setError(null);
    try {
      const turn = await refreshAcpTurn();
      const target = turn
        ? {
            farfoldSessionId: turn.farfoldSessionId,
            nativeSessionId: turn.nativeSessionId,
            runtimeGeneration: turn.runtimeGeneration,
            turnId: turn.turnId,
          }
        : piAcpCleanupTargetForBinding(acp, binding);
      if (!target) throw new Error("Pi ACP 缺少精确恢复目标，未改变连接。");
      const stopped = await stopRuntime(target);
      if (stopped.running) throw new Error("Pi ACP 退出未确认，仍保留占用。");
      if (
        acpBindingRef.current === binding &&
        acpStatusRef.current?.generation === acp.generation
      ) {
        applyAcpStatus(stopped);
        setPiState((current) => ({ ...current, isStreaming: false }));
        setConversation((current) => ({ ...current, isWorking: false }));
        setRuntimeReadyGeneration(null);
        await refreshAcpTurn();
        if (stopped.lastError) setError(stopped.lastError);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRuntimeTransition(null);
      lifecycleActionInFlight.current = false;
    }
  }

  async function newSession() {
    if (transitioning || working) return;
    await start();
  }

  async function openHostPiSession(farfoldSessionId: string) {
    if (farfoldSessionId === activePiHostSessionKey) {
      try {
        await focusHostSession(farfoldSessionId);
      } catch (reason) {
        setError(String(reason));
      }
      return;
    }
    if (working || transitioning || lifecycleActionInFlight.current) return;
    const target = piHostSessions.find(
      (session) => session.farfoldSessionId === farfoldSessionId,
    );
    if (target && target.adapterId !== PI_ACP_ADAPTER_ID) {
      setError(
        "这个 Pi Session 绑定在已移除的旧连接上，不能继续。请启动新的 ACP Session。",
      );
      return;
    }
    lifecycleActionInFlight.current = true;
    setError(null);
    try {
      await activatePi({ kind: "open", farfoldSessionId });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRuntimeTransition(null);
      lifecycleActionInFlight.current = false;
    }
  }

  async function selectModel(model: PiModel) {
    if (
      working ||
      submitting ||
      transitioning ||
      runtimeReconciling ||
      lifecycleActionInFlight.current
    )
      throw new Error("当前操作结束后才能切换 Pi 模型。");
    lifecycleActionInFlight.current = true;
    setModelSelectionBusy(true);
    setError(null);
    try {
      const acp = acpStatusRef.current;
      const binding = acpBindingRef.current;
      const target = acp && binding && piAcpTargetForBinding(acp, binding);
      if (!target) throw new Error("Pi ACP 当前会话绑定不可用。");
      const next = await setPiAcpConfigOption({
        ...target,
        configId: "model",
        value: `${model.provider}/${model.id}`,
      });
      if (piAcpTargetForBinding(next, binding!)) {
        applyAcpStatus(next);
        await hydratePiFromRuntime();
      }
    } catch (reason) {
      setError(String(reason));
      throw reason;
    } finally {
      setModelSelectionBusy(false);
      setRuntimeTransition(null);
      lifecycleActionInFlight.current = false;
    }
  }

  async function selectThinkingLevel(level: ThinkingLevel) {
    if (working || submitting || transitioning || runtimeReconciling)
      throw new Error("当前操作结束后才能调整 Pi 思考级别。");
    setError(null);
    setModelSelectionBusy(true);
    try {
      const acp = acpStatusRef.current;
      const binding = acpBindingRef.current;
      const target = acp && binding && piAcpTargetForBinding(acp, binding);
      if (!target) throw new Error("Pi ACP 当前会话绑定不可用。");
      const next = await setPiAcpConfigOption({
        ...target,
        configId: "thought_level",
        value: level,
      });
      if (piAcpTargetForBinding(next, binding!)) {
        applyAcpStatus(next);
        await hydratePiFromRuntime();
      }
    } catch (reason) {
      setError(String(reason));
      throw reason;
    } finally {
      setModelSelectionBusy(false);
    }
  }

  const acpDialog =
    acpStatus && activePiHostSession
      ? piAcpPendingDialogs(
          acpStatus,
          activePiHostSession,
          hostShadowState?.pendingInteractions ?? [],
        )[0]
      : undefined;
  const nativeDialog = parseExtensionUiRequest(acpDialog?.piAcp?.nativeEvent);
  const displayedDialog =
    nativeDialog &&
    (nativeDialog.method === "select" ||
      nativeDialog.method === "confirm" ||
      nativeDialog.method === "input" ||
      nativeDialog.method === "editor")
      ? (nativeDialog as ExtensionDialogRequest)
      : undefined;
  const extensionReply = useNativeInteractionReply(
    displayedDialog && activePiHostSessionKey && !runtimeReconciling
      ? `${activePiHostSessionKey}:${acpStatus?.generation ?? 0}:${acpDialog?.piAcp?.requestKey ?? displayedDialog.id}`
      : null,
  );

  function answerExtensionDialog(response: {
    value?: string;
    confirmed?: boolean;
    cancelled?: boolean;
  }) {
    const request = displayedDialog;
    if (!request || runtimeReconciling) return;
    const acp = acpStatusRef.current;
    const binding = acpBindingRef.current;
    const target = acp && binding && piAcpTargetForBinding(acp, binding);
    const dialog = acpDialog?.piAcp;
    if (!target || !dialog || dialog.nativeRequestId !== request.id) return;
    void extensionReply.respond(
      () =>
        respondPiAcpDialog({
          ...target,
          requestId: dialog.requestKey,
          nativeRequestId: dialog.nativeRequestId,
          answer: response.cancelled
            ? { kind: "cancel" }
            : typeof response.confirmed === "boolean"
              ? { kind: "confirm", confirmed: response.confirmed }
              : { kind: "text", value: response.value ?? "" },
        }),
      () => undefined,
      setError,
    );
  }

  function expireExtensionDialog(requestId: string) {
    const acp = acpStatusRef.current;
    const binding = acpBindingRef.current;
    const target = acp && binding && piAcpTargetForBinding(acp, binding);
    if (target && acpDialog?.piAcp?.nativeRequestId === requestId)
      void readPiAcpWorkspace({ ...target, section: "state" }).catch(
        (reason) => setError(String(reason)),
      );
  }

  async function selectRuntime(runtime: RuntimeProduct): Promise<void> {
    if (
      (runtime === "pi" && active) ||
      submitting ||
      transitioning ||
      lifecycleActionInFlight.current
    ) {
      return;
    }
    setError(null);
    lifecycleActionInFlight.current = true;
    try {
      onSelectRuntime(runtime);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRuntimeTransition(null);
      lifecycleActionInFlight.current = false;
    }
  }

  const shellBusy =
    Boolean(piOpeningView) ||
    working ||
    submitting ||
    transitioning ||
    runtimeReconciling;
  useEffect(() => {
    onShellMeta({
      activeSessionKey: piOpeningView
        ? piOpeningView.sessionId
        : (activePiHostSessionKey ?? restoredPiSession?.farfoldSessionId ?? null),
      openingSessionKey: piOpeningView?.sessionId ?? null,
      busy: shellBusy,
      working,
      providerCount: acpStatus?.managedProvider ? 1 : 0,
      settingsTitle: "Pi Provider",
      settingsSubtitle: providerStateLabel,
      contextOpen: sessionContextOpen,
    });
  }, [
    onShellMeta,
    shellBusy,
    working,
    piOpeningView?.sessionId,
    activePiHostSessionKey,
    restoredPiSession?.farfoldSessionId,
    acpStatus?.managedProvider,
    providerStateLabel,
    sessionContextOpen,
  ]);
  useEffect(() => {
    const actions = shellActions.current;
    actions.newSession = () => void newSession();
    actions.openConnections = () => {
      if (acpStatusRef.current) setProviderSettingsOpen(true);
      else void start();
    };
    actions.togglePinned = (session) => void togglePiSessionPinned(session);
    actions.archive = archivePiSession;
    actions.restore = restoreArchivedSession;
  });
  useEffect(() => {
    const actions = shellActions.current;
    return () => {
      actions.newSession = undefined;
      actions.openConnections = undefined;
      actions.togglePinned = undefined;
      actions.archive = undefined;
      actions.restore = undefined;
    };
  }, [shellActions]);

  if (!active) return null;

  return (
    <>
      <main className="workspace">
        <WorkspaceHeader
          session={{
            sessionId: piOpeningView
              ? (piOpeningView.sessionId ?? undefined)
              : activePiHostSession?.farfoldSessionId,
            title:
              piOpeningView?.title ??
              activePiHostSession?.title ??
              conversationTitle,
            displayTitle: piOpeningView?.title ?? conversationTitle,
            disabled:
              Boolean(piOpeningView) ||
              working ||
              submitting ||
              transitioning ||
              runtimeReconciling,
            onError: setError,
          }}
          modelControls={
            piOpeningView ? (
              <span className="runtime-model-empty">正在读取会话模型</span>
            ) : (
              <ModelPicker
                current={currentModel}
                thinkingLevel={currentThinkingLevel}
                availableThinkingLevels={currentThinkingLevels}
                models={mergedModels}
                loadedModels={models}
                providers={[]}
                settings={null}
                running={running}
                working={working || transitioning || runtimeReconciling}
                refreshing={false}
                onSelect={selectModel}
                onThinkingLevel={selectThinkingLevel}
                onConfigureProvider={() => {
                  setProviderSettingsOpen(true);
                }}
                onRefresh={() => void hydratePiFromRuntime()}
              />
            )
          }
          runtimeControls={
            <RuntimeChooser
              value="pi"
              running={running}
              providerStatus={providerStateLabel}
              lifeModelEnabled={lifeModelSnapshot?.enabled ?? false}
              disabled={
                Boolean(piOpeningView) ||
                submitting ||
                transitioning ||
                runtimeReconciling
              }
              onChange={(runtime) => void selectRuntime(runtime)}
            />
          }
          lifeModelCount={lifeModelSnapshot?.items.length ?? 0}
          onOpenLifeModel={openLifeModel}
          projectPath={
            piOpeningView ? piOpeningView.projectPath : currentProject
          }
          projectLabel={projectName(
            piOpeningView ? piOpeningView.projectPath : currentProject,
          )}
          onChooseProject={() => void chooseProject(true)}
          projectLocked={
            Boolean(piOpeningView) ||
            working ||
            submitting ||
            transitioning ||
            runtimeReconciling
          }
          runtimeStatus={
            piOpeningView
              ? runtimePhase === "stopping"
                ? "Pi 正在停止"
                : `Pi ${piOpeningView.action}`
              : stopping
                ? "Pi 停止中"
                : runtimeReconciling
                  ? "Pi 正在重建状态"
                  : working
                    ? `Pi 正在工作 · ${elapsedLabel(workStartedAt, now)}`
                    : runtimePhase === "starting"
                      ? "Pi 正在启动"
                      : runtimePhase === "stopping"
                        ? "Pi 正在停止"
                        : running
                          ? runtimeCommandReady
                            ? "Pi 已启动"
                            : "Pi 正在连接"
                          : "Pi 未启动"
          }
          working={working}
          contextOpen={sessionContextOpen}
          onToggleContext={() =>
            setSessionContextOpen((current) => !current)
          }
          onOpenCommands={() => setCommandPaletteOpen(true)}
          extensionStatus={piOpeningView ? "" : extensionStatus}
        />

        {running && !piOpeningView && (
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
                  void changeProjectTrust(
                    event.target.value as ProjectTrust,
                  )
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
          {piOpeningView ? (
            <SessionOpeningPanel opening={piOpeningView} />
          ) : !running ? (
            <SessionStartPanel
              title={
                canResume
                  ? "继续最近的对话"
                  : stalePiSession
                    ? "上次会话绑定在已移除的连接上"
                    : "开始一段新对话"
              }
              description={
                stalePiSession
                  ? "这个 Pi Session 属于已移除的旧连接；请启动一个新的 ACP Session。"
                  : "选择项目文件夹，使用 Pi 开始工作。"
              }
              connection={
                <button
                  className="connection-entry"
                  data-provider-settings-trigger
                  onClick={() => void start()}
                  disabled={transitioning}
                >
                  <span className="connection-entry-mark">P</span>
                  <span>
                    <small>Provider</small>
                    <strong>连接模型服务</strong>
                  </span>
                  <em>{providerStateLabel}</em>
                </button>
              }
              projectPath={projectPath}
              chooseProject={() => void chooseProject(false)}
              busy={transitioning}
              unavailable={false}
              resume={
                resumablePiSession
                  ? () =>
                      void openHostPiSession(
                        resumablePiSession.farfoldSessionId,
                      )
                  : undefined
              }
              create={() => void start()}
              primaryLabel={
                runtimePhase === "starting"
                  ? "正在启动…"
                  : canResume
                    ? "继续对话"
                    : "启动 Pi"
              }
            >
              <ProjectReadinessCard
                projectPath={projectPath}
                readiness={projectReadiness}
                loading={readinessLoading}
                trust={projectTrust}
                providerState={providerStateLabel}
                disabled={transitioning}
                onTrust={(value) => void changeProjectTrust(value)}
              />
            </SessionStartPanel>
          ) : conversation.timeline.length === 0 ? (
            <div className="empty-conversation">
              <span className="brand-letter">F</span>
              <h2>
                {runtimeCommandReady ? "现在想完成什么？" : "正在恢复对话…"}
              </h2>
              <p>
                {runtimeCommandReady
                  ? "直接描述目标，Farfold 会把任务交给当前 Pi Session。"
                  : "正在读取 Pi 原生历史与状态。"}
              </p>
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
                          session={
                            activePiHostSession &&
                            piState.sessionId ===
                              activePiHostSession.nativeSessionId
                              ? activePiHostSession
                              : null
                          }
                          text={
                            item.text || (item.pending ? "正在思考…" : "")
                          }
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
          {running &&
            acpStatus &&
            activePiHostSession &&
            acpControlOutputs.scope ===
              piAcpControlScope(
                activePiHostSession,
                acpStatus.generation,
              ) &&
            acpControlOutputs.outputs.map((output) => (
              <article
                className="message assistant"
                key={`acp-control-${output.id}`}
              >
                <div>
                  <p className="message-label">
                    Pi Adapter 控制输出 · 仅本次连接，非原生历史
                  </p>
                  <pre className="message-text">{output.text}</pre>
                </div>
              </article>
            ))}
          {running && modelDiscovery === "ready" && models.length === 0 && (
            <div className="inline-warning">
              <span>Pi 未返回可用模型。请检查 Provider 凭据后重试。</span>
              <button
                data-provider-settings-trigger
                onClick={() => {
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
          {acpStatus?.runtime &&
            (acpTurn?.outcomeUnknown || acpStatus.lastError) && (
              <div className="inline-warning" role="alert">
                <span>
                  {acpTurn?.outcomeUnknown
                    ? "Pi 本轮结果未确认，工作区占用仍保留。"
                    : "Pi 连接或配置异常，原生会话与草稿保留。"}
                </span>
                <button
                  onClick={() => void disconnectAcpForRecovery()}
                  disabled={transitioning}
                  title="终止当前 Pi 连接并核验恢复，不重发任务"
                  aria-label="断开 Pi 并核验恢复"
                >
                  ⏻
                </button>
              </div>
            )}
          {notice && (
            <WorkspaceError
              message={notice.message}
              onClose={notice.onClose}
            />
          )}
          {error && (
            <WorkspaceError
              message={error}
              onClose={() => setError(null)}
            />
          )}

          {extensionNotice && (
            <div
              className={`extension-notice ${extensionNotice.type}`}
              role={extensionNotice.type === "error" ? "alert" : "status"}
            >
              <span>{extensionNotice.message}</span>
              <div className="notice-actions">
                <button
                  onClick={() => {
                    setExtensionNotice(null);
                  }}
                  aria-label="关闭通知"
                >
                  ✕
                </button>
              </div>
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
          runtimeLabel="Pi"
          supportsSteering={true}
          supportsFollowUp={true}
          steeringHint="当前工具完成后应用"
          stopping={stopping}
          stopUnavailableReason={
            acpStatus && conversation.manualCompaction
              ? "固定 Pi 0.84.3 不支持停止手动压缩；请等待原生结果。"
              : undefined
          }
          running={
            !piOpeningView &&
            running &&
            !transitioning &&
            !runtimeReconciling
          }
          ready={
            !piOpeningView &&
            runtimeCommandReady &&
            (!acpStatus ||
              (acpStatus.configurationState === "confirmed" &&
                (acpStatus.modelSource?.kind === "managed_version" ||
                  acpStatus.nativeAdmissionReady) &&
                !providerSettingsBusy &&
                !nativeAuthBusy))
          }
          working={working}
          submitting={submitting}
          message={piOpeningView ? "" : message}
          delivery={delivery}
          projectName={projectName(
            piOpeningView ? piOpeningView.projectPath : currentProject,
          )}
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
          onRemoveLifeModelItem={(itemId) =>
            selectLifeModelItem(itemId, false)
          }
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
      {sessionContextOpen && !piOpeningView && (
        <SessionContextPanel
          session={activePiHostSession ?? restoredPiSession}
          lifeModelItemCount={lifeModelSnapshot?.items.length ?? 0}
          onOpenLifeModel={openLifeModel}
          onCreateSessionInWorktree={createPiSessionInWorktree}
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
            id: "new-pi-session",
            label: "新建 Pi 对话",
            description: "在当前 Project 创建一个新的 Pi 原生 Session",
            keywords: ["new", "session", "pi"],
            disabled:
              working || submitting || transitioning || runtimeReconciling,
            onSelect: () => void newSession(),
          },
          {
            id: "session-details",
            label: "打开 Session 详情",
            description: "查看当前 Host 绑定、Working Copy 与连接身份",
            keywords: ["context", "working copy", "identity"],
            disabled: !(activePiHostSession ?? resumablePiSession),
            onSelect: () => setSessionContextOpen(true),
          },
          {
            id: "lifemodel",
            label: "打开 LifeModel",
            description: "查看用户批准的长期上下文与来源",
            keywords: ["memory", "proposal"],
            onSelect: openLifeModel,
          },
          {
            id: "working-copy-manager",
            label: "管理 Working Copies",
            description: "检查并安全移除 Farfold 管理的未绑定 Worktree",
            keywords: ["worktree", "git", "storage", "working copy"],
            onSelect: () => setWorkingCopyManagerOpen(true),
          },
          {
            id: "provider-settings",
            label: "打开模型与 Provider",
            description: "管理 Pi 的 Provider 连接与模型",
            keywords: ["model", "connection", "pi"],
            disabled: working || runtimeReconciling,
            onSelect: () => {
              setProviderSettingsOpen(true);
            },
          },
          {
            id: "managed-update",
            label: "Farfold 更新与恢复",
            description: "保存数据备份，查看更新与恢复状态",
            keywords: [
              "backup",
              "备份",
              "update",
              "upgrade",
              "rollback",
              "更新",
              "回滚",
            ],
            onSelect: () => onOpenUpdate(),
          },
          {
            id: "switch-opencode",
            label: "切换到 OpenCode",
            description: "切换 Runtime 工作区，不移植当前 Session",
            keywords: ["runtime", "workspace"],
            disabled: submitting || transitioning || runtimeReconciling,
            onSelect: () => void selectRuntime("opencode"),
          },
          {
            id: "switch-codex",
            label: "切换到 Codex",
            description: "切换 Runtime 工作区，不移植当前 Session",
            keywords: ["runtime", "workspace"],
            disabled: submitting || transitioning || runtimeReconciling,
            onSelect: () => void selectRuntime("codex"),
          },
        ]}
      />
      {displayedDialog && (
        <ExtensionDialog
          key={`${acpStatus?.generation ?? 0}:${acpDialog?.piAcp?.requestKey ?? displayedDialog.id}`}
          request={displayedDialog}
          busy={extensionReply.busy || acpDialog?.state === "responding"}
          error={extensionReply.error}
          onRespond={answerExtensionDialog}
          onExpire={expireExtensionDialog}
        />
      )}
      {providerSettingsOpen && (acpStatus || managedCreatePath) && (
        <ProviderSettingsDialog
          runtimeName="Pi"
          title={managedCreatePath ? "Pi 新对话" : "当前 Provider"}
          description={managedCreatePath ?? providerStateLabel}
          closeLocked={
            providerSettingsBusy || transitioning || nativeAuthBusy
          }
          onClose={() => {
            setProviderSettingsOpen(false);
            setManagedCreatePath(null);
          }}
        >
          <div className="pi-provider-settings-body">
            {!managedCreatePath && activePiHostSession && (
              <div
                className="pi-provider-tabs"
                role="tablist"
                aria-label="Pi Provider 来源"
              >
                <button
                  role="tab"
                  aria-selected={acpProviderTab === "managed"}
                  disabled={nativeAuthBusy || providerSettingsBusy}
                  onClick={() => setAcpProviderTab("managed")}
                >
                  托管连接
                </button>
                <button
                  role="tab"
                  aria-selected={acpProviderTab === "native"}
                  disabled={nativeAuthBusy || providerSettingsBusy}
                  onClick={() => setAcpProviderTab("native")}
                >
                  原生 Provider
                </button>
              </div>
            )}
            {acpDisplayedProvider &&
              !managedCreatePath &&
              acpProviderTab === "managed" && (
                <section className="context-identities">
                  <dl>
                    <div>
                      <dt>
                        {acpStatus?.configurationState === "confirmed"
                          ? "连接"
                          : "上次确认连接"}
                      </dt>
                      <dd>
                        {providerProjection?.connection
                          .providerConnectionId ===
                        acpDisplayedProvider.providerConnectionId
                          ? providerProjection.connection.label
                          : acpDisplayedProvider.providerConnectionId}
                      </dd>
                    </div>
                    <div>
                      <dt>
                        {acpStatus?.configurationState === "confirmed"
                          ? "模型"
                          : "上次确认模型"}
                      </dt>
                      <dd>{acpDisplayedProvider.runtimeModelId}</dd>
                    </div>
                    <div>
                      <dt>
                        {acpStatus?.configurationState === "confirmed"
                          ? "配置版本"
                          : "上次确认版本"}
                      </dt>
                      <dd>
                        {acpDisplayedProvider.providerConfigVersionId}
                      </dd>
                    </div>
                    <div>
                      <dt>Pi 原生 Provider</dt>
                      <dd>独立配置，不计为托管验证</dd>
                    </div>
                  </dl>
                </section>
              )}
            {!managedCreatePath &&
            acpProviderTab === "native" &&
            activePiHostSession &&
            acpStatus ? (
              <PiNativeAuthentication
                key={`${activePiHostSession.farfoldSessionId}:${acpStatus.generation}`}
                target={{
                  farfoldSessionId: activePiHostSession.farfoldSessionId,
                  nativeSessionId: activePiHostSession.nativeSessionId,
                  runtimeGeneration: acpStatus.generation,
                }}
                disabled={
                  working ||
                  submitting ||
                  transitioning ||
                  runtimeReconciling ||
                  acpStatus.configurationState !== "confirmed"
                }
                onBusyChange={(busy) => {
                  setNativeAuthBusy(busy);
                  lifecycleActionInFlight.current = busy;
                }}
                onSettled={async () => {
                  const expected = acpBindingRef.current;
                  const generation = acpStatusRef.current?.generation;
                  const next = await piAcpStatus();
                  if (
                    expected &&
                    acpBindingRef.current?.farfoldSessionId ===
                      expected.farfoldSessionId &&
                    next.generation === generation
                  ) {
                    applyAcpStatus(next);
                    if (next.configurationState === "confirmed")
                      await hydratePiFromRuntime();
                  }
                }}
                onDisconnect={async () => {
                  lifecycleActionInFlight.current = false;
                  setNativeAuthBusy(false);
                  await disconnectAcpForRecovery();
                  setProviderSettingsOpen(false);
                }}
              />
            ) : (
              <>
                {managedCreatePath && (
                  <button
                    type="button"
                    disabled={
                      providerSettingsBusy ||
                      transitioning ||
                      runtimeReconciling
                    }
                    onClick={() =>
                      void createAcpNativeFirstUseSession().catch(() => {})
                    }
                  >
                    使用 Pi 原生 Provider
                  </button>
                )}
                <ManagedProviderEditor
                  busy={providerSettingsBusy || transitioning}
                  taskLocked={working || submitting || runtimeReconciling}
                  saveLabel="保存共享连接"
                  useSavedLabel={
                    managedCreatePath ? "应用到新对话" : "应用到当前对话"
                  }
                  useSavedDisabled={
                    !managedCreatePath &&
                    (!activePiHostSession ||
                      acpStatus?.configurationState !== "confirmed")
                  }
                  onSave={saveAcpManagedProvider}
                  onUseSaved={
                    managedCreatePath
                      ? createAcpManagedSession
                      : applyAcpManagedProvider
                  }
                  onCancel={() => {
                    setProviderSettingsOpen(false);
                    setManagedCreatePath(null);
                  }}
                />
              </>
            )}
          </div>
        </ProviderSettingsDialog>
      )}
      {workingCopyManagerOpen && (
        <WorkingCopyManagerDialog
          onClose={() => setWorkingCopyManagerOpen(false)}
        />
      )}
      {lifeModelOpen && (
        <LifeModelPanel
          snapshot={lifeModelSnapshot}
          candidates={lifeModelSources}
          selectedItemIds={selectedLifeModelItemIds}
          unavailable={lifeModelUnavailable}
          busy={lifeModelBusy || working || runtimeReconciling}
          onClose={() => closeLifeModel()}
          onReload={() => void loadLifeModel()}
          onCreate={createProposal}
          onUpdate={updateProposal}
          onApprove={approveProposal}
          onReject={rejectProposal}
          onDelete={deleteCanonicalItem}
          onWithdrawSource={withdrawCanonicalSource}
          onPreviewLastSource={previewCanonicalLastSource}
          onResolveLastSource={resolveCanonicalLastSource}
          onEnabled={changeLifeModelEnabled}
          onSelectItem={selectLifeModelItem}
        />
      )}
    </>
  );
}
