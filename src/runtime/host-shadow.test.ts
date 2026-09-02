import { describe, expect, it } from "vitest";
import {
  createHostShadowState,
  reduceHostShadowDelivery,
  type HostInitialSnapshot,
  type HostRoutedEvent,
  type HostRuntimeProjection,
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
