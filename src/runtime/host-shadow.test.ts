import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeHostRuntimeReconciliation,
  createHostShadowState,
  hostRuntimeReconciliationRequest,
  hostRestoreSession,
  reduceHostShadowDelivery,
  replaceHostNavigation,
  runtimeEnvelopeFromHostEvent,
  startHostShadow,
  subscribeHostRuntimeEvents,
  subscribeHostShadowState,
  type HostEventDelivery,
  type HostEventSubscription,
  type HostInitialSnapshot,
  type HostRoutedEvent,
  type HostRuntimeProjection,
  type HostShadowTransport,
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

const openCodeProjection: HostRuntimeProjection = {
  runtime: {
    productId: "opencode",
    installationId: "bundled-opencode",
    adapterId: "opencode-http-sse",
  },
  runtimeBuildId: "opencode@test",
  connectionId: "opencode-local",
  runtimeGeneration: 3,
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
    navigation: {
      sessionIndex: { schemaVersion: 3, sessions: [] },
      restoreState: null,
    },
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
    nativeEnvelope: {
      generation: 2,
      kind: "rpc",
      payload: { type: "agent_start" },
    },
    preservation: "native",
    receivedAtMs: 1,
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
    expect(state.navigation.sessionIndex.schemaVersion).toBe(3);
    expect(state.projections["bundled-pi"].activity).toBe("working");
    expect(state.reconciliationReasons).toEqual([]);
  });

  it("marks explicit gaps and implicit discontinuities for reconciliation", () => {
    let state = createHostShadowState({
      ...initial(),
      liveProjections: [
        projection,
        { ...openCodeProjection, activity: "unobserved" },
      ],
    });
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
    expect(hostRuntimeReconciliationRequest(state, "bundled-pi")).toMatchObject(
      {
        revision: 2,
        reasons: ["host_sequence_gap", "host_sequence_discontinuity"],
      },
    );
    expect(
      hostRuntimeReconciliationRequest(state, "bundled-opencode"),
    ).toBeNull();
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
    expect(
      hostRuntimeReconciliationRequest(state, "bundled-pi")?.revision,
    ).toBe(1);
  });

  it("emits one Runtime-scoped revision for each projection uncertainty transition", () => {
    let state = createHostShadowState(initial());
    const uncertain = {
      ...projection,
      latestSequence: 5,
      confidence: "reconciliation_required" as const,
      reconciliationReason: "runtime_generation_changed",
    };
    state = reduceHostShadowDelivery(state, {
      type: "event",
      event: event(5),
      projection: uncertain,
      pendingInteractions: [],
    });
    expect(hostRuntimeReconciliationRequest(state, "bundled-pi")).toMatchObject(
      {
        revision: 1,
        reasons: ["runtime_generation_changed"],
      },
    );

    state = reduceHostShadowDelivery(state, {
      type: "event",
      event: event(6),
      projection: { ...uncertain, latestSequence: 6 },
      pendingInteractions: [],
    });
    expect(
      hostRuntimeReconciliationRequest(state, "bundled-pi")?.revision,
    ).toBe(1);

    state = reduceHostShadowDelivery(state, {
      type: "event",
      event: event(7),
      projection: {
        ...projection,
        latestSequence: 7,
        confidence: "current",
        reconciliationReason: null,
      },
      pendingInteractions: [],
    });
    expect(hostRuntimeReconciliationRequest(state, "bundled-pi")).toBeNull();
    state = reduceHostShadowDelivery(state, {
      type: "event",
      event: event(8),
      projection: { ...uncertain, latestSequence: 8 },
      pendingInteractions: [],
    });
    expect(
      hostRuntimeReconciliationRequest(state, "bundled-pi")?.revision,
    ).toBe(2);
  });

  it("starts with reconciliation pending when the initial projection is uncertain", () => {
    const state = createHostShadowState({
      ...initial(),
      liveProjections: [
        {
          ...projection,
          confidence: "reconciliation_required",
          reconciliationReason: "pi_protocol_error",
        },
      ],
    });

    expect(hostRuntimeReconciliationRequest(state, "bundled-pi")).toMatchObject(
      {
        revision: 1,
        reasons: ["pi_protocol_error"],
      },
    );
  });

  it("uses the subscription-ready projection and interaction snapshot", () => {
    const state = reduceHostShadowDelivery(createHostShadowState(initial()), {
      ...emptyReady(),
      liveProjections: [
        {
          ...projection,
          confidence: "reconciliation_required",
          reconciliationReason: "runtime_generation_changed",
        },
      ],
      pendingInteractions: [
        {
          runtime: projection.runtime,
          runtimeGeneration: 2,
          interactionId: "interaction-1",
          nativeSessionId: "session-1",
          kind: "pi_extension_dialog",
          state: "pending",
        },
      ],
    });

    expect(state.pendingInteractions).toHaveLength(1);
    expect(hostRuntimeReconciliationRequest(state, "bundled-pi")).toMatchObject(
      {
        revision: 1,
        reasons: ["runtime_generation_changed"],
      },
    );
  });
});

describe("Host shadow lifecycle", () => {
  it("relays Channel events without a polling comparison path", async () => {
    const routed = vi.fn();
    const stopRouting = subscribeHostRuntimeEvents(routed);
    const transport: HostShadowTransport = {
      initialSnapshot: async () => initial(),
      subscribe: async (_after, _limit, onDelivery) => {
        onDelivery({
          type: "ready",
          snapshot: {
            ...emptyReady().snapshot,
            latestSequence: 5,
            nextAfter: 5,
            events: [event(5)],
          },
        });
        return {
          subscriptionId: 8,
          streamId: "stream-1",
          latestSequence: 5,
        };
      },
      eventSnapshot: vi.fn(),
      unsubscribe: vi.fn(async () => undefined),
    };

    const handle = await startHostShadow(undefined, transport);

    expect(routed).toHaveBeenCalledOnce();
    expect(handle.snapshot()).toMatchObject({
      latestSequence: 5,
      eventCount: 1,
    });
    await handle.stop();
    stopRouting();
  });

  it("replays the latest Host state to a late subscriber and clears it on stop", async () => {
    const transport: HostShadowTransport = {
      initialSnapshot: async () => initial(),
      subscribe: async (_after, _limit, onDelivery) => {
        onDelivery(emptyReady());
        return {
          subscriptionId: 18,
          streamId: "stream-1",
          latestSequence: 4,
        };
      },
      eventSnapshot: vi.fn(),
      unsubscribe: vi.fn(async () => undefined),
    };
    const handle = await startHostShadow(undefined, transport);
    const late = vi.fn();
    const stopLate = subscribeHostShadowState(late);
    expect(late).toHaveBeenCalledOnce();
    stopLate();
    await handle.stop();

    const afterStop = vi.fn();
    const stopAfter = subscribeHostShadowState(afterStop);
    expect(afterStop).not.toHaveBeenCalled();
    stopAfter();
  });

  it("replaces navigation from a committed Host command result", async () => {
    const transport: HostShadowTransport = {
      initialSnapshot: async () => initial(),
      subscribe: async (_after, _limit, onDelivery) => {
        onDelivery(emptyReady());
        return {
          subscriptionId: 181,
          streamId: "stream-1",
          latestSequence: 4,
        };
      },
      eventSnapshot: vi.fn(),
      unsubscribe: vi.fn(async () => undefined),
    };
    const observed = vi.fn();
    const handle = await startHostShadow(observed, transport);
    replaceHostNavigation({
      sessionIndex: { schemaVersion: 3, sessions: [] },
      restoreState: {
        lastProjectId: "project-1",
        lastSessionId: "session-1",
        updatedAt: 10,
      },
    });

    expect(handle.snapshot().navigation.restoreState?.lastSessionId).toBe(
      "session-1",
    );
    expect(observed).toHaveBeenLastCalledWith(handle.snapshot());
    await handle.stop();
  });

  it("acknowledges only the active Runtime reconciliation revision", async () => {
    const transport: HostShadowTransport = {
      initialSnapshot: async () => initial(),
      subscribe: async (_after, _limit, onDelivery) => {
        onDelivery({
          ...emptyReady(),
          liveProjections: [
            {
              ...projection,
              confidence: "reconciliation_required",
              reconciliationReason: "runtime_generation_changed",
            },
          ],
        });
        return {
          subscriptionId: 19,
          streamId: "stream-1",
          latestSequence: 4,
        };
      },
      eventSnapshot: vi.fn(),
      unsubscribe: vi.fn(async () => undefined),
    };
    const handle = await startHostShadow(undefined, transport);
    const request = hostRuntimeReconciliationRequest(
      handle.snapshot(),
      "bundled-pi",
    );
    expect(request).not.toBeNull();

    acknowledgeHostRuntimeReconciliation(request!);

    expect(handle.snapshot().reconciledRevisions["bundled-pi"]).toBe(1);
    expect(
      hostRuntimeReconciliationRequest(handle.snapshot(), "bundled-pi"),
    ).toBeNull();
    await handle.stop();
  });

  it("reconnects from an explicit stale cursor and preserves gap evidence", async () => {
    const subscribe = vi.fn(async (_after, _limit, onDelivery) => {
      onDelivery({
        type: "ready",
        snapshot: {
          streamId: "stream-1",
          requestedAfter: 4,
          oldestAvailable: 9,
          latestSequence: 10,
          nextAfter: 10,
          hasMore: false,
          gap: {
            requestedAfter: 4,
            oldestAvailable: 9,
            latestSequence: 10,
            droppedTotal: 4,
          },
          events: [event(9), event(10)],
        },
        liveProjections: [{ ...projection, latestSequence: 10 }],
        pendingInteractions: [],
      });
      return {
        subscriptionId: 20,
        streamId: "stream-1",
        latestSequence: 10,
      };
    });
    const transport: HostShadowTransport = {
      initialSnapshot: async () => ({
        ...initial(),
        eventCursor: {
          ...initial().eventCursor,
          latestSequence: 10,
          oldestAvailable: 9,
          droppedTotal: 4,
        },
      }),
      subscribe,
      eventSnapshot: vi.fn(),
      unsubscribe: vi.fn(async () => undefined),
    };

    const handle = await startHostShadow(undefined, transport, {
      streamId: "stream-1",
      latestSequence: 4,
    });

    expect(subscribe).toHaveBeenCalledWith(4, 512, expect.any(Function));
    expect(handle.snapshot().reconciliationReasons).toEqual([
      "host_sequence_gap",
      "host_sequence_discontinuity",
    ]);
    expect(
      hostRuntimeReconciliationRequest(handle.snapshot(), "bundled-pi"),
    ).toMatchObject({ revision: 2 });
    await handle.stop();
  });

  it("paginates catch-up before applying live events buffered during hydration", async () => {
    const onState = vi.fn();
    const routed = vi.fn();
    const stopRouting = subscribeHostRuntimeEvents(routed);
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
    });
    await handle.stop();
    stopRouting();
    expect(
      routed.mock.calls.map(([routedEvent]) => routedEvent.sequence),
    ).toEqual([5, 6, 7]);
  });

  it("unsubscribes without publishing state when catch-up hydration fails", async () => {
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

    expect(onState).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledWith(11);
  });
});

describe("Host navigation restore", () => {
  const session = {
    farfoldSessionId: "session-1",
    runtimeProductId: "pi",
    installationId: "bundled-pi",
    runtimeBuildId: "pi@test",
    adapterId: "pi-rpc-jsonl",
    connectionId: "pi-local",
    projectId: "project-1",
    projectPath: "/tmp/project",
    projectName: "project",
    workingCopyId: "working-copy-1",
    workingCopyPath: "/tmp/project",
    workingCopyKind: "root" as const,
    branchName: null,
    nativeSessionId: "native-1",
    title: "Restored",
    titleSource: "native" as const,
    pinned: false,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 2,
    lastOpenedAt: 3,
  };

  it("resolves only the exact unarchived Host restore binding", () => {
    const navigation = {
      sessionIndex: { schemaVersion: 3, sessions: [session] },
      restoreState: {
        lastProjectId: "project-1",
        lastSessionId: "session-1",
        updatedAt: 3,
      },
    };
    expect(hostRestoreSession(navigation)).toEqual(session);
    expect(
      hostRestoreSession({
        ...navigation,
        sessionIndex: {
          ...navigation.sessionIndex,
          sessions: [{ ...session, archivedAt: 4 }],
        },
      }),
    ).toBeNull();
    expect(
      hostRestoreSession({
        ...navigation,
        restoreState: { ...navigation.restoreState, lastSessionId: "missing" },
      }),
    ).toBeNull();
  });
});

describe("Host Runtime envelope validation", () => {
  it("reconstructs only exact native generation and kind", () => {
    expect(runtimeEnvelopeFromHostEvent(event(5))).toEqual({
      generation: 2,
      kind: "rpc",
      payload: { type: "agent_start" },
      runtime: projection.runtime,
    });
    expect(
      runtimeEnvelopeFromHostEvent({
        ...event(5),
        runtimeGeneration: 3,
      }),
    ).toBeNull();
    expect(
      runtimeEnvelopeFromHostEvent({
        ...event(5),
        preservation: "oversized_dropped",
      }),
    ).toBeNull();
  });

  it("marks malformed and dropped native envelopes for reconciliation", () => {
    let state = createHostShadowState({
      ...initial(),
      liveProjections: [projection, openCodeProjection],
    });
    state = reduceHostShadowDelivery(state, {
      type: "event",
      event: {
        ...event(5),
        nativeEnvelope: { generation: 2, kind: "wrong", payload: {} },
      },
      projection: null,
      pendingInteractions: [],
    });
    state = reduceHostShadowDelivery(state, {
      type: "event",
      event: {
        ...event(6),
        preservation: "oversized_dropped",
        nativeEnvelope: { reason: "too_large" },
      },
      projection: null,
      pendingInteractions: [],
    });

    expect(state.reconciliationReasons).toEqual([
      "host_native_envelope_invalid",
      "host_native_envelope_dropped",
    ]);
    expect(
      hostRuntimeReconciliationRequest(state, "bundled-pi")?.revision,
    ).toBe(2);
    expect(
      hostRuntimeReconciliationRequest(state, "bundled-opencode"),
    ).toBeNull();
  });
});
