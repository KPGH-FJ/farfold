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

export interface HostInitialSnapshot {
  eventCursor: HostEventCursor;
  storage: unknown;
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
  | { type: "ready"; snapshot: HostEventBatch }
  | {
      type: "event";
      event: HostRoutedEvent;
      projection: HostRuntimeProjection | null;
      pendingInteractions: HostPendingInteraction[];
    };

export interface HostShadowState {
  streamId: string;
  latestSequence: number;
  projections: Record<string, HostRuntimeProjection>;
  pendingInteractions: HostPendingInteraction[];
  eventCount: number;
  reconciliationReasons: string[];
  transportParity: RuntimeTransportParitySnapshot;
}

export interface RuntimeTransportParitySnapshot {
  matched: number;
  unmatchedChannel: number;
  unmatchedPolling: number;
  trackedFingerprints: number;
  evictedFingerprints: number;
}

export type RuntimeEnvelopeForParity = {
  generation: number;
  kind: string;
  payload: unknown;
  runtime?: HostRuntimeIdentity;
};

function envelopeFingerprint(envelope: RuntimeEnvelopeForParity): string {
  const serialized = JSON.stringify({
    runtime: envelope.runtime,
    generation: envelope.generation,
    kind: envelope.kind,
    payload: envelope.payload,
  });
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16);
}

export class RuntimeTransportParity {
  private readonly deltas = new Map<string, number>();
  private matched = 0;
  private evictedFingerprints = 0;

  constructor(private readonly capacity = 4096) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Runtime transport parity capacity must be positive");
    }
  }

  observeChannel(event: HostRoutedEvent): RuntimeTransportParitySnapshot {
    return this.observe(
      {
        generation: event.runtimeGeneration ?? -1,
        kind: event.kind,
        payload: (event.nativeEnvelope as RuntimeEnvelopeForParity).payload,
        runtime: event.runtime,
      },
      1,
    );
  }

  observePolling(
    envelope: RuntimeEnvelopeForParity,
  ): RuntimeTransportParitySnapshot {
    return this.observe(envelope, -1);
  }

  snapshot(): RuntimeTransportParitySnapshot {
    let unmatchedChannel = 0;
    let unmatchedPolling = 0;
    for (const delta of this.deltas.values()) {
      if (delta > 0) unmatchedChannel += delta;
      if (delta < 0) unmatchedPolling -= delta;
    }
    return {
      matched: this.matched,
      unmatchedChannel,
      unmatchedPolling,
      trackedFingerprints: this.deltas.size,
      evictedFingerprints: this.evictedFingerprints,
    };
  }

  private observe(
    envelope: RuntimeEnvelopeForParity,
    direction: 1 | -1,
  ): RuntimeTransportParitySnapshot {
    const fingerprint = envelopeFingerprint(envelope);
    const previous = this.deltas.get(fingerprint) ?? 0;
    if (
      (direction === 1 && previous < 0) ||
      (direction === -1 && previous > 0)
    ) {
      this.matched += 1;
    }
    const next = previous + direction;
    if (next === 0) this.deltas.delete(fingerprint);
    else {
      if (!this.deltas.has(fingerprint) && this.deltas.size >= this.capacity) {
        const oldest = this.deltas.keys().next().value as string | undefined;
        if (oldest !== undefined) {
          this.deltas.delete(oldest);
          this.evictedFingerprints += 1;
        }
      }
      this.deltas.set(fingerprint, next);
    }
    return this.snapshot();
  }
}

const legacyObservers = new Set<(event: RuntimeEnvelopeForParity) => void>();

export function recordLegacyRuntimeEvent(
  event: RuntimeEnvelopeForParity,
): void {
  for (const observer of legacyObservers) observer(event);
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
    streamId: snapshot.eventCursor.streamId,
    latestSequence: snapshot.eventCursor.latestSequence,
    projections: projectionsByInstallation(snapshot.liveProjections),
    pendingInteractions: snapshot.pendingInteractions,
    eventCount: 0,
    reconciliationReasons: [],
    transportParity: {
      matched: 0,
      unmatchedChannel: 0,
      unmatchedPolling: 0,
      trackedFingerprints: 0,
      evictedFingerprints: 0,
    },
  };
}

function addReason(state: HostShadowState, reason: string): string[] {
  return state.reconciliationReasons.includes(reason)
    ? state.reconciliationReasons
    : [...state.reconciliationReasons, reason];
}

function withTransportParity(
  state: HostShadowState,
  transportParity: RuntimeTransportParitySnapshot,
): HostShadowState {
  return {
    ...state,
    transportParity,
    reconciliationReasons:
      transportParity.evictedFingerprints > 0
        ? addReason(state, "transport_parity_capacity_exceeded")
        : state.reconciliationReasons,
  };
}

function acceptEvent(
  state: HostShadowState,
  event: HostRoutedEvent,
): HostShadowState {
  if (event.streamId !== state.streamId) {
    return {
      ...state,
      streamId: event.streamId,
      latestSequence: event.sequence,
      eventCount: state.eventCount + 1,
      reconciliationReasons: addReason(state, "host_stream_changed"),
    };
  }
  if (event.sequence <= state.latestSequence) return state;
  const reconciliationReasons =
    event.sequence === state.latestSequence + 1
      ? state.reconciliationReasons
      : addReason(state, "host_sequence_discontinuity");
  return {
    ...state,
    latestSequence: event.sequence,
    eventCount: state.eventCount + 1,
    reconciliationReasons,
  };
}

export function reduceHostShadowDelivery(
  state: HostShadowState,
  delivery: HostEventDelivery,
): HostShadowState {
  if (delivery.type === "ready") {
    let next = state;
    if (delivery.snapshot.streamId !== state.streamId) {
      next = {
        ...next,
        streamId: delivery.snapshot.streamId,
        latestSequence: delivery.snapshot.events[0]?.sequence
          ? delivery.snapshot.events[0].sequence - 1
          : delivery.snapshot.latestSequence,
        reconciliationReasons: addReason(next, "host_stream_changed"),
      };
    }
    if (delivery.snapshot.gap) {
      next = {
        ...next,
        reconciliationReasons: addReason(next, "host_sequence_gap"),
      };
    }
    return delivery.snapshot.events.reduce(acceptEvent, next);
  }

  const next = acceptEvent(state, delivery.event);
  if (next === state) return state;
  const projections = delivery.projection
    ? {
        ...next.projections,
        [delivery.projection.runtime.installationId]: delivery.projection,
      }
    : next.projections;
  return {
    ...next,
    projections,
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
): Promise<HostShadowHandle> {
  const initial = await transport.initialSnapshot();
  let state = createHostShadowState(initial);
  const parity = new RuntimeTransportParity();
  const observeLegacy = (event: RuntimeEnvelopeForParity) => {
    state = withTransportParity(state, parity.observePolling(event));
    onState?.(state);
  };
  legacyObservers.add(observeLegacy);
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
    if (delivery.type === "event") {
      state = withTransportParity(state, parity.observeChannel(delivery.event));
    }
    state = reduceHostShadowDelivery(state, delivery);
    onState?.(state);
  };
  let subscription: HostEventSubscription | null = null;
  try {
    subscription = await transport.subscribe(
      initial.eventCursor.latestSequence,
      512,
      onDelivery,
    );
    let batch = (await ready).snapshot;
    for (const event of batch.events) {
      state = withTransportParity(state, parity.observeChannel(event));
    }
    state = reduceHostShadowDelivery(state, { type: "ready", snapshot: batch });
    while (batch.hasMore) {
      batch = await transport.eventSnapshot(batch.nextAfter, 512);
      for (const event of batch.events) {
        state = withTransportParity(state, parity.observeChannel(event));
      }
      state = reduceHostShadowDelivery(state, {
        type: "ready",
        snapshot: batch,
      });
    }
    hydrating = false;
    for (const delivery of buffered) {
      if (delivery.type === "event") {
        state = withTransportParity(
          state,
          parity.observeChannel(delivery.event),
        );
      }
      state = reduceHostShadowDelivery(state, delivery);
    }
    onState?.(state);
  } catch (reason) {
    legacyObservers.delete(observeLegacy);
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
      legacyObservers.delete(observeLegacy);
      await transport.unsubscribe(subscription.subscriptionId);
    },
  };
}
