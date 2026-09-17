import { X } from "@phosphor-icons/react";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { appendBounded } from "../runtime/event-buffer";
import { useHostSessionDraft } from "../runtime/host-draft";
import { stopHostOpenCodeAcpRuntime } from "../runtime/host-runtime-lifecycle";
import {
  focusHostSession,
  updateHostSessionMetadata,
} from "../runtime/host-session-metadata";
import {
  acknowledgeHostRuntimeReconciliation,
  createHostSession,
  hostRuntimeReconciliationRequest,
  openHostSession,
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
import { acpSelectConfigOptions } from "../runtime/acp-adapter";
import {
  acpProviderConnectionId,
  acpRuntimeModelId,
  acpRuntimeProviderId,
  openCodeAcpAdapter,
  openCodeAcpPrimaryModelOption,
} from "../runtime/opencode-acp-adapter";
import type { OpenCodeAcpStatus } from "../runtime/opencode-acp";
import { openCodeRecoveryTarget } from "../runtime/opencode";
import type { OpenCodeRecoveryTarget } from "../runtime/opencode";
import {
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
  initialOpenCodeConversation,
  isOpenCodeIdleEvent,
  reduceOpenCodeEvent,
  settleOpenCodeConversation,
  unwrapOpenCodeEvent,
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
import type {
  OpenCodeEnvelope,
  OpenCodeSessionBindingRecord,
} from "../runtime/opencode";
import type { RuntimePanelProps } from "../runtime/workspace-contract";
import { CommandPalette } from "./CommandPalette";
import { Composer } from "./Composer";
import { LifeModelPanel } from "./LifeModelPanel";
import { MessageContent } from "./MessageContent";
import { OpenCodePermissionCard } from "./OpenCodePermissionCard";
import { OpenCodeProviderSettings } from "./OpenCodeProviderSettings";
import { PiActivity } from "./PiActivity";
import { RuntimeChooser, type RuntimeProduct } from "./RuntimeChooser";
import { SessionContextPanel } from "./SessionContextPanel";
import { SessionOpeningPanel } from "./SessionOpeningPanel";
import { SessionStartPanel } from "./SessionStartPanel";
import type { SidebarSessionItem } from "./Sidebar";
import { WorkingCopyManagerDialog } from "./WorkingCopyManagerDialog";
import { WorkspaceError } from "./WorkspaceError";
import { WorkspaceHeader } from "./WorkspaceHeader";

function projectName(path: string | null): string {
  if (!path) return "未选择 Project";
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

// OpenCode ACP Runtime panel for the unified Workspace shell. The panel owns
// the OpenCode ACP session lifecycle, native event projection and Turn
// send/Stop; the shared Workspace owns the Sidebar and session navigation.
export function OpenCodePanel({
  active,
  initialProjectPath,
  requestedHostSessionId,
  requestedHostSession,
  onRequestedHostSessionHandled,
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
  const [providerProjection, setProviderProjection] =
    useState<HostProviderProjectionSnapshot | null>(null);
  const [providerProjectionReadFailed, setProviderProjectionReadFailed] =
    useState(false);
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
  const [error, setError] = useState<string | null>(null);
  const [sessionContextOpen, setSessionContextOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [workingCopyManagerOpen, setWorkingCopyManagerOpen] = useState(false);
  const activeBindingRef = useRef<OpenCodeSessionBindingRecord | null>(null);
  const acpStatusRef = useRef<OpenCodeAcpStatus | null>(null);
  const acpOpeningEvents = useRef(new OpenCodeAcpOpeningEvents());
  const rawFallbackEvents = useRef<OpenCodeEnvelope[]>([]);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const latestHostShadow = useRef<HostShadowState | null>(null);
  const lastHostReconciliation = useRef<string | null>(null);
  const hostReconciliation = useRef<Promise<void>>(Promise.resolve());
  const hostReconciliationBusy = useRef(false);
  const requestedSessionInFlight = useRef<string | null>(null);
  const viewScope = useRef(new OpenCodeViewScope());
  const nativeActivityReads = useRef(new OpenCodeActivityReadScope());

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
    (session) => session?.adapterId === openCodeAcpAdapter.adapterId,
  );
  const startConnection =
    systemRuntimeConnection ??
    inheritedAcpConnection ??
    (registeredInstallations.length === 1
      ? managedRuntimeConnectionSelection(registeredInstallations[0]!)
      : undefined);
  const activeUsesAcp =
    activeHostSession?.adapterId === openCodeAcpAdapter.adapterId;
  const acpPromptReady =
    activeUsesAcp &&
    openCodeAcpSessionReady(activeBinding, acpStatus, projectPath);
  const acpConfigOptions = useMemo(
    () => acpSelectConfigOptions(acpStatus?.configOptions),
    [acpStatus?.configOptions],
  );
  const acpPrimaryModelOption = useMemo(
    () => openCodeAcpPrimaryModelOption(acpConfigOptions),
    [acpConfigOptions],
  );

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
      providerProjection.connection.source === "native_unmanaged" &&
      acpProviderProjection &&
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
  const composerReady = Boolean(
    acpPromptReady &&
    acpModelMappingReady &&
    !providerProjectionReadFailed &&
    !transition &&
    !reconciling,
  );
  const resumableSession =
    activeHostSession?.workingCopyPath === projectPath
      ? activeHostSession
      : restoredSession?.workingCopyPath === projectPath
        ? restoredSession
        : null;
  const requestedOpening: SessionOpeningTarget | null =
    requestedHostSessionId && requestedHostSessionId !== activeSessionKey
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
    void openCodeAcpAdapter
      .status()
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

  async function refreshNativeActivity(binding: OpenCodeSessionBindingRecord) {
    const scope = viewScope.current.capture();
    if (scope === null) return;
    const revision = nativeActivityReads.current.begin();
    const currentAcpStatus = await openCodeAcpAdapter.status();
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
  }

  async function checkCurrentActivity() {
    const binding = activeBindingRef.current;
    if (!binding || transition || submitting) return;
    const scope = viewScope.current.capture();
    setReconciling(true);
    try {
      await refreshNativeActivity(binding);
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
      const stopped = await stopHostOpenCodeAcpRuntime(recoveryTarget);
      if (!viewScope.current.isCurrent(scope)) return;
      acpStatusRef.current = stopped;
      setAcpStatus(stopped);
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
        "Farfold 启动的 OpenCode 进程已退出，原生会话和草稿已保留。任务结果仍未知；外部工具可能继续运行，续接前请核对工作目录和进程。不会自动重发输入。",
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
    const binding = activeBindingRef.current;
    const request = hostRuntimeReconciliationRequest(
      state,
      binding?.runtime.installationId ?? "",
    );
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
      acpStatusRef.current?.generation,
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
        await refreshNativeActivity(binding);
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
        0,
        acpStatusRef.current,
      );
      if (!gated.accepted) return;
      if (
        event.kind === "protocol_error" ||
        event.kind === "transport_error" ||
        (event.kind === "sse" &&
          ["session.status", "session.idle", "session.error"].includes(
            unwrapOpenCodeEvent(event.payload)?.type ?? "",
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
      setTransition("starting");
      const created = await createHostSession(
        sessionStartInput(
          targetProject,
          {
            runtimeProductId: "opencode",
            adapterId: openCodeAcpAdapter.adapterId as
              "opencode-acp-stdio-v1" | "opencode-server-http-sse-v1",
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
      const currentAcpStatus = await openCodeAcpAdapter.status();
      acpStatusRef.current = currentAcpStatus;
      setAcpStatus(currentAcpStatus);
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
    const acpSession = session.adapterId === openCodeAcpAdapter.adapterId;
    if (!acpSession) {
      setError("这个 OpenCode Session 不是 ACP 绑定，无法在此面板打开。");
      return;
    }
    if (
      acpStatus?.running &&
      acpStatus.sessionId === session.nativeSessionId &&
      activeSessionKey === session.farfoldSessionId &&
      !reconnect
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
    const pendingAcpBinding = bindingFromHostSession(session);
    const previousBinding = activeBindingRef.current;
    try {
      setTransition("starting");
      acpOpeningEvents.current.begin(pendingAcpBinding);
      activeBindingRef.current = pendingAcpBinding;
      setActiveBinding(pendingAcpBinding);
      setConversation(initialOpenCodeConversation);
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
      const currentAcpStatus = await openCodeAcpAdapter.status();
      acpStatusRef.current = currentAcpStatus;
      setAcpStatus(currentAcpStatus);
      const replay = acpOpeningEvents.current.finish(binding, currentAcpStatus);
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
    } catch (reason) {
      setError(
        sessionOpeningError(
          { kind: "open", sessionId: session.farfoldSessionId, session },
          "opencode",
          reason,
        ),
      );
      acpOpeningEvents.current.clear();
      activeBindingRef.current = previousBinding;
      setActiveBinding(previousBinding);
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
      const next = await openCodeAcpAdapter.setConfigOption({
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

  async function send() {
    const text = message.trim();
    if (
      !text ||
      openingView ||
      !activeBinding ||
      submitting ||
      working ||
      !composerReady
    )
      return;
    setSubmitting(true);
    setError(null);
    const localMessageId = `local-${Date.now()}`;
    try {
      if (!activeHostSession) {
        throw new Error(
          "Host Session binding is unavailable for this OpenCode Turn.",
        );
      }
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
      const acpTurnScope =
        activeUsesAcp && activeBinding
          ? {
              farfoldSessionId: activeHostSession.farfoldSessionId,
              nativeSessionId: activeBinding.nativeSessionId,
              connectionId: activeBinding.connectionId,
              generation: acpStatus?.generation ?? 0,
            }
          : null;
      const submission = await openCodeAcpAdapter.submitTurn({
        farfoldSessionId: activeHostSession.farfoldSessionId,
        nativeSessionId: activeBinding.nativeSessionId,
        ...(acpTurnProviderBinding
          ? {
              providerConnectionId: acpTurnProviderBinding.providerConnectionId,
              providerConfigVersionId:
                acpTurnProviderBinding.providerConfigVersionId,
              runtimeProviderId: acpTurnProviderBinding.runtimeProviderId,
              runtimeModelId: acpTurnProviderBinding.runtimeModelId,
            }
          : {}),
        text,
      });
      if (submission.outcome === "unknown") {
        if (acpTurnScope && !currentAcpTurnMatches(acpTurnScope)) return;
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
        return;
      }
      if (
        submission.outcome === "cancelled" ||
        submission.outcome === "failed"
      ) {
        if (acpTurnScope && !currentAcpTurnMatches(acpTurnScope)) return;
        setConversation((current) => ({
          ...settleOpenCodeConversation(current),
          notice: submission.detail,
        }));
        setError(null);
        setMessage("");
        await openCodeAcpAdapter
          .status()
          .then(setAcpStatus)
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
            .catch(() => setProviderProjectionReadFailed(true));
        }
        return;
      }
      if (acpTurnScope && !currentAcpTurnMatches(acpTurnScope)) return;
      setConversation((current) => settleOpenCodeConversation(current));
      setMessage("");
      await openCodeAcpAdapter
        .status()
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
    } catch (reason) {
      setConversation((current) => ({
        ...current,
        isWorking: false,
        timeline: current.timeline.filter(
          (item) => !(item.kind === "message" && item.id === localMessageId),
        ),
      }));
      setError(String(reason));
    } finally {
      setSubmitting(false);
    }
  }

  const { stopping, requestStop } = useNativeStop(
    activeHostSession
      ? `${activeHostSession.farfoldSessionId}:${acpStatus?.generation ?? 0}`
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
      await requestStop(async () => {
        try {
          const acknowledged = await openCodeAcpAdapter.abortTurn({
            farfoldSessionId: activeHostSession.farfoldSessionId,
            nativeSessionId: activeBinding.nativeSessionId,
          });
          if (
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
      ? `${activeBinding.farfoldSessionId}:${acpStatus?.generation ?? 0}:${conversation.permissions[0].id}`
      : null,
  );

  async function respondPermission(
    response: string | Record<string, string | string[]>,
  ) {
    const request = conversation.permissions[0];
    if (!request || !activeBinding || reconciling) return;
    await permissionReply.respond(
      () => {
        if (request.requestKind === "question") {
          const action =
            response === "__decline"
              ? "decline"
              : response === "__cancel"
                ? "cancel"
                : "accept";
          return openCodeAcpAdapter.respondQuestion({
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
        return openCodeAcpAdapter.respondPermission({
          farfoldSessionId: activeBinding.farfoldSessionId,
          nativeSessionId: activeBinding.nativeSessionId,
          runtimeGeneration: acpStatus?.generation ?? 0,
          requestId: request.id,
          optionId: String(response),
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
    : (activeBinding?.projectPath ?? projectPath);
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
              : acpPromptReady
                ? "OpenCode ACP 已连接"
                : acpStatus?.running
                  ? "OpenCode ACP 已启动"
                  : "OpenCode ACP 未启动";

  const shellBusy =
    Boolean(openingView) ||
    working ||
    submitting ||
    Boolean(transition) ||
    reconciling;
  useEffect(() => {
    onShellMeta({
      activeSessionKey: openingView
        ? openingView.sessionId
        : (activeSessionKey ?? restoredSession?.farfoldSessionId ?? null),
      openingSessionKey: openingView?.sessionId ?? null,
      busy: shellBusy,
      working,
      providerCount: acpStatus?.managedProvider ? 1 : 0,
      settingsTitle: "OpenCode Provider",
      settingsSubtitle: acpStatus?.managedProvider
        ? acpProviderStatus
        : "连接模型服务",
      contextOpen: sessionContextOpen,
    });
  }, [
    onShellMeta,
    shellBusy,
    working,
    openingView?.sessionId,
    activeSessionKey,
    restoredSession?.farfoldSessionId,
    acpStatus?.managedProvider,
    acpProviderStatus,
    sessionContextOpen,
  ]);
  useEffect(() => {
    const actions = shellActions.current;
    actions.newSession = () => void createAndOpenSession();
    actions.openConnections = () => setProviderSettingsOpen(true);
    actions.togglePinned = (session) =>
      void toggleOpenCodeSessionPinned(session);
    actions.archive = archiveOpenCodeSession;
    actions.restore = restoreArchivedSession;
    return () => {
      actions.newSession = undefined;
      actions.openConnections = undefined;
      actions.togglePinned = undefined;
      actions.archive = undefined;
      actions.restore = undefined;
    };
  });

  if (!active) return null;

  return (
    <>
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
          disabled: shellBusy,
          onError: setError,
        }}
        modelControls={
          openingView ? (
            <span className="runtime-model-empty">正在读取会话模型</span>
          ) : acpPrimaryModelOption ? (
            <label className="runtime-model-select">
              <span className="sr-only">
                OpenCode ACP {acpPrimaryModelOption.name}
              </span>
              <select
                value={acpPrimaryModelOption.currentValue}
                disabled={!activeBinding || shellBusy}
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
            <span className="runtime-model-empty">ACP 使用 Agent 默认模型</span>
          )
        }
        runtimeControls={
          <RuntimeChooser
            value="opencode"
            running={acpPromptReady}
            providerStatus={acpProviderStatus}
            lifeModelEnabled={lifeModel.snapshot?.enabled ?? false}
            disabled={shellBusy}
            onChange={(runtime) => void selectRuntime(runtime)}
            onDisconnect={() => void disconnectRuntime()}
            disconnectDisabled={working}
            usesOpenCodeAcp
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
        projectLocked={shellBusy}
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

      {acpConfigOptions.some(
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
                  disabled={!activeBinding || shellBusy}
                  onChange={(event) =>
                    void chooseAcpConfigOption(option.id, event.target.value)
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
        ) : !acpPromptReady && !conversation.outcomeUnknown && !stopping ? (
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
                <strong>OpenCode ACP 1.18.30</strong>
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
              ，不会与其他 Runtime Session 互换状态。
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
          acpPromptReady &&
          Boolean(activeBinding) &&
          !transition &&
          !reconciling
        }
        ready={!openingView && composerReady && !working}
        notReadyReason={
          !openingView && acpPromptReady && activeBinding && !working
            ? transition === "saving-model"
              ? "正在保存 ACP 模型配置…"
              : !acpPromptReady
                ? "ACP Session 尚未恢复到当前对话"
                : providerProjectionReadFailed
                  ? "ACP 模型配置映射暂时无法记录，请重新打开或检查当前对话"
                  : acpPrimaryModelOption && !acpModelMappingReady
                    ? "正在记录 ACP 模型配置映射…"
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
          preferredProvider={undefined}
          selectedModel={null}
          running={Boolean(acpStatus?.running)}
          taskLocked={
            working || submitting || Boolean(transition) || reconciling
          }
          canStart={Boolean(projectPath && available)}
          runtimeInstallationId={activeBinding?.runtime.installationId ?? ""}
          runtimeConnectionId={activeBinding?.connectionId ?? ""}
          usesAcp
          currentConnectionStatus={acpProviderStatus}
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
    </>
  );
}
