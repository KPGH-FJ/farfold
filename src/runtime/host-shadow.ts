import { Channel, invoke } from "@tauri-apps/api/core";

export interface HostRuntimeIdentity {
  productId: "pi" | "opencode" | string;
  installationId: string;
  adapterId: string;
}

export interface HostEventCursor {
  streamId: string;
  latestSequence: number;
  oldestAvailable: number | null;
  droppedTotal: number;
}

export type HostResumeCursor = Pick<
  HostEventCursor,
  "streamId" | "latestSequence"
>;

export interface HostRuntimeProjection {
  runtime: HostRuntimeIdentity;
  runtimeBuildId: string;
  connectionId: string;
  runtimeGeneration: number | null;
  latestSequence: number;
  activity:
    | "unobserved"
    | "ready"
    | "idle"
    | "working"
    | "retrying"
    | "stopped"
    | "degraded";
  confidence: "current" | "reconciliation_required";
  reconciliationReason: string | null;
  unknownEventCount: number;
  staleGenerationCount: number;
}

export interface HostPendingInteraction {
  runtime: HostRuntimeIdentity;
  runtimeGeneration: number;
  interactionId: string;
  nativeSessionId: string | null;
  kind: "pi_extension_dialog" | "open_code_permission";
  state: "pending" | "responding";
}

export interface HostSessionBinding {
  farfoldSessionId: string;
  runtimeProductId: string;
  installationId: string;
  runtimeBuildId: string;
  adapterId: string;
  connectionId: string;
  projectId: string;
  projectPath: string;
  projectName: string;
  workingCopyId: string;
  workingCopyPath: string;
  workingCopyKind: "root" | "worktree";
  branchName: string | null;
  nativeSessionId: string;
  nativeLocatorRegistered: boolean;
  title: string;
  titleSource: "native" | "first_user" | "manual";
  pinned: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  unreviewedChangeCount: number;
}

export interface HostRestoreState {
  lastProjectId: string | null;
  lastSessionId: string | null;
  updatedAt: number;
}

export interface HostNavigationSnapshot {
  sessionIndex: {
    schemaVersion: number;
    sessions: HostSessionBinding[];
  };
  restoreState: HostRestoreState | null;
}

export function hostRestoreSession(
  navigation: HostNavigationSnapshot,
): HostSessionBinding | null {
  const restoredId = navigation.restoreState?.lastSessionId;
  if (!restoredId) return null;
  return (
    navigation.sessionIndex.sessions.find(
      (session) =>
        session.farfoldSessionId === restoredId && session.archivedAt === null,
    ) ?? null
  );
}

export interface HostRestoreTransition {
  restoreSessionId: string | null;
  runtimeProductId: string | null;
  projectPath: string | null;
}

export function hostRestoreTransition(
  previousRestoreSessionId: string | null | undefined,
  navigation: HostNavigationSnapshot,
): HostRestoreTransition | null {
  const restoreSessionId = navigation.restoreState?.lastSessionId ?? null;
  if (
    restoreSessionId === previousRestoreSessionId ||
    (previousRestoreSessionId === undefined && restoreSessionId === null)
  ) {
    return null;
  }
  const restored = hostRestoreSession(navigation);
  if (restored) {
    return {
      restoreSessionId,
      runtimeProductId: restored.runtimeProductId,
      projectPath: restored.workingCopyPath,
    };
  }
  const retired = previousRestoreSessionId
    ? navigation.sessionIndex.sessions.find(
        (session) => session.farfoldSessionId === previousRestoreSessionId,
      )
    : null;
  return {
    restoreSessionId,
    runtimeProductId: retired?.runtimeProductId ?? null,
    projectPath: retired?.projectPath ?? null,
  };
}

export function hostSessionCanResume(session: HostSessionBinding): boolean {
  return session.runtimeProductId !== "pi" || session.nativeLocatorRegistered;
}

export function hostRunningSession(
  sessions: HostSessionBinding[],
  runtimeProductId: string,
  nativeSessionId: string | null,
  runtimeRunning: boolean,
): HostSessionBinding | null {
  if (!runtimeRunning || !nativeSessionId) return null;
  return (
    sessions.find(
      (session) =>
        session.runtimeProductId === runtimeProductId &&
        session.nativeSessionId === nativeSessionId &&
        session.archivedAt === null,
    ) ?? null
  );
}

export function shouldReportPiSessionSyncError(
  runtimeRunning: boolean,
  runtimeGeneration: number,
  settledGeneration: number,
): boolean {
  return runtimeRunning && runtimeGeneration === settledGeneration;
}

export type HostSessionOpenBlocker =
  | "session_archived"
  | "runtime_build_not_current"
  | "working_copy_unavailable"
  | "native_locator_unavailable";

export interface HostSessionOpenPreview {
  farfoldSessionId: string;
  runtimeProductId: string;
  installationId: string;
  runtimeBuildId: string;
  adapterId: string;
  connectionId: string;
  workingCopyId: string;
  workingCopyPath: string;
  nativeSessionId: string;
  title: string;
  canOpen: boolean;
  blockers: HostSessionOpenBlocker[];
}

export interface HostSessionOpenResult {
  farfoldSessionId: string;
  runtimeProductId: string;
  installationId: string;
  nativeSessionId: string;
  runtimeGeneration: number;
  openedAt: number;
  navigation: HostNavigationSnapshot;
}

export interface HostPiSessionSyncResult {
  farfoldSessionId: string;
  locatorRegistered: boolean;
  navigation: HostNavigationSnapshot;
}

export type SessionDeletionBlocker =
  "session_not_archived" | "open_attention" | "agent_runtimes_not_stopped";

export interface SessionDeletionEffects {
  deletesFarfoldSessionMetadata: boolean;
  deletesDraft: boolean;
  deletesAttentionRecordCount: number;
  deletesTurnChangeReviewCount: number;
  deletesTurnChangePathCount: number;
  deletesNativeLocator: boolean;
  retainsNativeRuntimeSession: boolean;
  retainsProject: boolean;
  retainsWorkingCopy: boolean;
}

export interface SessionDeletionPreview {
  farfoldSessionId: string;
  title: string;
  runtimeProductId: string;
  nativeSessionId: string;
  projectId: string;
  projectName: string;
  archived: boolean;
  openAttentionCount: number;
  draftByteCount: number;
  workingCopy: {
    workingCopyId: string;
    canonicalPath: string;
    kind: "root" | "worktree";
    pathState: string;
    gitStatus: {
      state: string;
      stagedPathCount: number;
      unstagedPathCount: number;
      untrackedPathCount: number;
      conflictedPathCount: number;
    };
    boundSessionCount: number;
    unarchivedSessionCount: number;
  };
  effects: SessionDeletionEffects;
  blockers: SessionDeletionBlocker[];
  executionEnabled: boolean;
  confirmationToken: string;
  previewedAt: number;
}

export interface DeletedSessionMetadata {
  farfoldSessionId: string;
  deletedAt: number;
  effects: SessionDeletionEffects;
}

export interface HostInitialSnapshot {
  eventCursor: HostEventCursor;
  storage: unknown;
  navigation: HostNavigationSnapshot;
  runtimes: unknown[];
  liveProjections: HostRuntimeProjection[];
  pendingInteractions: HostPendingInteraction[];
}

export interface HostRoutedEvent {
  streamId: string;
  sequence: number;
  runtime: HostRuntimeIdentity;
  runtimeBuildId: string;
  connectionId: string;
  runtimeGeneration: number | null;
  kind: string;
  nativeEnvelope: unknown;
  preservation: "native" | "oversized_dropped";
  receivedAtMs: number;
}

export interface HostSequenceGap {
  requestedAfter: number;
  oldestAvailable: number;
  latestSequence: number;
  droppedTotal: number;
}

export interface HostEventBatch {
  streamId: string;
  requestedAfter: number | null;
  oldestAvailable: number | null;
  latestSequence: number;
  nextAfter: number;
  hasMore: boolean;
  gap: HostSequenceGap | null;
  events: HostRoutedEvent[];
}

export type HostEventDelivery =
  | {
      type: "ready";
      snapshot: HostEventBatch;
      liveProjections?: HostRuntimeProjection[];
      pendingInteractions?: HostPendingInteraction[];
    }
  | {
      type: "event";
      event: HostRoutedEvent;
      projection: HostRuntimeProjection | null;
      pendingInteractions: HostPendingInteraction[];
    };

export interface HostShadowState {
  consumerGeneration: number;
  streamId: string;
  latestSequence: number;
  navigation: HostNavigationSnapshot;
  projections: Record<string, HostRuntimeProjection>;
  pendingInteractions: HostPendingInteraction[];
  eventCount: number;
  reconciliationReasons: string[];
  reconciliationRevisions: Record<string, number>;
  reconciledRevisions: Record<string, number>;
}

export interface HostRuntimeReconciliationRequest {
  key: string;
  runtime: HostRuntimeIdentity;
  runtimeGeneration: number | null;
  revision: number;
  reasons: string[];
}

export interface HostRuntimeReconciliationSnapshot {
  runtime: HostRuntimeIdentity;
  runtimeBuildId: string;
  connectionId: string;
  runtimeGeneration: number;
  nativeSessionId: string;
  messageCount: number;
  activity: string;
  confidence: "current";
  evidence: string[];
}

export type HostRuntimeEnvelope = {
  generation: number;
  kind: string;
  payload: unknown;
  runtime?: HostRuntimeIdentity;
};

export const hostShadowQaEnabled =
  import.meta.env.VITE_FARFOLD_HOST_SHADOW_QA === "1";

type HostRuntimeEventObserver = (event: HostRoutedEvent) => void;
type HostShadowStateObserver = (state: HostShadowState) => void;

const hostRuntimeEventObservers = new Set<HostRuntimeEventObserver>();
const relayedSequences = new Map<string, number>();
const hostShadowStateObservers = new Set<HostShadowStateObserver>();
let latestHostShadowState: HostShadowState | null = null;
let activeHostShadowAcknowledger:
  ((request: HostRuntimeReconciliationRequest) => void) | null = null;
let activeHostNavigationReplacer:
  ((navigation: HostNavigationSnapshot) => void) | null = null;
let nextHostShadowConsumerGeneration = 0;

export function subscribeHostRuntimeEvents(
  observer: HostRuntimeEventObserver,
): () => void {
  hostRuntimeEventObservers.add(observer);
  return () => {
    hostRuntimeEventObservers.delete(observer);
    if (hostRuntimeEventObservers.size === 0) relayedSequences.clear();
  };
}

export function subscribeHostShadowState(
  observer: HostShadowStateObserver,
): () => void {
  hostShadowStateObservers.add(observer);
  if (latestHostShadowState) observer(latestHostShadowState);
  return () => hostShadowStateObservers.delete(observer);
}

function publishHostShadowState(state: HostShadowState): void {
  latestHostShadowState = state;
  for (const observer of hostShadowStateObservers) observer(state);
}

export function acknowledgeHostRuntimeReconciliation(
  request: HostRuntimeReconciliationRequest,
): void {
  activeHostShadowAcknowledger?.(request);
}

export function replaceHostNavigation(
  navigation: HostNavigationSnapshot,
): void {
  activeHostNavigationReplacer?.(navigation);
}

export async function refreshHostNavigation(): Promise<HostNavigationSnapshot> {
  const navigation = await invoke<HostNavigationSnapshot>(
    "host_navigation_snapshot",
  );
  replaceHostNavigation(navigation);
  return navigation;
}

export function previewSessionDeletion(
  farfoldSessionId: string,
): Promise<SessionDeletionPreview> {
  return invoke("session_deletion_preview", { farfoldSessionId });
}

export function deleteSessionMetadata(
  preview: SessionDeletionPreview,
): Promise<DeletedSessionMetadata> {
  return invoke("session_metadata_delete", {
    input: {
      farfoldSessionId: preview.farfoldSessionId,
      expectedConfirmationToken: preview.confirmationToken,
      confirmFarfoldSessionId: preview.farfoldSessionId,
    },
  });
}

export function previewHostSessionOpen(
  farfoldSessionId: string,
): Promise<HostSessionOpenPreview> {
  return invoke("host_session_open_preview", {
    input: { farfoldSessionId },
  });
}

export async function openHostSession(
  farfoldSessionId: string,
  projectTrust?: string,
): Promise<HostSessionOpenResult> {
  const result = await invoke<HostSessionOpenResult>("host_session_open", {
    input: { farfoldSessionId, projectTrust: projectTrust ?? null },
  });
  replaceHostNavigation(result.navigation);
  return result;
}

export async function createHostPiSession(
  projectPath: string,
  projectTrust?: string,
): Promise<HostSessionOpenResult> {
  const result = await invoke<HostSessionOpenResult>("host_pi_session_create", {
    input: { projectPath, projectTrust: projectTrust ?? null },
  });
  replaceHostNavigation(result.navigation);
  return result;
}

export async function syncHostPiActiveSession(): Promise<HostPiSessionSyncResult> {
  const result = await invoke<HostPiSessionSyncResult>(
    "host_pi_active_session_sync",
  );
  replaceHostNavigation(result.navigation);
  return result;
}

export async function createHostOpenCodeSession(
  projectPath: string,
): Promise<HostSessionOpenResult> {
  const result = await invoke<HostSessionOpenResult>(
    "host_opencode_session_create",
    { input: { projectPath } },
  );
  replaceHostNavigation(result.navigation);
  return result;
}

function relayHostRuntimeEvent(event: HostRoutedEvent): void {
  if (hostRuntimeEventObservers.size === 0) {
    relayedSequences.clear();
    return;
  }
  const latest = relayedSequences.get(event.streamId) ?? 0;
  if (event.sequence <= latest) return;
  relayedSequences.set(event.streamId, event.sequence);
  while (relayedSequences.size > 8) {
    const oldest = relayedSequences.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    relayedSequences.delete(oldest);
  }
  for (const observer of hostRuntimeEventObservers) observer(event);
}

export function runtimeEnvelopeFromHostEvent(
  event: HostRoutedEvent,
): HostRuntimeEnvelope | null {
  if (event.preservation !== "native") return null;
  if (
    typeof event.nativeEnvelope !== "object" ||
    event.nativeEnvelope === null ||
    Array.isArray(event.nativeEnvelope)
  ) {
    return null;
  }
  const envelope = event.nativeEnvelope as Record<string, unknown>;
  if (
    typeof envelope.generation !== "number" ||
    !Number.isSafeInteger(envelope.generation) ||
    envelope.generation < 0 ||
    envelope.generation !== event.runtimeGeneration ||
    typeof envelope.kind !== "string" ||
    envelope.kind !== event.kind ||
    !("payload" in envelope)
  ) {
    return null;
  }
  return {
    generation: envelope.generation,
    kind: envelope.kind,
    payload: envelope.payload,
    runtime: event.runtime,
  };
}

function projectionsByInstallation(
  projections: HostRuntimeProjection[],
): Record<string, HostRuntimeProjection> {
  return Object.fromEntries(
    projections.map((projection) => [
      projection.runtime.installationId,
      projection,
    ]),
  );
}

export function createHostShadowState(
  snapshot: HostInitialSnapshot,
): HostShadowState {
  return {
    consumerGeneration: (nextHostShadowConsumerGeneration += 1),
    streamId: snapshot.eventCursor.streamId,
    latestSequence: snapshot.eventCursor.latestSequence,
    navigation: snapshot.navigation,
    projections: projectionsByInstallation(snapshot.liveProjections),
    pendingInteractions: snapshot.pendingInteractions,
    eventCount: 0,
    reconciliationReasons: [],
    reconciliationRevisions: Object.fromEntries(
      snapshot.liveProjections.map((projection) => [
        projection.runtime.installationId,
        projection.confidence === "reconciliation_required" ? 1 : 0,
      ]),
    ),
    reconciledRevisions: Object.fromEntries(
      snapshot.liveProjections.map((projection) => [
        projection.runtime.installationId,
        0,
      ]),
    ),
  };
}

export function hostRuntimeReconciliationRequest(
  state: HostShadowState,
  installationId: string,
): HostRuntimeReconciliationRequest | null {
  const projection = state.projections[installationId];
  if (!projection) return null;
  const revision =
    state.reconciliationRevisions[projection.runtime.installationId] ?? 0;
  const reconciledRevision =
    state.reconciledRevisions[projection.runtime.installationId] ?? 0;
  if (revision === 0 || revision <= reconciledRevision) return null;
  const reasons = [...state.reconciliationReasons];
  if (
    projection.confidence === "reconciliation_required" &&
    projection.reconciliationReason &&
    !reasons.includes(projection.reconciliationReason)
  ) {
    reasons.push(projection.reconciliationReason);
  }
  if (reasons.length === 0) return null;
  return {
    key: [
      state.consumerGeneration,
      state.streamId,
      projection.runtime.installationId,
      projection.runtimeGeneration ?? "unknown",
      revision,
    ].join(":"),
    runtime: projection.runtime,
    runtimeGeneration: projection.runtimeGeneration,
    revision,
    reasons,
  };
}

export function reconcilePiHostSession(): Promise<HostRuntimeReconciliationSnapshot> {
  return invoke("reconcile_pi_session");
}

export function reconcileOpenCodeHostSession(
  sessionId: string,
): Promise<HostRuntimeReconciliationSnapshot> {
  return invoke("reconcile_opencode_session", { sessionId });
}

function addReason(state: HostShadowState, reason: string): string[] {
  return state.reconciliationReasons.includes(reason)
    ? state.reconciliationReasons
    : [...state.reconciliationReasons, reason];
}

function incrementReconciliation(
  state: HostShadowState,
  installationIds: string[],
): Record<string, number> {
  const revisions = { ...state.reconciliationRevisions };
  for (const installationId of new Set(installationIds)) {
    revisions[installationId] = (revisions[installationId] ?? 0) + 1;
  }
  return revisions;
}

function liveProjectionInstallationIds(state: HostShadowState): string[] {
  return Object.values(state.projections)
    .filter(
      (projection) =>
        projection.activity !== "unobserved" &&
        projection.activity !== "stopped",
    )
    .map((projection) => projection.runtime.installationId);
}

function applyProjectionSnapshot(
  state: HostShadowState,
  projection: HostRuntimeProjection,
): HostShadowState {
  const previous = state.projections[projection.runtime.installationId];
  const requiresNewReconciliation =
    projection.confidence === "reconciliation_required" &&
    (previous?.confidence !== "reconciliation_required" ||
      previous.runtimeGeneration !== projection.runtimeGeneration ||
      previous.reconciliationReason !== projection.reconciliationReason);
  return {
    ...state,
    projections: {
      ...state.projections,
      [projection.runtime.installationId]: projection,
    },
    reconciliationRevisions: requiresNewReconciliation
      ? incrementReconciliation(state, [projection.runtime.installationId])
      : state.reconciliationRevisions,
  };
}

function acceptEvent(
  state: HostShadowState,
  event: HostRoutedEvent,
): HostShadowState {
  let eventReasons = state.reconciliationReasons;
  const affectedInstallations: string[] = [];
  if (event.preservation !== "native") {
    eventReasons = addReason(
      { ...state, reconciliationReasons: eventReasons },
      "host_native_envelope_dropped",
    );
    affectedInstallations.push(event.runtime.installationId);
  } else if (!runtimeEnvelopeFromHostEvent(event)) {
    eventReasons = addReason(
      { ...state, reconciliationReasons: eventReasons },
      "host_native_envelope_invalid",
    );
    affectedInstallations.push(event.runtime.installationId);
  }
  if (event.streamId !== state.streamId) {
    affectedInstallations.push(...liveProjectionInstallationIds(state));
    return {
      ...state,
      streamId: event.streamId,
      latestSequence: event.sequence,
      eventCount: state.eventCount + 1,
      reconciliationReasons: addReason(
        { ...state, reconciliationReasons: eventReasons },
        "host_stream_changed",
      ),
      reconciliationRevisions: incrementReconciliation(
        state,
        affectedInstallations,
      ),
    };
  }
  if (event.sequence <= state.latestSequence) return state;
  if (event.sequence !== state.latestSequence + 1) {
    affectedInstallations.push(...liveProjectionInstallationIds(state));
  }
  let reconciliationReasons =
    event.sequence === state.latestSequence + 1
      ? eventReasons
      : addReason(
          { ...state, reconciliationReasons: eventReasons },
          "host_sequence_discontinuity",
        );
  return {
    ...state,
    latestSequence: event.sequence,
    eventCount: state.eventCount + 1,
    reconciliationReasons,
    reconciliationRevisions: incrementReconciliation(
      state,
      affectedInstallations,
    ),
  };
}

export function reduceHostShadowDelivery(
  state: HostShadowState,
  delivery: HostEventDelivery,
): HostShadowState {
  if (delivery.type === "ready") {
    let next = (delivery.liveProjections ?? []).reduce(
      applyProjectionSnapshot,
      state,
    );
    if (delivery.pendingInteractions) {
      next = {
        ...next,
        pendingInteractions: delivery.pendingInteractions,
      };
    }
    if (delivery.snapshot.streamId !== state.streamId) {
      next = {
        ...next,
        streamId: delivery.snapshot.streamId,
        latestSequence: delivery.snapshot.events[0]?.sequence
          ? delivery.snapshot.events[0].sequence - 1
          : delivery.snapshot.latestSequence,
        reconciliationReasons: addReason(next, "host_stream_changed"),
        reconciliationRevisions: incrementReconciliation(
          next,
          liveProjectionInstallationIds(next),
        ),
      };
    }
    if (delivery.snapshot.gap) {
      next = {
        ...next,
        reconciliationReasons: addReason(next, "host_sequence_gap"),
        reconciliationRevisions: incrementReconciliation(
          next,
          liveProjectionInstallationIds(next),
        ),
      };
    }
    return delivery.snapshot.events.reduce(acceptEvent, next);
  }

  const next = acceptEvent(state, delivery.event);
  if (next === state) return state;
  const projected = delivery.projection
    ? applyProjectionSnapshot(next, delivery.projection)
    : next;
  return {
    ...projected,
    pendingInteractions: delivery.pendingInteractions,
  };
}

export interface HostEventSubscription {
  subscriptionId: number;
  streamId: string;
  latestSequence: number;
}

export interface HostShadowHandle {
  snapshot(): HostShadowState;
  stop(): Promise<void>;
}

export interface HostShadowTransport {
  initialSnapshot(): Promise<HostInitialSnapshot>;
  subscribe(
    afterSequence: number,
    limit: number,
    onDelivery: (delivery: HostEventDelivery) => void,
  ): Promise<HostEventSubscription>;
  eventSnapshot(afterSequence: number, limit: number): Promise<HostEventBatch>;
  unsubscribe(subscriptionId: number): Promise<void>;
}

const tauriHostShadowTransport: HostShadowTransport = {
  initialSnapshot: () => invoke("host_initial_snapshot"),
  subscribe: (afterSequence, limit, onDelivery) => {
    const channel = new Channel<HostEventDelivery>(onDelivery);
    return invoke("runtime_event_subscribe", {
      onEvent: channel,
      afterSequence,
      limit,
    });
  },
  eventSnapshot: (afterSequence, limit) =>
    invoke("runtime_event_snapshot", { afterSequence, limit }),
  unsubscribe: (subscriptionId) =>
    invoke("runtime_event_unsubscribe", { subscriptionId }),
};

export async function startHostShadow(
  onState?: (state: HostShadowState) => void,
  transport: HostShadowTransport = tauriHostShadowTransport,
  resumeCursor?: HostResumeCursor,
): Promise<HostShadowHandle> {
  const initial = await transport.initialSnapshot();
  let state = createHostShadowState(
    resumeCursor
      ? {
          ...initial,
          eventCursor: {
            ...initial.eventCursor,
            streamId: resumeCursor.streamId,
            latestSequence: resumeCursor.latestSequence,
          },
        }
      : initial,
  );
  const emitState = () => {
    publishHostShadowState(state);
    onState?.(state);
  };
  const acknowledge = (request: HostRuntimeReconciliationRequest) => {
    const installationId = request.runtime.installationId;
    const pendingRevision = state.reconciliationRevisions[installationId] ?? 0;
    if (request.revision > pendingRevision) return;
    const previous = state.reconciledRevisions[installationId] ?? 0;
    if (request.revision <= previous) return;
    state = {
      ...state,
      reconciledRevisions: {
        ...state.reconciledRevisions,
        [installationId]: request.revision,
      },
    };
    emitState();
  };
  const replaceNavigation = (navigation: HostNavigationSnapshot) => {
    state = { ...state, navigation };
    emitState();
  };
  activeHostShadowAcknowledger = acknowledge;
  activeHostNavigationReplacer = replaceNavigation;
  let hydrating = true;
  const buffered: HostEventDelivery[] = [];
  let readyResolve:
    ((delivery: HostEventDelivery & { type: "ready" }) => void) | null = null;
  const ready = new Promise<HostEventDelivery & { type: "ready" }>(
    (resolve) => {
      readyResolve = resolve;
    },
  );
  const onDelivery = (delivery: HostEventDelivery) => {
    if (delivery.type === "ready" && readyResolve) {
      const resolve = readyResolve;
      readyResolve = null;
      resolve(delivery);
      return;
    }
    if (hydrating) {
      buffered.push(delivery);
      return;
    }
    state = reduceHostShadowDelivery(state, delivery);
    if (delivery.type === "event") relayHostRuntimeEvent(delivery.event);
    emitState();
  };
  let subscription: HostEventSubscription | null = null;
  try {
    subscription = await transport.subscribe(
      state.latestSequence,
      512,
      onDelivery,
    );
    const readyDelivery = await ready;
    let batch = readyDelivery.snapshot;
    state = reduceHostShadowDelivery(state, readyDelivery);
    for (const event of batch.events) relayHostRuntimeEvent(event);
    while (batch.hasMore) {
      batch = await transport.eventSnapshot(batch.nextAfter, 512);
      state = reduceHostShadowDelivery(state, {
        type: "ready",
        snapshot: batch,
      });
      for (const event of batch.events) relayHostRuntimeEvent(event);
    }
    hydrating = false;
    for (const delivery of buffered) {
      state = reduceHostShadowDelivery(state, delivery);
      if (delivery.type === "event") relayHostRuntimeEvent(delivery.event);
    }
    emitState();
  } catch (reason) {
    if (activeHostShadowAcknowledger === acknowledge) {
      activeHostShadowAcknowledger = null;
    }
    if (activeHostNavigationReplacer === replaceNavigation) {
      activeHostNavigationReplacer = null;
    }
    if (subscription) {
      await transport
        .unsubscribe(subscription.subscriptionId)
        .catch(() => undefined);
    }
    throw reason;
  }

  return {
    snapshot: () => state,
    stop: async () => {
      await transport.unsubscribe(subscription.subscriptionId);
      if (latestHostShadowState === state) latestHostShadowState = null;
      if (activeHostShadowAcknowledger === acknowledge) {
        activeHostShadowAcknowledger = null;
      }
      if (activeHostNavigationReplacer === replaceNavigation) {
        activeHostNavigationReplacer = null;
      }
    },
  };
}
