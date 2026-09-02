import { describe, expect, it, vi } from "vitest";
import {
  createHostShadowState,
  recordLegacyRuntimeEvent,
  reduceHostShadowDelivery,
  RuntimeTransportParity,
  startHostShadow,
  type HostEventDelivery,
  type HostEventSubscription,
  type HostInitialSnapshot,
  type HostRoutedEvent,
  type HostRuntimeProjection,
  type HostShadowTransport,
  type RuntimeEnvelopeForParity,
} from "./host-shadow";

const projection: HostRuntimeProjection = {
  runtime: {
    productId: "pi",
    installationId: "bundled-pi",
    adapterId: "pi-rpc-jsonl",
  },
  runtimeBuildId: "pi@test",
  connectionId: "pi-local",
  runtimeGeneration: 2,
  latestSequence: 4,
  activity: "idle",
  confidence: "current",
  reconciliationReason: null,
  unknownEventCount: 0,
  staleGenerationCount: 0,
};

function initial(): HostInitialSnapshot {
  return {
    eventCursor: {
      streamId: "stream-1",
      latestSequence: 4,
      oldestAvailable: 1,
      droppedTotal: 0,
    },
    storage: {},
    runtimes: [],
    liveProjections: [projection],
    pendingInteractions: [],
  };
}

function event(sequence: number, streamId = "stream-1"): HostRoutedEvent {
  return {
    streamId,
    sequence,
    runtime: projection.runtime,
    runtimeBuildId: projection.runtimeBuildId,
    connectionId: projection.connectionId,
    runtimeGeneration: 2,
    kind: "rpc",
    nativeEnvelope: { payload: { type: "agent_start" } },
    preservation: "native",
    receivedAtMs: 1,
  };
}

function envelope(payload: unknown, generation = 2): RuntimeEnvelopeForParity {
  return {
    generation,
    kind: "rpc",
    payload,
    runtime: projection.runtime,
  };
}

function emptyReady(): HostEventDelivery & { type: "ready" } {
  return {
    type: "ready",
    snapshot: {
      streamId: "stream-1",
      requestedAfter: 4,
      oldestAvailable: 1,
      latestSequence: 4,
      nextAfter: 4,
      hasMore: false,
      gap: null,
      events: [],
    },
  };
}

describe("Host shadow transport reducer", () => {
  it("applies Ready catch-up before newer live events", () => {
    let state = createHostShadowState(initial());
    state = reduceHostShadowDelivery(state, {
      type: "ready",
      snapshot: {
        streamId: "stream-1",
        requestedAfter: 4,
        oldestAvailable: 1,
        latestSequence: 5,
        nextAfter: 5,
        hasMore: false,
        gap: null,
        events: [event(5)],
      },
    });
    state = reduceHostShadowDelivery(state, {
      type: "event",
      event: event(6),
      projection: { ...projection, latestSequence: 6, activity: "working" },
      pendingInteractions: [],
    });

    expect(state.latestSequence).toBe(6);
    expect(state.eventCount).toBe(2);
    expect(state.projections["bundled-pi"].activity).toBe("working");
    expect(state.reconciliationReasons).toEqual([]);
  });

  it("marks explicit gaps and implicit discontinuities for reconciliation", () => {
    let state = createHostShadowState(initial());
    state = reduceHostShadowDelivery(state, {
      type: "ready",
      snapshot: {
        streamId: "stream-1",
        requestedAfter: 4,
        oldestAvailable: 8,
        latestSequence: 8,
        nextAfter: 8,
        hasMore: false,
        gap: {
          requestedAfter: 4,
          oldestAvailable: 8,
          latestSequence: 8,
          droppedTotal: 3,
        },
        events: [event(8)],
      },
    });

    expect(state.latestSequence).toBe(8);
    expect(state.reconciliationReasons).toEqual([
      "host_sequence_gap",
      "host_sequence_discontinuity",
    ]);
  });

  it("rejects duplicate delivery and detects a replaced Host stream", () => {
    let state = createHostShadowState(initial());
    state = reduceHostShadowDelivery(state, {
      type: "event",
      event: event(4),
      projection: null,
      pendingInteractions: [],
    });
    expect(state.eventCount).toBe(0);

    state = reduceHostShadowDelivery(state, {
      type: "event",
      event: event(1, "stream-2"),
      projection: null,
      pendingInteractions: [],
    });
    expect(state.streamId).toBe("stream-2");
    expect(state.latestSequence).toBe(1);
    expect(state.reconciliationReasons).toEqual(["host_stream_changed"]);
  });
});

describe("Runtime transport parity", () => {
  it("matches identical Channel and polling envelopes without retaining content", () => {
    const parity = new RuntimeTransportParity();
    const legacy = envelope({ type: "message_update", delta: "secret" });

    parity.observePolling(legacy);
    const snapshot = parity.observeChannel({
      ...event(5),
      nativeEnvelope: legacy,
    });

    expect(snapshot).toEqual({
      matched: 1,
      unmatchedChannel: 0,
      unmatchedPolling: 0,
      trackedFingerprints: 0,
      evictedFingerprints: 0,
    });
  });

  it("preserves multiplicity and does not match different generations", () => {
    const parity = new RuntimeTransportParity();
    const legacy = envelope({ type: "agent_start" });

    parity.observePolling(legacy);
    parity.observePolling(legacy);
    parity.observeChannel({ ...event(5), nativeEnvelope: legacy });
    parity.observeChannel({
      ...event(6),
      runtimeGeneration: 3,
      nativeEnvelope: envelope({ type: "agent_start" }, 3),
    });

    expect(parity.snapshot()).toMatchObject({
      matched: 1,
      unmatchedChannel: 1,
      unmatchedPolling: 1,
      trackedFingerprints: 2,
    });
  });

  it("bounds unmatched fingerprints and exposes evictions", () => {
    const parity = new RuntimeTransportParity(2);

    parity.observePolling(envelope({ value: 1 }));
    parity.observePolling(envelope({ value: 2 }));
    const snapshot = parity.observePolling(envelope({ value: 3 }));

    expect(snapshot).toMatchObject({
      unmatchedPolling: 2,
      trackedFingerprints: 2,
      evictedFingerprints: 1,
    });
  });
});

describe("Host shadow lifecycle", () => {
  it("removes the legacy observer when subscription establishment fails", async () => {
    const onState = vi.fn();
    const transport: HostShadowTransport = {
      initialSnapshot: async () => initial(),
      subscribe: async () => {
        throw new Error("subscribe failed");
      },
      eventSnapshot: vi.fn(),
      unsubscribe: vi.fn(),
    };

    await expect(startHostShadow(onState, transport)).rejects.toThrow(
      "subscribe failed",
    );
    recordLegacyRuntimeEvent(envelope({ type: "agent_start" }));

    expect(onState).not.toHaveBeenCalled();
    expect(transport.unsubscribe).not.toHaveBeenCalled();
  });

  it("stops observing polling events before unsubscribing", async () => {
    const onState = vi.fn();
    const subscription: HostEventSubscription = {
      subscriptionId: 9,
      streamId: "stream-1",
      latestSequence: 4,
    };
    const unsubscribe = vi.fn(async () => undefined);
    const transport: HostShadowTransport = {
      initialSnapshot: async () => initial(),
      subscribe: async (_after, _limit, onDelivery) => {
        onDelivery(emptyReady());
        return subscription;
      },
      eventSnapshot: vi.fn(),
      unsubscribe,
    };
    const handle = await startHostShadow(onState, transport);
    onState.mockClear();

    recordLegacyRuntimeEvent(envelope({ type: "agent_start" }));
    expect(onState).toHaveBeenCalledOnce();
    await handle.stop();
    recordLegacyRuntimeEvent(envelope({ type: "agent_end" }));

    expect(onState).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledWith(9);
  });

  it("paginates catch-up before applying live events buffered during hydration", async () => {
    const onState = vi.fn();
    const subscription: HostEventSubscription = {
      subscriptionId: 10,
      streamId: "stream-1",
      latestSequence: 7,
    };
    let deliver: ((delivery: HostEventDelivery) => void) | null = null;
    const transport: HostShadowTransport = {
      initialSnapshot: async () => initial(),
      subscribe: async (_after, _limit, onDelivery) => {
        deliver = onDelivery;
        onDelivery({
          type: "ready",
          snapshot: {
            ...emptyReady().snapshot,
            latestSequence: 6,
            nextAfter: 5,
            hasMore: true,
            events: [event(5)],
          },
        });
        return subscription;
      },
      eventSnapshot: async () => {
        deliver?.({
          type: "event",
          event: event(7),
          projection: { ...projection, latestSequence: 7 },
          pendingInteractions: [],
        });
        return {
          ...emptyReady().snapshot,
          requestedAfter: 5,
          latestSequence: 6,
          nextAfter: 6,
          events: [event(6)],
        };
      },
      unsubscribe: vi.fn(async () => undefined),
    };

    const handle = await startHostShadow(onState, transport);
    expect(handle.snapshot()).toMatchObject({
      latestSequence: 7,
      eventCount: 3,
      transportParity: {
        matched: 0,
        unmatchedChannel: 3,
        unmatchedPolling: 0,
      },
    });

    const legacy = envelope({ type: "agent_start" });
    recordLegacyRuntimeEvent(legacy);
    recordLegacyRuntimeEvent(legacy);
    recordLegacyRuntimeEvent(legacy);
    expect(handle.snapshot().transportParity).toMatchObject({
      matched: 3,
      unmatchedChannel: 0,
      unmatchedPolling: 0,
    });
    await handle.stop();
  });

  it("unsubscribes and removes its observer when catch-up hydration fails", async () => {
    const onState = vi.fn();
    const unsubscribe = vi.fn(async () => undefined);
    const transport: HostShadowTransport = {
      initialSnapshot: async () => initial(),
      subscribe: async (_after, _limit, onDelivery) => {
        onDelivery({
          type: "ready",
          snapshot: {
            ...emptyReady().snapshot,
            nextAfter: 4,
            hasMore: true,
          },
        });
        return {
          subscriptionId: 11,
          streamId: "stream-1",
          latestSequence: 4,
        };
      },
      eventSnapshot: async () => {
        throw new Error("snapshot failed");
      },
      unsubscribe,
    };

    await expect(startHostShadow(onState, transport)).rejects.toThrow(
      "snapshot failed",
    );
    onState.mockClear();
    recordLegacyRuntimeEvent(envelope({ type: "agent_start" }));

    expect(onState).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledWith(11);
  });
});
