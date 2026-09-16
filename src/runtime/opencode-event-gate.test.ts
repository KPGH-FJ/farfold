import { describe, expect, it } from "vitest";
import {
  gateOpenCodeWorkspaceEvent,
  OpenCodeAcpOpeningEvents,
} from "./opencode-event-gate";
import type { HostRoutedEvent, HostRoutedEventBinding } from "./host-shadow";
import type { OpenCodeAcpStatus } from "./opencode-acp";
import type { OpenCodeEnvelope } from "./opencode";

const binding: HostRoutedEventBinding = {
  runtime: {
    productId: "opencode",
    installationId: "opencode-acp-system",
    adapterId: "opencode-acp-stdio-v1",
  },
  runtimeBuildId: "opencode-acp-build",
  connectionId: "opencode-acp-connection",
  runtimeGeneration: 12,
};

function routed(runtimeGeneration: number): HostRoutedEvent {
  return {
    streamId: "stream-1",
    runtime: binding.runtime,
    runtimeBuildId: binding.runtimeBuildId,
    connectionId: binding.connectionId,
    runtimeGeneration,
    kind: "acp",
    nativeEnvelope: {},
    preservation: "native",
    sequence: 9,
    receivedAtMs: 1_760_000_000,
  };
}

function acpEvent(generation: number): OpenCodeEnvelope {
  return {
    generation,
    kind: "acp",
    runtime: binding.runtime,
    payload: { method: "session/update", params: {} },
  };
}

const acpStatus: OpenCodeAcpStatus = {
  state: "running",
  running: true,
  generation: 12,
  runtime: binding.runtime,
  runtimeBuildId: binding.runtimeBuildId,
  runtimeConnectionId: binding.connectionId,
  cwd: "/tmp/project",
  binaryPath: "/usr/local/bin/opencode",
  agentName: "opencode",
  agentVersion: "1.18.30",
  protocolVersion: 1,
  questionBridge: false,
  loadSession: true,
  configOptions: [],
  managedProvider: null,
  sessionId: "native-1",
  lastError: null,
  droppedEvents: 0,
  initializedAtMs: 1_760_000_001,
};

describe("OpenCode workspace event gate", () => {
  it("holds early load history until the new connection generation is confirmed", () => {
    const opening = new OpenCodeAcpOpeningEvents();
    const target = { ...binding, runtimeGeneration: undefined };
    opening.begin(target);
    expect(opening.capture(acpEvent(11), routed(11))).toBe(true);
    expect(opening.capture(acpEvent(12), routed(12))).toBe(true);
    expect(
      opening.capture(acpEvent(12), { ...routed(12), connectionId: "other" }),
    ).toBe(false);
    expect(opening.finish(target, acpStatus)).toEqual({
      events: [acpEvent(12)],
      truncated: false,
    });
    expect(opening.capture(acpEvent(12), routed(12))).toBe(false);
  });

  it("reports bounded history overflow and clears failed opening state", () => {
    const opening = new OpenCodeAcpOpeningEvents();
    opening.begin(binding);
    for (let index = 0; index < 513; index++)
      opening.capture(acpEvent(12), routed(12));
    const result = opening.finish(binding, acpStatus);
    expect(result.events).toHaveLength(512);
    expect(result.truncated).toBe(true);
    opening.begin(binding);
    opening.capture(acpEvent(12), routed(12));
    opening.clear();
    expect(opening.finish(binding, acpStatus).events).toEqual([]);
  });

  it("rejects stale ACP events from the same native session generation boundary", () => {
    expect(
      gateOpenCodeWorkspaceEvent(
        acpEvent(11),
        routed(11),
        binding,
        12,
        acpStatus,
      ),
    ).toEqual({ accepted: false, runtimeGeneration: 12 });
    expect(
      gateOpenCodeWorkspaceEvent(
        acpEvent(12),
        routed(12),
        binding,
        12,
        acpStatus,
      ),
    ).toEqual({ accepted: true, runtimeGeneration: 12 });
  });
});
