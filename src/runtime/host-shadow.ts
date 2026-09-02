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
  };
}

function addReason(state: HostShadowState, reason: string): string[] {
  return state.reconciliationReasons.includes(reason)
    ? state.reconciliationReasons
    : [...state.reconciliationReasons, reason];
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

export async function startHostShadow(
  onState?: (state: HostShadowState) => void,
): Promise<HostShadowHandle> {
  const initial = await invoke<HostInitialSnapshot>("host_initial_snapshot");
  let state = createHostShadowState(initial);
  let hydrating = true;
  const buffered: HostEventDelivery[] = [];
  let readyResolve:
    ((delivery: HostEventDelivery & { type: "ready" }) => void) | null = null;
  const ready = new Promise<HostEventDelivery & { type: "ready" }>(
    (resolve) => {
      readyResolve = resolve;
    },
  );
  const channel = new Channel<HostEventDelivery>((delivery) => {
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
    onState?.(state);
  });
  const subscription = await invoke<HostEventSubscription>(
    "runtime_event_subscribe",
    {
      onEvent: channel,
      afterSequence: initial.eventCursor.latestSequence,
      limit: 512,
    },
  );
  try {
    let batch = (await ready).snapshot;
    state = reduceHostShadowDelivery(state, { type: "ready", snapshot: batch });
    while (batch.hasMore) {
      batch = await invoke<HostEventBatch>("runtime_event_snapshot", {
        afterSequence: batch.nextAfter,
        limit: 512,
      });
      state = reduceHostShadowDelivery(state, {
        type: "ready",
        snapshot: batch,
      });
    }
    hydrating = false;
    for (const delivery of buffered) {
      state = reduceHostShadowDelivery(state, delivery);
    }
    onState?.(state);
  } catch (reason) {
    await invoke("runtime_event_unsubscribe", {
      subscriptionId: subscription.subscriptionId,
    }).catch(() => undefined);
    throw reason;
  }

  return {
    snapshot: () => state,
    stop: async () => {
      await invoke("runtime_event_unsubscribe", {
        subscriptionId: subscription.subscriptionId,
      });
    },
  };
}
