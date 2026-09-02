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
  it("distinguishes connection, unavailable, comparing, and passing states", () => {
    expect(hostShadowQaLabel(null, false)).toBe("P3 Host · 正在连接");
    expect(hostShadowQaLabel(null, true)).toBe("P3 Host · Channel 不可用");

    const comparing = createHostShadowState(initial);
    comparing.transportParity = {
      matched: 2,
      unmatchedChannel: 1,
      unmatchedPolling: 0,
      trackedFingerprints: 1,
      evictedFingerprints: 0,
    };
    expect(hostShadowQaLabel(comparing, false)).toContain(
      "已配平 2 · Channel 1 / Polling 0",
    );

    comparing.latestSequence = 3;
    comparing.transportParity = {
      ...comparing.transportParity,
      matched: 3,
      unmatchedChannel: 0,
      trackedFingerprints: 0,
    };
    expect(hostShadowQaLabel(comparing, false)).toBe(
      "P3 Host · 已配平 3 · seq 3",
    );
  });

  it("prioritizes reconciliation evidence over transient parity", () => {
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
    state.transportParity.matched = 4;
    state.latestSequence = 4;
    expect(hostShadowQaLabel(state, false)).toBe(
      "P3 Host · 已恢复 1 · 已配平 4 · seq 4",
    );
  });
});
