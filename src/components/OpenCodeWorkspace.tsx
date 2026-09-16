import { X } from "@phosphor-icons/react";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { appendBounded } from "../runtime/event-buffer";
import { useHostSessionDraft } from "../runtime/host-draft";
import {
  stopHostOpenCodeRuntime,
  stopHostOpenCodeAcpRuntime,
} from "../runtime/host-runtime-lifecycle";
import {
  focusHostSession,
  updateHostSessionMetadata,
} from "../runtime/host-session-metadata";
import {
  acknowledgeHostRuntimeReconciliation,
  createHostSession,
  hostRuntimeReconciliationRequest,
  openHostSession,
  reconcileOpenCodeHostSession,
  runtimeEnvelopeFromHostEvent,
  subscribeHostRuntimeEvents,
  subscribeHostShadowState,
  type HostRoutedEvent,
  type HostSessionBinding,
  type HostShadowState,
} from "../runtime/host-shadow";
import {
  gateOpenCodeWorkspaceEvent,
  OpenCodeAcpOpeningEvents,
} from "../runtime/opencode-event-gate";
import {
  bindingFromHostSession,
  openCodeAcpTurnProviderBinding,
  openCodeAcpSessionReady,
  openCodePendingPermissionIds,
  openCodePostCreateActivation,
} from "../runtime/opencode-session-binding";
import {
  failClosedInjectionDecision,
  parseOpenCodeLifeModelSources,
  prepareLifeModelInjection,
} from "../runtime/lifemodel";
import {
  OPENCODE_RUNTIME_CONNECTION_ID,
  OPENCODE_RUNTIME_IDENTITY,
  abortOpenCodeTurn,
  canReuseOpenCodeSession,
  openCodeProviderSnapshot,
  openCodeRecoveryTarget,
  openCodeRuntimeStatus,
  openCodeProviderConnectionId,
  openCodeModelSelection,
  selectOpenCodeModel,
  openCodeSessionMessages,
  respondToOpenCodePermission,
  submitOpenCodeTurn,
  type OpenCodeEnvelope,
  type OpenCodeProviderModel,
  type OpenCodeProviderSnapshot,
  type OpenCodeRecoveryTarget,
  type OpenCodeRuntimeStatus,
  type OpenCodeSessionBindingRecord,
} from "../runtime/opencode";
import {
  openCodeAcpStatus,
  abortOpenCodeAcpTurn,
  OPENCODE_ACP_ADAPTER_ID,
  respondToOpenCodeAcpPermission,
  respondToOpenCodeAcpQuestion,
  setOpenCodeAcpConfigOption,
  submitOpenCodeAcpTurn,
  type OpenCodeAcpStatus,
} from "../runtime/opencode-acp";
import {
  providerRuntimeBindingState,
  providerTargetProjectionLabel,
  nativeConfigurationFingerprint,
  readHostProviderProjection,
  recordHostProviderProjection,
  upsertHostProviderConnection,
  type HostProviderProjectionSnapshot,
} from "../runtime/provider-projection";
import {
  listManagedRuntimeInstallations,
  managedRuntimeConnectionSelection,
  type ManagedRuntimeConnectionSelection,
  type ManagedRuntimeSavedInstallation,
} from "../runtime/managed-runtime-installation";
import type { ManagedProviderConnectionSummary } from "../runtime/managed-provider";
import {
  hydrateOpenCodeTimeline,
  initialOpenCodeConversation,
  isOpenCodeIdleEvent,
  openCodeIdleNotice,
  latestOpenCodeModel,
  reduceOpenCodeEvent,
  settleOpenCodeConversation,
  unwrapOpenCodeEvent,
  verifyOpenCodeProviderRequest,
  type OpenCodeConversationState,
} from "../runtime/opencode-conversation";
import {
  OpenCodeActivityReadScope,
  OpenCodeViewScope,
} from "../runtime/opencode-view-scope";
import { traceAfterPaint } from "../runtime/performance-trace";
import {
  describeSessionOpening,
  sessionOpeningError,
  type SessionOpeningTarget,
} from "../runtime/session-opening";
import { sessionStartInput } from "../runtime/session-start";
import { useNativeInteractionReply } from "../runtime/use-native-interaction-reply";
import { useNativeStop } from "../runtime/use-native-stop";
import { useSessionFocus } from "../runtime/use-session-focus";
import type { RuntimeWorkspaceProps } from "../runtime/workspace-contract";
import { CommandPalette } from "./CommandPalette";
import { Composer } from "./Composer";
import { LifeModelPanel } from "./LifeModelPanel";
import { MessageContent } from "./MessageContent";
import { OpenCodePermissionCard } from "./OpenCodePermissionCard";
import { OpenCodeProviderSettings } from "./OpenCodeProviderSettings";
import { PiActivity } from "./PiActivity";
import { RuntimeChooser, type RuntimeProduct } from "./RuntimeChooser";
import { SessionContextPanel } from "./SessionContextPanel";
import { SessionDeletionDialog } from "./SessionDeletionDialog";
import { SessionOpeningPanel } from "./SessionOpeningPanel";
import { SessionStartPanel } from "./SessionStartPanel";
import { Sidebar, type SidebarSessionItem } from "./Sidebar";
import {
  sessionNavigationDisabled,
  sidebarSessionsFromHost,
} from "./sidebar-sessions";
import { WorkingCopyManagerDialog } from "./WorkingCopyManagerDialog";
import { WorkspaceError } from "./WorkspaceError";
import { WorkspaceHeader } from "./WorkspaceHeader";

const stopOpenCodeRuntime = stopHostOpenCodeRuntime;

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

function modelKey(
  model: Pick<OpenCodeProviderModel, "providerId" | "modelId">,
): string {
  return `${model.providerId}:${model.modelId}`;
}

interface PendingProviderVerification {
  farfoldSessionId: string;
  nativeSessionId: string;
  installationId: string;
  runtimeConnectionId: string;
  providerConnectionId: string;
  configVersionId: string;
  providerId: string;
  modelId: string;
  baselineMessageCount: number;
  accepted: boolean;
  idleBeforeAcceptance: boolean;
}

interface AcpSelectConfigOption {
  id: string;
  name: string;
  category: string;
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function acpSelectConfigOptions(value: unknown): AcpSelectConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const option = record(item);
    if (!option || option.type !== "select") return [];
    const id = stringValue(option.id);
    const name = stringValue(option.name);
    const currentValue = stringValue(option.currentValue);
    const values = Array.isArray(option.options)
      ? option.options.flatMap((entry) => {
          const value = record(entry);
          const rawValue = stringValue(value?.value);
          const rawName = stringValue(value?.name);
          return rawValue && rawName
            ? [
                {
                  value: rawValue,
                  name: rawName,
                  description: stringValue(value?.description) || undefined,
                },
              ]
            : [];
        })
      : [];
    if (!id || !name || !currentValue || values.length === 0) return [];
    return [
      {
        id,
        name,
        category: stringValue(option.category),
        currentValue,
        options: values,
      },
    ];
  });
}

function safeProviderSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:@+-]/g, "_").slice(0, 96) || "default";
}

function acpProviderConnectionId(option: AcpSelectConfigOption): string {
  return `opencode-acp-config-${safeProviderSegment(option.id)}`;
}

function acpRuntimeProviderId(option: AcpSelectConfigOption): string {
  return `acp-config:${option.id}`;
}

function acpRuntimeModelId(option: AcpSelectConfigOption): string {
  return `${option.id}:${option.currentValue}`;
}

export function OpenCodeWorkspace({
  active,
  initialProjectPath,
  requestedHostSessionId,
  requestedHostSession,
  onRequestedHostSessionHandled,
  onProjectPath,
  onSelectRuntime,
  onSelectHostSession,
  themeMode,
  onThemeMode,
  onOpenUpdate,
  lifeModel,
  notice,
}: RuntimeWorkspaceProps) {
  const [status, setStatus] = useState(initialStatus);
  const [transition, setTransition] = useState<
    "discovering" | "starting" | "stopping" | "saving-model" | null
  >("discovering");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [projectPath, setProjectPath] = useState(initialProjectPath);
  const [openingTarget, setOpeningTarget] =
    useState<SessionOpeningTarget | null>(null);
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
  const [providerProjection, setProviderProjection] =
    useState<HostProviderProjectionSnapshot | null>(null);
  const [providerProjectionReadFailed, setProviderProjectionReadFailed] =
    useState(false);
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [recoveryTarget, setRecoveryTarget] =
    useState<OpenCodeRecoveryTarget | null>(null);
  const [systemRuntimeConnection, setSystemRuntimeConnection] =
    useState<ManagedRuntimeConnectionSelection | null>(null);
  const [acpStatus, setAcpStatus] = useState<OpenCodeAcpStatus | null>(null);
  const [registeredInstallations, setRegisteredInstallations] = useState<
    ManagedRuntimeSavedInstallation[]
  >([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sessionContextOpen, setSessionContextOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [workingCopyManagerOpen, setWorkingCopyManagerOpen] = useState(false);
  const [sessionDeletionTarget, setSessionDeletionTarget] =
    useState<SidebarSessionItem | null>(null);
  const [lifeModelWarning, setLifeModelWarning] = useState<string | null>(null);
  const [lifeModelBypassOffered, setLifeModelBypassOffered] = useState(false);
  const generation = useRef(0);
  const activeBindingRef = useRef<OpenCodeSessionBindingRecord | null>(null);
  const acpStatusRef = useRef<OpenCodeAcpStatus | null>(null);
  const acpOpeningEvents = useRef(new OpenCodeAcpOpeningEvents());
  const rawFallbackEvents = useRef<OpenCodeEnvelope[]>([]);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const lifeModelSeenEntries = useRef<Map<string, Set<string>>>(new Map());
  const latestHostShadow = useRef<HostShadowState | null>(null);
  const lastHostReconciliation = useRef<string | null>(null);
  const pendingProviderVerification =
    useRef<PendingProviderVerification | null>(null);
  const hostReconciliation = useRef<Promise<void>>(Promise.resolve());
  const hostReconciliationBusy = useRef(false);
  const requestedSessionInFlight = useRef<string | null>(null);
  const viewScope = useRef(new OpenCodeViewScope());
  const nativeActivityReads = useRef(new OpenCodeActivityReadScope());
  const modelSelectionRevision = useRef(0);

  const selectedModel =
    providers?.models.find((model) => modelKey(model) === selectedModelKey) ??
    null;
  const currentOpenCodeTarget = {
    installationId:
      activeBinding?.runtime.installationId ??
      OPENCODE_RUNTIME_IDENTITY.installationId,
    runtimeConnectionId:
      activeBinding?.connectionId ?? OPENCODE_RUNTIME_CONNECTION_ID,
  };
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
    activeBinding?.farfoldSessionId ??
    openCodeHostSessions.find(
      (session) => session.nativeSessionId === activeBinding?.nativeSessionId,
    )?.farfoldSessionId ??
    null;
  const activeHostSession =
    openCodeHostSessions.find(
      (session) => session.farfoldSessionId === activeSessionKey,
    ) ?? null;
  const restoredSessionCandidate =
    openCodeHostSessions.find(
      (session) => session.farfoldSessionId === hostRestoreSessionId,
    ) ?? null;
  const restoredSession =
    restoredSessionCandidate?.farfoldSessionId === activeSessionKey
      ? null
      : restoredSessionCandidate;
  const inheritedAcpConnection = [activeHostSession, restoredSession].find(
    (session) => session?.adapterId === OPENCODE_ACP_ADAPTER_ID,
  );
  const startConnection =
    systemRuntimeConnection ??
    inheritedAcpConnection ??
    (registeredInstallations.length === 1
      ? managedRuntimeConnectionSelection(registeredInstallations[0]!)
      : undefined);
  const bindingUsesAcp = (binding: OpenCodeSessionBindingRecord) =>
    openCodeHostSessions.some(
      (session) =>
        session.farfoldSessionId === binding.farfoldSessionId &&
        session.nativeSessionId === binding.nativeSessionId &&
        session.adapterId === OPENCODE_ACP_ADAPTER_ID,
    );
  const activeUsesAcp =
    activeHostSession?.adapterId === OPENCODE_ACP_ADAPTER_ID;
  const workspaceUsesAcp =
    (activeHostSession ?? restoredSession)?.adapterId !==
    "opencode-server-http-sse-v1";
  const acpPromptReady =
    activeUsesAcp &&
    openCodeAcpSessionReady(activeBinding, acpStatus, projectPath);
  const acpConfigOptions = useMemo(
    () => acpSelectConfigOptions(acpStatus?.configOptions),
    [acpStatus?.configOptions],
  );
  const acpPrimaryModelOption =
    acpConfigOptions.find((option) => option.category === "model") ??
    acpConfigOptions.find(
      (option) =>
        option.category === "model_config" ||
        option.category === "thought_level",
    ) ??
    null;
  const selectedProviderTarget = selectedModel
    ? {
        runtimeProductId: "opencode" as const,
        installationId: currentOpenCodeTarget.installationId,
        runtimeConnectionId: currentOpenCodeTarget.runtimeConnectionId,
        runtimeProviderId: selectedModel.providerId,
        runtimeModelId: selectedModel.modelId,
      }
    : null;

  useEffect(() => {
    acpStatusRef.current = acpStatus;
  }, [acpStatus]);

  function currentAcpTurnMatches(turn: {
    farfoldSessionId: string;
    nativeSessionId: string;
    connectionId: string;
    generation: number;
  }) {
    const binding = activeBindingRef.current;
    const status = acpStatusRef.current;
    return (
      binding?.farfoldSessionId === turn.farfoldSessionId &&
      binding.nativeSessionId === turn.nativeSessionId &&
      binding.connectionId === turn.connectionId &&
      status?.running === true &&
      status.sessionId === turn.nativeSessionId &&
      status.generation === turn.generation
    );
  }
  const acpProviderTarget =
    activeUsesAcp && activeBinding && acpStatus?.managedProvider
      ? {
          providerConnectionId: acpStatus.managedProvider.providerConnectionId,
          runtimeProductId: "opencode" as const,
          installationId: activeBinding.runtime.installationId,
          runtimeConnectionId: activeBinding.connectionId,
          runtimeProviderId: acpStatus.managedProvider.runtimeProviderId,
          runtimeModelId: acpStatus.managedProvider.runtimeModelId,
        }
      : activeUsesAcp && activeBinding && acpPrimaryModelOption
        ? {
            providerConnectionId: acpProviderConnectionId(
              acpPrimaryModelOption,
            ),
            runtimeProductId: "opencode" as const,
            installationId: activeBinding.runtime.installationId,
            runtimeConnectionId: activeBinding.connectionId,
            runtimeProviderId: acpRuntimeProviderId(acpPrimaryModelOption),
            runtimeModelId: acpRuntimeModelId(acpPrimaryModelOption),
          }
        : null;
  const selectedProviderBindingState = providerRuntimeBindingState(
    activeUsesAcp ? null : providerProjection,
    activeUsesAcp ? null : selectedProviderTarget,
  );
  const selectedProviderBinding =
    selectedProviderBindingState.kind === "bound"
      ? {
          providerConnectionId:
            selectedProviderBindingState.providerConnectionId,
          providerConfigVersionId:
            selectedProviderBindingState.providerConfigVersionId,
        }
      : null;
  const acpProviderProjection = acpProviderTarget
    ? providerProjection?.projections.find(
        (candidate) =>
          candidate.runtimeProductId === acpProviderTarget.runtimeProductId &&
          candidate.installationId === acpProviderTarget.installationId &&
          candidate.runtimeConnectionId ===
            acpProviderTarget.runtimeConnectionId &&
          candidate.runtimeProviderId === acpProviderTarget.runtimeProviderId &&
          candidate.runtimeModelId === acpProviderTarget.runtimeModelId,
      )
    : null;
  const acpTurnProviderBinding = openCodeAcpTurnProviderBinding(
    activeUsesAcp ? acpStatus?.managedProvider : null,
  );
  const acpProviderStatus =
    acpProviderProjection && providerProjection && acpProviderTarget
      ? providerTargetProjectionLabel({
          ...acpProviderProjection,
          providerConnectionId: acpProviderTarget.providerConnectionId,
          providerConfigVersionId: acpProviderProjection.configVersionId,
          providerId: acpProviderProjection.runtimeProviderId,
          detail: acpProviderProjection.detail ?? undefined,
          source: providerProjection.connection.source,
        })
      : "请求未验证";
  const acpModelMappingReady = Boolean(
    !acpPrimaryModelOption ||
    acpTurnProviderBinding ||
    (acpProviderTarget &&
      providerProjection &&
      acpProviderProjection &&
      providerProjection.connection.source === "native_unmanaged" &&
      acpProviderProjection.configVersionId ===
        providerProjection.connection.currentConfigVersionId &&
      acpProviderProjection.saveState === "saved" &&
      acpProviderProjection.applyState === "applied"),
  );
  useEffect(() => {
    const providerConnectionId =
      activeUsesAcp && acpStatus?.managedProvider
        ? acpStatus.managedProvider.providerConnectionId
        : activeUsesAcp && acpPrimaryModelOption
          ? acpProviderConnectionId(acpPrimaryModelOption)
          : selectedModel
            ? openCodeProviderConnectionId(selectedModel.providerId)
            : null;
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
      .catch((reason) => {
        if (!cancelled) {
          const detail = String(reason);
          const missingConnection = detail.includes(
            "Unknown Provider connection",
          );
          if (activeUsesAcp && missingConnection) {
            setProviderProjectionReadFailed(false);
            return;
          }
          setProviderProjection(null);
          setProviderProjectionReadFailed(!missingConnection);
          if (!missingConnection) {
            setError(`模型服务配置读取失败：${detail}`);
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeUsesAcp,
    acpStatus?.managedProvider?.providerConnectionId,
    acpPrimaryModelOption?.id,
    selectedModel?.providerId,
    selectedModel?.modelId,
  ]);
  useEffect(() => {
    if (
      !activeUsesAcp ||
      !activeBinding ||
      !acpPromptReady ||
      !acpPrimaryModelOption ||
      acpStatus?.managedProvider ||
      (providerProjection?.connection.source === "farfold_managed" &&
        Boolean(acpProviderProjection))
    )
      return;
    let cancelled = false;
    const providerConnectionId = acpProviderConnectionId(acpPrimaryModelOption);
    void Promise.all([
      nativeConfigurationFingerprint([
        "opencode-acp",
        activeBinding.runtime.installationId,
        activeBinding.connectionId,
        acpPrimaryModelOption.id,
      ]),
      nativeConfigurationFingerprint([
        "config",
        acpPrimaryModelOption.id,
        acpPrimaryModelOption.currentValue,
      ]),
    ])
      .then(([endpointFingerprint, modelMappingFingerprint]) =>
        upsertHostProviderConnection({
          providerConnectionId,
          providerKey: acpPrimaryModelOption.id,
          label: acpPrimaryModelOption.name,
          source: "native_unmanaged",
          endpointFingerprint,
          credentialRevisionFingerprint: "native-unmanaged",
          modelMappingFingerprint,
        }),
      )
      .then((snapshot) =>
        recordHostProviderProjection({
          providerConnectionId,
          configVersionId: snapshot.connection.currentConfigVersionId,
          runtimeProductId: "opencode",
          installationId: activeBinding.runtime.installationId,
          runtimeConnectionId: activeBinding.connectionId,
          runtimeProviderId: acpRuntimeProviderId(acpPrimaryModelOption),
          runtimeModelId: acpRuntimeModelId(acpPrimaryModelOption),
          saveState: "saved",
          applyState: "applied",
          requestState: "not_requested",
          requestVerifiedVersionId: null,
          activeTaskPolicy: "current_task_keeps_bound_config",
          detail:
            "OpenCode ACP native configOptions reported this selector; Farfold did not copy credentials.",
        }),
      )
      .then((snapshot) => {
        if (!cancelled) {
          setProviderProjection(snapshot);
          setProviderProjectionReadFailed(false);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setProviderProjectionReadFailed(true);
          setError(`ACP 模型配置映射记录失败：${String(reason)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeUsesAcp,
    acpPromptReady,
    activeBinding?.runtime.installationId,
    activeBinding?.connectionId,
    acpStatus?.managedProvider,
    acpPrimaryModelOption?.id,
    acpPrimaryModelOption?.name,
    acpPrimaryModelOption?.currentValue,
  ]);
  const ready = Boolean(
    status.running &&
    activeBinding &&
    selectedModel &&
    !providerProjectionReadFailed &&
    selectedProviderBindingState.kind !== "blocked" &&
    !transition &&
    !reconciling,
  );
  const composerReady = activeUsesAcp
    ? Boolean(
        acpPromptReady &&
        acpModelMappingReady &&
        !providerProjectionReadFailed &&
        !transition &&
        !reconciling,
      )
    : ready;
  const composerRuntimeRunning = activeUsesAcp
    ? acpPromptReady
    : status.running;
  const resumableSession =
    activeHostSession?.workingCopyPath === projectPath
      ? activeHostSession
      : restoredSession?.workingCopyPath === projectPath
        ? restoredSession
        : null;
  const requestedOpening: SessionOpeningTarget | null =
    requestedHostSessionId &&
    (!status.running || requestedHostSessionId !== activeSessionKey)
      ? {
          kind: "open",
          sessionId: requestedHostSessionId,
          session:
            requestedHostSession ??
            openCodeHostSessions.find(
              (session) => session.farfoldSessionId === requestedHostSessionId,
            ) ??
            null,
        }
      : null;
  const opening = openingTarget ?? requestedOpening;
  const openingView = opening
    ? describeSessionOpening(opening, "opencode")
    : null;
  const openCodeDraftSessionId =
    activeSessionKey ?? restoredSession?.farfoldSessionId ?? null;
  useSessionFocus(
    active,
    openCodeDraftSessionId,
    requestedHostSessionId,
    setError,
  );
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

  useEffect(() => {
    let cancelled = false;
    void openCodeAcpStatus()
      .then((snapshot) => {
        if (!cancelled) setAcpStatus(snapshot);
      })
      .catch((reason) => {
        if (!cancelled)
          setError(`OpenCode ACP 状态读取失败：${String(reason)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadHistory(
    binding: OpenCodeSessionBindingRecord,
    collectLifeModelSources = false,
  ) {
    const modelRevision = modelSelectionRevision.current;
    const [historyResult, modelResult] = await Promise.allSettled([
      openCodeSessionMessages(binding.nativeSessionId),
      openCodeModelSelection({
        farfoldSessionId: binding.farfoldSessionId,
        nativeSessionId: binding.nativeSessionId,
      }),
    ]);
    if (activeBindingRef.current?.nativeSessionId !== binding.nativeSessionId)
      return;
    if (historyResult.status === "rejected") throw historyResult.reason;
    const history = historyResult.value;
    if (modelRevision === modelSelectionRevision.current) {
      if (modelResult.status === "rejected") {
        setSelectedModelKey(null);
        setError(
          `模型选择未能恢复，请重新选择模型。${String(modelResult.reason)}`,
        );
      } else {
        const nativeModel = modelResult.value ?? latestOpenCodeModel(history);
        setSelectedModelKey(nativeModel ? modelKey(nativeModel) : null);
      }
    }
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

  async function refreshNativeActivity(binding: OpenCodeSessionBindingRecord) {
    const scope = viewScope.current.capture();
    if (scope === null) return;
    const revision = nativeActivityReads.current.begin();
    if (bindingUsesAcp(binding)) {
      const currentAcpStatus = await openCodeAcpStatus();
      const target = await openCodeRecoveryTarget(
        binding.farfoldSessionId,
        currentAcpStatus.generation,
        binding.runtime.installationId,
      );
      if (
        !viewScope.current.isCurrent(scope) ||
        activeBindingRef.current?.farfoldSessionId !== binding.farfoldSessionId
      )
        return;
      setAcpStatus(currentAcpStatus);
      setRecoveryTarget(target);
      return;
    }
    const target = await openCodeRecoveryTarget(binding.farfoldSessionId);
    if (
      !viewScope.current.isCurrent(scope) ||
      activeBindingRef.current?.farfoldSessionId !== binding.farfoldSessionId
    )
      return;
    setRecoveryTarget(target);
    const reconciled = await reconcileOpenCodeHostSession(
      binding.farfoldSessionId,
      binding.nativeSessionId,
    );
    if (
      !viewScope.current.isCurrent(scope) ||
      activeBindingRef.current?.farfoldSessionId !== binding.farfoldSessionId
    )
      return;
    if (
      reconciled.runtimeGeneration !== generation.current ||
      !nativeActivityReads.current.isCurrent(revision)
    )
      return;
    setConversation((current) => ({
      ...current,
      isWorking:
        reconciled.activity === "working" || reconciled.activity === "unknown",
      outcomeUnknown: reconciled.activity === "unknown",
      runtimeObserved:
        reconciled.activity === "unknown"
          ? current.runtimeObserved
          : reconciled.activity === "working",
      ...(reconciled.activity === "idle"
        ? {
            permissions: [],
            retryDetail: null,
            notice: openCodeIdleNotice(current),
          }
        : {}),
    }));
  }

  async function verifyPendingProviderRequest(
    binding: OpenCodeSessionBindingRecord,
  ) {
    const pending = pendingProviderVerification.current;
    if (
      !pending ||
      pending.farfoldSessionId !== binding.farfoldSessionId ||
      pending.nativeSessionId !== binding.nativeSessionId
    )
      return;
    if (!pending.accepted) {
      pendingProviderVerification.current = {
        ...pending,
        idleBeforeAcceptance: true,
      };
      return;
    }
    const history = await openCodeSessionMessages(binding.nativeSessionId);
    if (activeBindingRef.current?.nativeSessionId !== binding.nativeSessionId)
      return;
    const verification = verifyOpenCodeProviderRequest(history, {
      providerId: pending.providerId,
      modelId: pending.modelId,
      baselineMessageCount: pending.baselineMessageCount,
    });
    const snapshot = await recordHostProviderProjection({
      providerConnectionId: pending.providerConnectionId,
      configVersionId: pending.configVersionId,
      runtimeProductId: "opencode",
      installationId: pending.installationId,
      runtimeConnectionId: pending.runtimeConnectionId,
      runtimeProviderId: pending.providerId,
      runtimeModelId: pending.modelId,
      saveState: "saved",
      applyState: "applied",
      requestState: verification.matched
        ? "verified_success"
        : "verified_failure",
      requestVerifiedVersionId: pending.configVersionId,
      activeTaskPolicy: "current_task_keeps_bound_config",
      detail: verification.detail,
    });
    pendingProviderVerification.current = null;
    setProviderProjection(snapshot);
  }

  async function checkCurrentActivity() {
    const binding = activeBindingRef.current;
    if (!binding || transition || submitting) return;
    const scope = viewScope.current.capture();
    setReconciling(true);
    try {
      await refreshNativeActivity(binding);
      if (!bindingUsesAcp(binding)) await loadHistory(binding, true);
      if (scope !== null && viewScope.current.isCurrent(scope)) setError(null);
    } catch (reason) {
      if (scope !== null && viewScope.current.isCurrent(scope))
        setError(`状态仍未确认：${String(reason)}`);
    } finally {
      if (scope !== null && viewScope.current.isCurrent(scope))
        setReconciling(false);
    }
  }

  async function terminateForRecovery() {
    if (!recoveryTarget || transition || submitting) return;
    pauseSessionReconciliation();
    viewScope.current.resume();
    const scope = viewScope.current.capture();
    if (scope === null) return;
    nativeActivityReads.current.invalidate();
    setTransition("stopping");
    try {
      const binding = activeBindingRef.current;
      const acp = binding !== null && bindingUsesAcp(binding);
      const stopped = acp
        ? await stopHostOpenCodeAcpRuntime(recoveryTarget)
        : await stopHostOpenCodeRuntime(recoveryTarget);
      if (!viewScope.current.isCurrent(scope)) return;
      generation.current = stopped.generation;
      if ("configOptions" in stopped) {
        acpStatusRef.current = stopped;
        setAcpStatus(stopped);
      } else setStatus(stopped);
      setRecoveryTarget(null);
      setConversation((current) => ({
        ...current,
        isWorking: false,
        outcomeUnknown: false,
        runtimeObserved: false,
        permissions: [],
        questions: [],
        retryDetail: null,
      }));
      setError(
        "Farfold 启动的 OpenCode Server 已退出，原生会话和草稿已保留。任务结果仍未知；外部工具可能继续运行，续接前请核对工作目录和进程。不会自动重发输入。",
      );
    } catch (reason) {
      if (viewScope.current.isCurrent(scope)) setError(String(reason));
    } finally {
      if (viewScope.current.isCurrent(scope)) setTransition(null);
    }
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
      activeBindingRef.current?.runtime.installationId ??
        OPENCODE_RUNTIME_IDENTITY.installationId,
    );
    const binding = activeBindingRef.current;
    const scope = viewScope.current.capture();
    if (
      scope === null ||
      !request ||
      !binding ||
      request.key === lastHostReconciliation.current ||
      hostReconciliationBusy.current
    ) {
      return;
    }
    lastHostReconciliation.current = request.key;
    hostReconciliationBusy.current = true;
    setReconciling(true);
    const pendingPermissionIds = openCodePendingPermissionIds(
      state.pendingInteractions,
      binding,
      bindingUsesAcp(binding)
        ? acpStatusRef.current?.generation
        : generation.current,
    );
    setConversation((current) => ({
      ...current,
      permissions: current.permissions.filter((permission) =>
        pendingPermissionIds.has(permission.id),
      ),
    }));
    hostReconciliation.current = hostReconciliation.current
      .catch(() => undefined)
      .then(async () => {
        if (!viewScope.current.isCurrent(scope)) return;
        if (bindingUsesAcp(binding)) {
          await refreshNativeActivity(binding);
          if (!viewScope.current.isCurrent(scope)) return;
          acknowledgeHostRuntimeReconciliation(request);
          setReconciling(false);
          return;
        }
        const current = await openCodeRuntimeStatus();
        if (!viewScope.current.isCurrent(scope)) return;
        generation.current = Math.max(generation.current, current.generation);
        setStatus((previous) => {
          if (previous.running && !current.running) {
            setConversation((conversation) => ({
              ...conversation,
              isWorking: false,
            }));
            setError(
              "OpenCode Server 已退出；原生 Session 绑定仍保留。工具可能尚未结束，续接前请检查工作目录与运行进程。",
            );
          }
          return current;
        });
        if (!current.running) {
          const target = await openCodeRecoveryTarget(binding.farfoldSessionId);
          if (!viewScope.current.isCurrent(scope)) return;
          setRecoveryTarget(target);
          setConversation((conversation) => ({
            ...conversation,
            isWorking: Boolean(target),
            outcomeUnknown: Boolean(target),
          }));
          acknowledgeHostRuntimeReconciliation(request);
          setReconciling(false);
          return;
        }
        await refreshNativeActivity(binding);
        if (!viewScope.current.isCurrent(scope)) return;
        await loadHistory(binding, true);
        if (!viewScope.current.isCurrent(scope)) return;
        acknowledgeHostRuntimeReconciliation(request);
        setReconciling(false);
      })
      .catch((reason) => {
        if (!viewScope.current.isCurrent(scope)) return;
        setError(`OpenCode 状态重建失败：${String(reason)}`);
        setReconciling(false);
      })
      .finally(() => {
        hostReconciliationBusy.current = false;
        if (latestHostShadow.current)
          queueOpenCodeHostReconciliation(latestHostShadow.current);
      });
  }

  function pauseSessionReconciliation(): void {
    viewScope.current.pause();
    lastHostReconciliation.current = null;
    setReconciling(false);
  }

  function resumeSessionReconciliation(): void {
    viewScope.current.resume();
    setTransition(null);
    if (latestHostShadow.current) {
      queueOpenCodeHostReconciliation(latestHostShadow.current);
    }
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
            }
          });
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    void listManagedRuntimeInstallations("opencode_acp")
      .then((installations) => {
        if (!cancelled) {
          setRegisteredInstallations(installations);
          setAvailable(installations.length > 0);
        }
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

    function handleOpenCodeEvent(
      event: OpenCodeEnvelope,
      routed: HostRoutedEvent,
    ) {
      const binding = activeBindingRef.current;
      if (!binding) return;
      if (acpOpeningEvents.current.capture(event, routed)) return;
      const gated = gateOpenCodeWorkspaceEvent(
        event,
        routed,
        binding,
        generation.current,
        acpStatusRef.current,
      );
      if (!gated.accepted) return;
      generation.current = gated.runtimeGeneration;
      const activity = unwrapOpenCodeEvent(event.payload);
      if (
        event.kind === "protocol_error" ||
        event.kind === "transport_error" ||
        (event.kind === "sse" &&
          ["session.status", "session.idle", "session.error"].includes(
            activity?.type ?? "",
          ))
      )
        nativeActivityReads.current.invalidate();
      setConversation((current) => {
        const next = reduceOpenCodeEvent(
          current,
          event,
          binding.nativeSessionId,
          { questionBridge: acpStatusRef.current?.questionBridge === true },
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
      if (isOpenCodeIdleEvent(event.payload, binding.nativeSessionId)) {
        // Idle can race the abort response and invalidate its in-flight status read.
        // Read again from this terminal event; never leave the invalidated read as
        // the only route to settling the Host admission and the composer.
        void refreshNativeActivity(binding).catch((reason) => {
          if (
            activeBindingRef.current?.farfoldSessionId ===
            binding.farfoldSessionId
          )
            setError(String(reason));
        });
        if (native?.type === "session.idle" && bindingUsesAcp(binding)) {
          void verifyPendingProviderRequest(binding).catch((reason) => {
            if (
              activeBindingRef.current?.farfoldSessionId ===
              binding.farfoldSessionId
            )
              setError(String(reason));
          });
        } else if (native?.type === "session.idle") {
          void loadHistory(binding, true)
            .then(() => verifyPendingProviderRequest(binding))
            .catch((reason) => {
              if (
                activeBindingRef.current?.farfoldSessionId ===
                binding.farfoldSessionId
              )
                setError(String(reason));
            });
        }
      }
    }

    const stopRuntimeEvents = subscribeHostRuntimeEvents((routed) => {
      if (routed.runtime.productId !== "opencode") return;
      const envelope = runtimeEnvelopeFromHostEvent(routed);
      if (
        !envelope ||
        !["sse", "protocol_error", "transport_error", "acp"].includes(
          envelope.kind,
        )
      ) {
        return;
      }
      handleOpenCodeEvent(envelope as OpenCodeEnvelope, routed);
      if (
        unwrapOpenCodeEvent(envelope.payload)?.type === "message.part.delta"
      ) {
        traceAfterPaint("opencode_event_paint", routed.receivedAtMs);
      }
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
      (working && requestedHostSessionId !== activeSessionKey) ||
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
    activeSessionKey,
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

  async function createAcpManagedSession(
    connection: ManagedProviderConnectionSummary,
  ) {
    const cwd = projectPath ?? currentProject;
    if (!startConnection || !cwd) {
      throw new Error("请先选择 OpenCode 1.18.30 ACP 程序和项目目录。");
    }
    if (!connection.currentConfigVersionId) {
      throw new Error("保存连接缺少 Host 配置版本。");
    }
    await createAndOpenSession(cwd, connection);
  }

  async function disconnectRuntime() {
    if (working || submitting || transition || reconciling) return;
    setTransition("stopping");
    setError(null);
    try {
      if (activeUsesAcp && activeHostSession && acpStatus) {
        setAcpStatus(
          await stopHostOpenCodeAcpRuntime({
            farfoldSessionId: activeHostSession.farfoldSessionId,
            nativeSessionId: activeHostSession.nativeSessionId,
            runtimeGeneration: acpStatus.generation,
          }),
        );
      } else {
        setStatus(await stopOpenCodeRuntime());
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setTransition(null);
    }
  }

  async function createAndOpenSession(
    projectOverride?: string,
    managedProvider?: ManagedProviderConnectionSummary,
  ) {
    const targetProject = projectOverride ?? projectPath;
    if (!targetProject) return;
    if (!startConnection) {
      const reason = "请选择已登记的 OpenCode ACP 安装，再新建对话。";
      setError(reason);
      if (projectOverride) throw new Error(reason);
      return;
    }
    if (
      transition ||
      working ||
      reconciling ||
      viewScope.current.capture() === null
    ) {
      if (projectOverride) {
        throw new Error("当前 OpenCode Session 正忙，不能切换 Working Copy。");
      }
      return;
    }
    setError(null);
    setOpeningTarget({ kind: "create", projectPath: targetProject });
    pauseSessionReconciliation();
    try {
      if (status.running) {
        setTransition("stopping");
        const stopped = await stopOpenCodeRuntime();
        generation.current = stopped.generation;
        setStatus(stopped);
      }
      setTransition("starting");
      const created = await createHostSession(
        sessionStartInput(
          targetProject,
          {
            runtimeProductId: "opencode",
            adapterId: OPENCODE_ACP_ADAPTER_ID,
            ...(managedProvider
              ? {
                  managedProvider: {
                    providerConnectionId: managedProvider.providerConnectionId,
                    providerConfigVersionId:
                      managedProvider.currentConfigVersionId!,
                  },
                }
              : {}),
          },
          !managedProvider &&
            inheritedAcpConnection?.installationId ===
              startConnection.installationId
            ? inheritedAcpConnection
            : startConnection,
        ),
      );
      if (created.runtimeProductId !== "opencode") {
        throw new Error(
          "Host created a non-OpenCode Session in this workspace.",
        );
      }
      setProjectPath(targetProject);
      onProjectPath(targetProject);
      const session = created.navigation.sessionIndex.sessions.find(
        (candidate) => candidate.farfoldSessionId === created.farfoldSessionId,
      );
      if (!session) {
        throw new Error("Host navigation omitted the new OpenCode Session.");
      }
      const activation = openCodePostCreateActivation(session);
      activeBindingRef.current = activation.binding;
      setActiveBinding(activation.binding);
      setConversation(initialOpenCodeConversation);
      if (activation.kind === "acp") {
        const currentAcpStatus = await openCodeAcpStatus();
        acpStatusRef.current = currentAcpStatus;
        generation.current = currentAcpStatus.generation;
        setAcpStatus(currentAcpStatus);
        return;
      }
      const currentStatus = await openCodeRuntimeStatus();
      generation.current = currentStatus.generation;
      setStatus(currentStatus);
      const snapshot = await openCodeProviderSnapshot();
      setProviders(snapshot);
      modelSelectionRevision.current += 1;
      setSelectedModelKey(null);
      await loadHistory(activation.binding);
    } catch (reason) {
      setError(
        sessionOpeningError(
          { kind: "create", projectPath: targetProject },
          "opencode",
          reason,
        ),
      );
      if (projectOverride) throw reason;
    } finally {
      setOpeningTarget(null);
      resumeSessionReconciliation();
    }
  }

  async function openHostOpenCodeSession(
    session: HostSessionBinding,
    reconnect = false,
  ) {
    const acpSession = session.adapterId === OPENCODE_ACP_ADAPTER_ID;
    if (
      acpSession
        ? acpStatus?.running &&
          acpStatus.sessionId === session.nativeSessionId &&
          activeSessionKey === session.farfoldSessionId &&
          !reconnect
        : canReuseOpenCodeSession(
            status,
            activeSessionKey,
            session.farfoldSessionId,
            reconnect,
          )
    ) {
      try {
        await focusHostSession(session.farfoldSessionId);
      } catch (reason) {
        setError(String(reason));
      }
      return;
    }
    if (
      working ||
      transition ||
      reconciling ||
      viewScope.current.capture() === null
    )
      return;
    setError(null);
    setOpeningTarget({
      kind: "open",
      sessionId: session.farfoldSessionId,
      session,
    });
    pauseSessionReconciliation();
    const pendingAcpBinding = acpSession
      ? bindingFromHostSession(session)
      : null;
    const previousBinding = activeBindingRef.current;
    try {
      if (!acpSession && status.running) {
        setTransition("stopping");
        const stopped = await stopOpenCodeRuntime();
        generation.current = stopped.generation;
        setStatus(stopped);
      }
      setTransition("starting");
      if (pendingAcpBinding) {
        acpOpeningEvents.current.begin(pendingAcpBinding);
        activeBindingRef.current = pendingAcpBinding;
        setActiveBinding(pendingAcpBinding);
        setConversation(initialOpenCodeConversation);
      }
      const opened = await openHostSession(session.farfoldSessionId);
      if (opened.runtimeProductId !== "opencode") {
        throw new Error(
          "Host opened a non-OpenCode Session in this workspace.",
        );
      }
      setProjectPath(session.workingCopyPath);
      onProjectPath(session.workingCopyPath);
      const openedSession = opened.navigation.sessionIndex.sessions.find(
        (candidate) => candidate.farfoldSessionId === session.farfoldSessionId,
      );
      if (!openedSession) {
        throw new Error("Host navigation omitted the opened OpenCode Session.");
      }
      const binding = bindingFromHostSession(openedSession);
      activeBindingRef.current = binding;
      setActiveBinding(binding);
      if (acpSession) {
        const currentAcpStatus = await openCodeAcpStatus();
        acpStatusRef.current = currentAcpStatus;
        setAcpStatus(currentAcpStatus);
        const replay = acpOpeningEvents.current.finish(
          binding,
          currentAcpStatus,
        );
        setConversation((current) =>
          settleOpenCodeConversation(
            replay.events.reduce(
              (state, event) =>
                reduceOpenCodeEvent(state, event, binding.nativeSessionId, {
                  questionBridge: currentAcpStatus.questionBridge,
                }),
              current,
            ),
          ),
        );
        if (replay.truncated)
          setError(
            "本次恢复的历史超过显示上限，部分内容未载入。原生会话仍保留，请先核对历史再继续。",
          );
        traceAfterPaint("opencode_resume", opened.runtimeReadyAt);
        return;
      }
      // The Server history replaces the session, not just its message list.
      setConversation(initialOpenCodeConversation);
      const currentStatus = await openCodeRuntimeStatus();
      generation.current = currentStatus.generation;
      setStatus(currentStatus);
      const providerSnapshot = await openCodeProviderSnapshot();
      setProviders(providerSnapshot);
      modelSelectionRevision.current += 1;
      setSelectedModelKey(null);
      await loadHistory(binding);
      traceAfterPaint("opencode_resume", opened.runtimeReadyAt);
    } catch (reason) {
      setError(
        sessionOpeningError(
          { kind: "open", sessionId: session.farfoldSessionId, session },
          "opencode",
          reason,
        ),
      );
      if (pendingAcpBinding) {
        acpOpeningEvents.current.clear();
        activeBindingRef.current = previousBinding;
        setActiveBinding(previousBinding);
      }
      if (reconnect) throw reason;
    } finally {
      setOpeningTarget(null);
      resumeSessionReconciliation();
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
    pauseSessionReconciliation();
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
      resumeSessionReconciliation();
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

  async function chooseModel(key: string) {
    const binding = activeBindingRef.current;
    const model = providers?.models.find(
      (candidate) => modelKey(candidate) === key,
    );
    if (
      !binding ||
      !model ||
      transition ||
      working ||
      submitting ||
      reconciling
    )
      return;
    const revision = ++modelSelectionRevision.current;
    pauseSessionReconciliation();
    setTransition("saving-model");
    setSelectedModelKey(null);
    setError(null);
    try {
      const saved = await selectOpenCodeModel(
        {
          farfoldSessionId: binding.farfoldSessionId,
          nativeSessionId: binding.nativeSessionId,
        },
        { providerId: model.providerId, modelId: model.modelId },
      );
      if (
        revision === modelSelectionRevision.current &&
        activeBindingRef.current?.farfoldSessionId === binding.farfoldSessionId
      )
        setSelectedModelKey(modelKey(saved));
    } catch (reason) {
      setError(`模型选择未确认，输入已保留。${String(reason)}`);
    } finally {
      resumeSessionReconciliation();
    }
  }

  async function chooseAcpConfigOption(configId: string, value: string) {
    const binding = activeBindingRef.current;
    if (
      !binding ||
      !activeUsesAcp ||
      transition ||
      working ||
      submitting ||
      reconciling
    )
      return;
    pauseSessionReconciliation();
    setTransition("saving-model");
    setError(null);
    try {
      const next = await setOpenCodeAcpConfigOption({
        farfoldSessionId: binding.farfoldSessionId,
        nativeSessionId: binding.nativeSessionId,
        configId,
        value,
      });
      if (
        activeBindingRef.current?.farfoldSessionId === binding.farfoldSessionId
      )
        setAcpStatus(next);
    } catch (reason) {
      setError(`ACP 模型配置未确认，输入已保留。${String(reason)}`);
    } finally {
      resumeSessionReconciliation();
    }
  }

  async function send(withoutLifeModel = false) {
    const text = message.trim();
    if (
      !text ||
      openingView ||
      !activeBinding ||
      submitting ||
      working ||
      (activeUsesAcp ? !composerReady : !ready || !selectedModel)
    )
      return;
    const serverModel = activeUsesAcp ? null : selectedModel;
    setSubmitting(true);
    setError(null);
    setLifeModelWarning(null);
    const wantedInjection =
      !activeUsesAcp &&
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
      setConversation((current) => ({
        ...current,
        isWorking: true,
        runtimeObserved: false,
        outcomeUnknown: false,
        recoveryNotice: null,
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
      const providerVerificationBaseline =
        !activeUsesAcp && selectedProviderBinding
          ? await openCodeSessionMessages(activeBinding.nativeSessionId)
          : null;
      pendingProviderVerification.current =
        !activeUsesAcp && selectedProviderBinding
          ? {
              farfoldSessionId: activeHostSession.farfoldSessionId,
              nativeSessionId: activeBinding.nativeSessionId,
              installationId: activeBinding.runtime.installationId,
              runtimeConnectionId: activeBinding.connectionId,
              providerConnectionId:
                selectedProviderBinding.providerConnectionId,
              configVersionId: selectedProviderBinding.providerConfigVersionId,
              providerId: serverModel!.providerId,
              modelId: serverModel!.modelId,
              baselineMessageCount: providerVerificationBaseline?.length ?? 0,
              accepted: false,
              idleBeforeAcceptance: false,
            }
          : null;
      const acpTurnScope =
        activeUsesAcp && activeBinding
          ? {
              farfoldSessionId: activeHostSession.farfoldSessionId,
              nativeSessionId: activeBinding.nativeSessionId,
              connectionId: activeBinding.connectionId,
              generation: acpStatus?.generation ?? 0,
            }
          : null;
      const submission = activeUsesAcp
        ? await submitOpenCodeAcpTurn({
            farfoldSessionId: activeHostSession.farfoldSessionId,
            nativeSessionId: activeBinding.nativeSessionId,
            ...(acpTurnProviderBinding
              ? {
                  providerConnectionId:
                    acpTurnProviderBinding.providerConnectionId,
                  providerConfigVersionId:
                    acpTurnProviderBinding.providerConfigVersionId,
                  runtimeProviderId: acpTurnProviderBinding.runtimeProviderId,
                  runtimeModelId: acpTurnProviderBinding.runtimeModelId,
                }
              : {}),
            text,
          })
        : await submitOpenCodeTurn({
            farfoldSessionId: activeHostSession.farfoldSessionId,
            nativeSessionId: activeBinding.nativeSessionId,
            providerId: serverModel!.providerId,
            modelId: serverModel!.modelId,
            ...(selectedProviderBinding ?? {}),
            text,
            ...(stagedManifestId
              ? { lifeModelManifestId: stagedManifestId }
              : {}),
          });
      if (submission.outcome === "unknown") {
        if (acpTurnScope && !currentAcpTurnMatches(acpTurnScope)) return;
        pendingProviderVerification.current = null;
        setConversation((current) => ({
          ...current,
          outcomeUnknown: true,
          permissions: [],
          recoveryNotice: current.permissions.length
            ? "本轮提问或权限请求已失效。会话与输入已保留，请核对状态后再继续。"
            : current.recoveryNotice,
          notice: submission.detail,
          timeline: current.timeline.filter(
            (item) => item.id !== localMessageId,
          ),
        }));
        setError(
          "提交结果未知，输入已保留。请核对状态或停止当前任务；不要重复发送。",
        );
        if (!activeUsesAcp) {
          await refreshNativeActivity(activeBinding).catch((reason) =>
            setError(`提交结果仍未知：${String(reason)}`),
          );
        }
        return;
      }
      if (
        submission.outcome === "cancelled" ||
        submission.outcome === "failed"
      ) {
        if (acpTurnScope && !currentAcpTurnMatches(acpTurnScope)) return;
        pendingProviderVerification.current = null;
        setConversation((current) => ({
          ...settleOpenCodeConversation(current),
          notice: submission.detail,
        }));
        setError(null);
        setMessage("");
        if (activeUsesAcp) {
          await openCodeAcpStatus()
            .then(setAcpStatus)
            .catch((reason) =>
              setError(
                `本轮已结束，但状态刷新失败；不会重发。${String(reason)}`,
              ),
            );
          if (acpTurnProviderBinding) {
            await readHostProviderProjection(
              acpTurnProviderBinding.providerConnectionId,
            )
              .then((snapshot) => {
                if (!acpTurnScope || currentAcpTurnMatches(acpTurnScope))
                  setProviderProjection(snapshot);
              })
              .catch(() => setProviderProjectionReadFailed(true));
          }
        }
        if (wantedInjection) lifeModel.onClearSelection();
        return;
      }
      if (acpTurnScope && !currentAcpTurnMatches(acpTurnScope)) return;
      if (pendingProviderVerification.current) {
        const verifyAfterEarlyIdle =
          pendingProviderVerification.current.idleBeforeAcceptance;
        pendingProviderVerification.current = {
          ...pendingProviderVerification.current,
          accepted: true,
        };
        if (verifyAfterEarlyIdle) {
          void loadHistory(activeBinding, true)
            .then(() => verifyPendingProviderRequest(activeBinding))
            .catch((reason) => setError(String(reason)));
        }
      }
      if (activeUsesAcp) {
        setConversation((current) => settleOpenCodeConversation(current));
        setMessage("");
        await openCodeAcpStatus()
          .then((currentAcpStatus) => {
            if (!acpTurnScope || currentAcpTurnMatches(acpTurnScope))
              setAcpStatus(currentAcpStatus);
          })
          .catch((reason) =>
            setError(`本轮已结束，但状态刷新失败；不会重发。${String(reason)}`),
          );
        if (acpTurnProviderBinding) {
          await readHostProviderProjection(
            acpTurnProviderBinding.providerConnectionId,
          )
            .then((snapshot) => {
              if (!acpTurnScope || currentAcpTurnMatches(acpTurnScope))
                setProviderProjection(snapshot);
            })
            .catch((reason) =>
              setError(`本轮已结束，但连接验证记录读取失败。${String(reason)}`),
            );
        }
      }
      setMessage("");
      if (wantedInjection) lifeModel.onClearSelection();
    } catch (reason) {
      pendingProviderVerification.current = null;
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

  const { stopping, requestStop } = useNativeStop(
    activeHostSession
      ? `${activeHostSession.farfoldSessionId}:${
          activeUsesAcp ? (acpStatus?.generation ?? 0) : status.generation
        }`
      : null,
    working,
    setError,
  );

  async function abort() {
    if (!activeBinding || !activeHostSession || !working) return;
    const scope = viewScope.current.capture();
    const acpTurnScope =
      activeUsesAcp && activeBinding
        ? {
            farfoldSessionId: activeHostSession.farfoldSessionId,
            nativeSessionId: activeBinding.nativeSessionId,
            connectionId: activeBinding.connectionId,
            generation: acpStatus?.generation ?? 0,
          }
        : null;
    try {
      pendingProviderVerification.current = null;
      if (!activeUsesAcp) {
        const target = await openCodeRecoveryTarget(
          activeHostSession.farfoldSessionId,
          status.generation,
        );
        if (!viewScope.current.isCurrent(scope)) return;
        setRecoveryTarget(target);
      }
      await requestStop(async () => {
        try {
          const acknowledged = activeUsesAcp
            ? await abortOpenCodeAcpTurn({
                farfoldSessionId: activeHostSession.farfoldSessionId,
                nativeSessionId: activeBinding.nativeSessionId,
              })
            : await abortOpenCodeTurn({
                farfoldSessionId: activeHostSession.farfoldSessionId,
                nativeSessionId: activeBinding.nativeSessionId,
              });
          if (viewScope.current.isCurrent(scope) && !activeUsesAcp) {
            void refreshNativeActivity(activeBinding).catch((reason) => {
              if (viewScope.current.isCurrent(scope)) setError(String(reason));
            });
          } else if (
            viewScope.current.isCurrent(scope) &&
            (!acpTurnScope || currentAcpTurnMatches(acpTurnScope))
          ) {
            setConversation((current) => ({
              ...current,
              ...(current.isWorking
                ? {
                    outcomeUnknown: true,
                    notice:
                      "OpenCode ACP 停止请求已发送；等待原生 prompt 响应确认最终结果。",
                  }
                : {}),
            }));
          }
          return acknowledged;
        } catch (reason) {
          if (
            viewScope.current.isCurrent(scope) &&
            (!acpTurnScope || currentAcpTurnMatches(acpTurnScope))
          )
            setConversation((current) => ({
              ...current,
              outcomeUnknown: true,
            }));
          throw reason;
        }
      });
    } catch (reason) {
      if (viewScope.current.isCurrent(scope)) setError(String(reason));
    }
  }

  const permissionReply = useNativeInteractionReply(
    activeBinding && conversation.permissions[0] && !reconciling
      ? `${activeBinding.farfoldSessionId}:${
          activeUsesAcp ? (acpStatus?.generation ?? 0) : status.generation
        }:${conversation.permissions[0].id}`
      : null,
  );

  async function respondPermission(
    response: string | Record<string, string | string[]>,
  ) {
    const request = conversation.permissions[0];
    if (!request || !activeBinding || reconciling) return;
    await permissionReply.respond(
      () => {
        if (activeUsesAcp) {
          if (request.requestKind === "question") {
            const action =
              response === "__decline"
                ? "decline"
                : response === "__cancel"
                  ? "cancel"
                  : "accept";
            return respondToOpenCodeAcpQuestion({
              farfoldSessionId: activeBinding.farfoldSessionId,
              nativeSessionId: activeBinding.nativeSessionId,
              runtimeGeneration: acpStatus?.generation ?? 0,
              requestId: request.id,
              action,
              ...(action === "accept"
                ? {
                    content:
                      typeof response === "string"
                        ? { choice: response }
                        : response,
                  }
                : {}),
            });
          }
          return respondToOpenCodeAcpPermission({
            farfoldSessionId: activeBinding.farfoldSessionId,
            nativeSessionId: activeBinding.nativeSessionId,
            runtimeGeneration: acpStatus?.generation ?? 0,
            requestId: request.id,
            optionId: String(response),
          });
        }
        return respondToOpenCodePermission({
          sessionId: activeBinding.nativeSessionId,
          permissionId: request.id,
          response: response as "once" | "always" | "reject",
        });
      },
      () =>
        setConversation((current) => ({
          ...current,
          permissions: current.permissions.filter(
            (permission) => permission.id !== request.id,
          ),
        })),
      setError,
    );
  }

  async function selectRuntime(runtime: RuntimeProduct) {
    if (runtime === "opencode" || transition || reconciling) return;
    onSelectRuntime(runtime);
  }

  const currentProject = openingView
    ? openingView.projectPath
    : (activeBinding?.projectPath ?? status.projectPath ?? projectPath);
  const runtimeState = conversation.outcomeUnknown
    ? "OpenCode 结果未知"
    : reconciling
      ? "OpenCode 正在重建状态"
      : working
        ? "OpenCode 正在工作"
        : transition === "starting"
          ? "OpenCode 正在启动"
          : transition === "stopping"
            ? "OpenCode 正在停止"
            : transition === "saving-model"
              ? "OpenCode 正在保存模型选择"
              : activeUsesAcp
                ? acpPromptReady
                  ? "OpenCode ACP 已连接"
                  : acpStatus?.running
                    ? "OpenCode ACP 已启动"
                    : "OpenCode ACP 未启动"
                : status.running
                  ? "OpenCode 已启动"
                  : "OpenCode 未启动";

  if (!active) return null;

  return (
    <div className={`app-shell${sessionContextOpen ? " context-open" : ""}`}>
      <Sidebar
        sessions={sidebarSessions}
        activeSessionKey={
          openingView
            ? openingView.sessionId
            : (activeSessionKey ?? restoredSession?.farfoldSessionId ?? null)
        }
        search={search}
        disabled={
          Boolean(openingView) ||
          working ||
          submitting ||
          Boolean(transition) ||
          reconciling
        }
        isSessionSelectionDisabled={(session) =>
          sessionNavigationDisabled(
            "opencode",
            session.runtimeProductId,
            working,
            submitting || Boolean(transition) || reconciling,
          )
        }
        configuredProviderCount={providers?.connectedProviderIds.length ?? 0}
        attentionCount={hostPendingInteractions.length}
        settingsTitle="OpenCode Provider"
        settingsSubtitle={
          providers
            ? `${providers.connectedProviderIds.length} 个已配置`
            : "连接模型服务"
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
        onOpenConnections={() => setProviderSettingsOpen(true)}
      />

      <main className="workspace">
        <WorkspaceHeader
          session={{
            sessionId: openingView
              ? (openingView.sessionId ?? undefined)
              : (activeHostSession ?? restoredSession)?.farfoldSessionId,
            title:
              openingView?.title ??
              activeHostSession?.title ??
              activeBinding?.title ??
              restoredSession?.title ??
              "OpenCode",
            disabled:
              Boolean(openingView) ||
              working ||
              submitting ||
              Boolean(transition) ||
              reconciling,
            onError: setError,
          }}
          modelControls={
            openingView ? (
              <span className="runtime-model-empty">正在读取会话模型</span>
            ) : activeUsesAcp ? (
              acpPrimaryModelOption ? (
                <label className="runtime-model-select">
                  <span className="sr-only">
                    OpenCode ACP {acpPrimaryModelOption.name}
                  </span>
                  <select
                    value={acpPrimaryModelOption.currentValue}
                    disabled={
                      !activeBinding ||
                      working ||
                      submitting ||
                      Boolean(transition) ||
                      reconciling
                    }
                    onChange={(event) =>
                      void chooseAcpConfigOption(
                        acpPrimaryModelOption.id,
                        event.target.value,
                      )
                    }
                  >
                    {acpPrimaryModelOption.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="runtime-model-empty">
                  ACP 使用 Agent 默认模型
                </span>
              )
            ) : providers?.models.length ? (
              <label className="runtime-model-select">
                <span className="sr-only">OpenCode Provider 与模型</span>
                <select
                  value={selectedModel ? modelKey(selectedModel) : ""}
                  disabled={
                    !activeBinding ||
                    working ||
                    submitting ||
                    Boolean(transition) ||
                    reconciling
                  }
                  onChange={(event) => void chooseModel(event.target.value)}
                >
                  {!selectedModel && (
                    <option value="" disabled>
                      {transition === "saving-model"
                        ? "正在保存模型选择"
                        : selectedModelKey
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
            )
          }
          runtimeControls={
            <RuntimeChooser
              value="opencode"
              running={composerRuntimeRunning}
              providerStatus={
                activeUsesAcp
                  ? acpProviderStatus
                  : providers?.models.length
                    ? "认证已发现 · 请求未验证"
                    : "尚未取得认证模型"
              }
              lifeModelEnabled={lifeModel.snapshot?.enabled ?? false}
              disabled={
                Boolean(openingView) ||
                submitting ||
                Boolean(transition) ||
                reconciling
              }
              onChange={(runtime) => void selectRuntime(runtime)}
              onDisconnect={() => void disconnectRuntime()}
              disconnectDisabled={working}
              usesOpenCodeAcp={workspaceUsesAcp}
              acpStatus={acpStatus}
              onManagedRuntimeConnection={(connection) => {
                setSystemRuntimeConnection(connection);
                setAvailable(true);
              }}
            />
          }
          lifeModelCount={lifeModel.snapshot?.items.length ?? 0}
          onOpenLifeModel={lifeModel.onOpen}
          projectPath={currentProject}
          projectLabel={projectName(currentProject)}
          onChooseProject={() => void chooseProject()}
          projectLocked={
            Boolean(openingView) ||
            working ||
            submitting ||
            Boolean(transition) ||
            reconciling
          }
          runtimeStatus={
            openingView
              ? transition === "stopping"
                ? "OpenCode 正在停止"
                : `OpenCode ${openingView.action}`
              : stopping
                ? "OpenCode 停止中"
                : runtimeState
          }
          working={working}
          contextOpen={sessionContextOpen}
          onToggleContext={() => setSessionContextOpen((current) => !current)}
          onOpenCommands={() => setCommandPaletteOpen(true)}
        />

        {activeUsesAcp &&
          !openingView &&
          acpConfigOptions.some(
            (option) => option.id !== acpPrimaryModelOption?.id,
          ) && (
            <div className="startup-strip opencode-native-config">
              {acpConfigOptions
                .filter((option) => option.id !== acpPrimaryModelOption?.id)
                .map((option) => (
                  <label key={option.id}>
                    <span>
                      {option.category === "mode"
                        ? "模式"
                        : option.category === "thought_level"
                          ? "推理强度"
                          : option.name}
                    </span>
                    <select
                      aria-label={`OpenCode ${option.name}`}
                      value={option.currentValue}
                      disabled={
                        !activeBinding ||
                        working ||
                        submitting ||
                        Boolean(transition) ||
                        reconciling
                      }
                      onChange={(event) =>
                        void chooseAcpConfigOption(
                          option.id,
                          event.target.value,
                        )
                      }
                    >
                      {option.options.map((value) => (
                        <option key={value.value} value={value.value}>
                          {value.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
            </div>
          )}

        <section className="conversation-scroll" aria-live="polite">
          {openingView ? (
            <SessionOpeningPanel opening={openingView} />
          ) : !composerRuntimeRunning &&
            !conversation.outcomeUnknown &&
            !stopping ? (
            <SessionStartPanel
              title={
                resumableSession
                  ? "继续最近的 OpenCode 对话"
                  : "通过 OpenCode 开始"
              }
              description="选择项目文件夹，使用 OpenCode 开始工作。"
              connection={
                <div className="runtime-entry-state">
                  <span>Runtime</span>
                  <strong>
                    {resumableSession?.adapterId ===
                    "opencode-server-http-sse-v1"
                      ? "OpenCode 1.15.13 · 已有会话"
                      : "OpenCode ACP 1.18.30"}
                  </strong>
                  <em className={available ? "configured" : ""}>
                    {available === null
                      ? "正在发现"
                      : available
                        ? "组件已检测 · 请求未验证"
                        : "本机构建未准备"}
                  </em>
                </div>
              }
              projectPath={projectPath}
              chooseProject={() => void chooseProject()}
              busy={working || Boolean(transition) || reconciling}
              unavailable={!resumableSession && !startConnection}
              resume={
                resumableSession
                  ? () => void openHostOpenCodeSession(resumableSession)
                  : undefined
              }
              create={() => void createAndOpenSession()}
              primaryLabel={
                transition === "starting"
                  ? "正在启动…"
                  : resumableSession
                    ? "继续对话"
                    : "启动 OpenCode"
              }
            />
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
                          session={activeHostSession}
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
                  key={`${activeBinding?.farfoldSessionId}:${acpStatus?.generation}:${conversation.permissions[0].id}`}
                  request={conversation.permissions[0]}
                  busy={permissionReply.busy}
                  onRespond={(response) => void respondPermission(response)}
                />
              )}
            </div>
          )}
          <div ref={transcriptEnd} />
        </section>

        <div className="runtime-notices">
          {acpStatus?.lastError && (
            <div className="extension-notice warning" role="status">
              <span>{acpStatus.lastError}</span>
            </div>
          )}
          {notice && (
            <WorkspaceError message={notice.message} onClose={notice.onClose} />
          )}
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
          {(conversation.outcomeUnknown ||
            stopping ||
            (working && recoveryTarget)) && (
            <div className="runtime-recovery" role="status">
              <p>尚未确认任务终态，草稿与任务占用继续保留。</p>
              <button
                disabled={reconciling || Boolean(transition) || submitting}
                onClick={() => void checkCurrentActivity()}
              >
                核对原生状态
              </button>
              {recoveryTarget && (
                <button
                  disabled={Boolean(transition) || submitting}
                  onClick={() => void terminateForRecovery()}
                >
                  终止自有 OpenCode 进程
                </button>
              )}
            </div>
          )}
          {error && (
            <WorkspaceError message={error} onClose={() => setError(null)} />
          )}
        </div>

        <Composer
          runtimeLabel="OpenCode"
          supportsSteering={false}
          supportsFollowUp={false}
          steeringHint="当前工具完成后应用"
          stopping={stopping}
          running={
            !openingView &&
            composerRuntimeRunning &&
            Boolean(activeBinding) &&
            !transition &&
            !reconciling
          }
          ready={!openingView && composerReady && !working}
          notReadyReason={
            !openingView && composerRuntimeRunning && activeBinding && !working
              ? activeUsesAcp
                ? transition === "saving-model"
                  ? "正在保存 ACP 模型配置…"
                  : !acpPromptReady
                    ? "ACP Session 尚未恢复到当前对话"
                    : providerProjectionReadFailed
                      ? "ACP 模型配置映射暂时无法记录，请重新打开或检查当前对话"
                      : acpPrimaryModelOption && !acpModelMappingReady
                        ? "正在记录 ACP 模型配置映射…"
                        : undefined
                : transition === "saving-model"
                  ? "正在保存模型选择…"
                  : !transition && !reconciling && !selectedModel
                    ? selectedModelKey
                      ? "上次选择的模型当前不可用，请在顶部重新选择"
                      : "请先在顶部选择 OpenCode 模型"
                    : providerProjectionReadFailed
                      ? "模型服务配置暂时无法读取，请重新打开或检查当前对话"
                      : selectedProviderBindingState.kind === "blocked"
                        ? selectedProviderBindingState.reason
                        : undefined
              : undefined
          }
          working={working}
          submitting={submitting}
          message={openingView ? "" : message}
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
      {sessionContextOpen && !openingView && (
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
            id: "managed-update",
            label: "Farfold 更新与恢复",
            description: "保存数据备份，查看更新与恢复状态",
            keywords: ["backup", "备份", "update", "更新", "恢复"],
            onSelect: onOpenUpdate,
          },
          {
            id: "opencode-provider",
            label: "连接 OpenCode 模型服务",
            description: "配置 API key 并刷新模型列表",
            keywords: ["model", "connection", "provider"],
            onSelect: () => setProviderSettingsOpen(true),
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
      {providerSettingsOpen && (
        <OpenCodeProviderSettings
          preferredProvider={selectedModel?.providerId}
          selectedModel={selectedModel}
          running={activeUsesAcp ? Boolean(acpStatus?.running) : status.running}
          taskLocked={
            working || submitting || Boolean(transition) || reconciling
          }
          canStart={Boolean(projectPath && available)}
          runtimeInstallationId={currentOpenCodeTarget.installationId}
          runtimeConnectionId={currentOpenCodeTarget.runtimeConnectionId}
          usesAcp={workspaceUsesAcp}
          currentConnectionStatus={
            activeUsesAcp ? acpProviderStatus : undefined
          }
          acpManagedSessionDisabled={
            !startConnection || !Boolean(currentProject ?? projectPath)
          }
          onCreateAcpManagedSession={createAcpManagedSession}
          onStart={() =>
            restoredSession
              ? openHostOpenCodeSession(restoredSession, true)
              : createAndOpenSession(projectPath ?? undefined)
          }
          onApply={async () => {
            if (!activeHostSession)
              throw new Error("找不到当前对话，请关闭设置后重新打开对话。");
            await openHostOpenCodeSession(activeHostSession, true);
          }}
          onProjectionUpdated={(snapshot) => {
            if (
              activeUsesAcp &&
              acpStatus?.managedProvider &&
              snapshot.connection.providerConnectionId !==
                acpStatus.managedProvider.providerConnectionId
            )
              return;
            setProviderProjection(snapshot);
            setProviderProjectionReadFailed(false);
          }}
          onClose={() => setProviderSettingsOpen(false)}
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
          onPreviewLastSource={lifeModel.onPreviewLastSource}
          onResolveLastSource={lifeModel.onResolveLastSource}
          onEnabled={lifeModel.onEnabled}
          onSelectItem={lifeModel.onSelectItem}
        />
      )}
    </div>
  );
}
