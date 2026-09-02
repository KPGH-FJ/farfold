import { describe, expect, it } from "vitest";
import {
  createHostShadowState,
  type HostInitialSnapshot,
} from "../runtime/host-shadow";
import { hostShadowQaLabel } from "./HostShadowQaBadge";

const initial: HostInitialSnapshot = {
  eventCursor: {
    streamId: "host-test",
    latestSequence: 0,
    oldestAvailable: null,
    droppedTotal: 0,
  },
  storage: {},
  runtimes: [],
  liveProjections: [],
  pendingInteractions: [],
};

describe("Host shadow QA label", () => {
  it("distinguishes connection, unavailable, and Channel-ready states", () => {
    expect(hostShadowQaLabel(null, false)).toBe("P3 Host · 正在连接");
    expect(hostShadowQaLabel(null, true)).toBe("P3 Host · Channel 不可用");

    const ready = createHostShadowState(initial);
    ready.latestSequence = 3;
    expect(hostShadowQaLabel(ready, false)).toBe("P3 Host · Channel · seq 3");
  });

  it("prioritizes reconciliation and exposes recovered interaction state", () => {
    const state = createHostShadowState({
      ...initial,
      liveProjections: [
        {
          runtime: {
            productId: "pi",
            installationId: "bundled-pi",
            adapterId: "pi-rpc-jsonl",
          },
          runtimeBuildId: "pi@test",
          connectionId: "pi-local",
          runtimeGeneration: 1,
          latestSequence: 1,
          activity: "degraded",
          confidence: "reconciliation_required",
          reconciliationReason: "host_sequence_gap",
          unknownEventCount: 0,
          staleGenerationCount: 0,
        },
      ],
    });
    state.reconciliationReasons = ["host_sequence_gap"];
    expect(hostShadowQaLabel(state, false)).toBe(
      "P3 Host · 需要重建 · host_sequence_gap",
    );

    state.reconciledRevisions["bundled-pi"] = 1;
    state.latestSequence = 4;
    state.pendingInteractions = [
      {
        runtime: state.projections["bundled-pi"].runtime,
        runtimeGeneration: 1,
        interactionId: "dialog-1",
        nativeSessionId: null,
        kind: "pi_extension_dialog",
        state: "pending",
      },
    ];
    expect(hostShadowQaLabel(state, false)).toBe(
      "P3 Host · Channel · 已恢复 1 · seq 4 · 待回复 1",
    );
  });
});
