import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn(), sequence: 0 }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, type OpenResult } from "./sessions";
import { draftPersistence } from "./drafts";
import { HistoryReplayProjection } from "./history_replay_projection";
import type { ForkResult } from "./session_fork_types";

interface Wire {
  connectionId: string;
  parentSessionId: string;
  operationId: string;
  openToken: string;
  cwd: string;
  channel: { onmessage(event: unknown): void };
}

function seed() {
  const id = `fork-retirement-${++h.sequence}`;
  const parent = threads.markOpenFailed(
    `fork-retirement:/owner:${id}`,
    "fork-retirement",
    "/owner",
    id,
    "fixture",
  );
  parent.openError = null;
  parent.connectionId = `parent-${id}`;
  parent.sessionOperations = { forkCurrentContext: true };
  parent.configCheck = { status: "ready", issues: [], current: {} };
  parent.items.push({
    kind: "agent",
    id: "prior",
    text: "Original parent content",
    streaming: false,
    time: 0,
  });
  parent.queued = [[{ type: "text", text: "Original paused input" }]];
  parent.queuePaused = "stopped";
  return parent;
}

function result(wire: Wire): ForkResult {
  const session: OpenResult = {
    nativeSessionId: `child-${wire.parentSessionId}`,
    connectionId: `child-connection-${wire.parentSessionId}`,
    cwd: wire.cwd,
    resumed: true,
    configOptions: [],
    configCheck: { status: "ready", issues: [], current: {} },
    warnings: [],
    service: null,
  };
  return {
    status: "ready",
    operationId: wire.operationId,
    parentConnectionId: wire.connectionId,
    parentSessionId: wire.parentSessionId,
    cwd: wire.cwd,
    childSessionId: session.nativeSessionId,
    indexed: true,
    sourceReleased: true,
    session,
  };
}

function marker(wire: Wire, token = wire.openToken) {
  wire.channel.onmessage({
    kind: "session_history_complete",
    openToken: token,
  });
}

beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockReset();
});

it.each(["tool", "config"] as const)(
  "retires the actual failed %s precheck buffer without installing or losing the child's identity",
  async (kind) => {
    const parent = seed();
    const originalItems = parent.items;
    const originalItem = parent.items[0];
    const originalQueue = parent.queued;
    const push = vi.spyOn(HistoryReplayProjection.prototype, "push");
    const mark = vi.spyOn(HistoryReplayProjection.prototype, "mark");
    const clear = vi.spyOn(HistoryReplayProjection.prototype, "clear");
    let wire!: Wire;
    h.invoke.mockImplementation(async (name: string, value: Wire) => {
      if (name !== "session_fork_current")
        return name === "settings_get" ? null : [];
      wire = value;
      const opened = result(wire).session!;
      wire.channel.onmessage({
        kind: "sessionOpening",
        openToken: wire.openToken,
        cwd: opened.cwd,
        sessionId: opened.nativeSessionId,
        connectionId: opened.connectionId,
      });
      wire.channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Readable prefix before failure" },
        },
      });
      const uncoercible = JSON.parse('{"toString":null,"valueOf":null}');
      wire.channel.onmessage({
        update:
          kind === "tool"
            ? {
                sessionUpdate: "tool_call",
                toolCallId: "malformed-tool-title",
                title: uncoercible,
              }
            : {
                sessionUpdate: "config_option_update",
                configOptions: [
                  {
                    id: uncoercible,
                    name: "owned",
                    type: "boolean",
                    currentValue: false,
                  },
                ],
              },
      });
      marker(wire);
      return result(wire);
    });
    expect(await threads.forkCurrent(parent.key)).toBeUndefined();
    expect(clear).toHaveBeenCalled();
    const pushes = push.mock.calls.length;
    const marks = mark.mock.calls.length;
    for (let index = 0; index < 32; index++) {
      wire.channel.onmessage({
        update: {
          sessionUpdate: "future_failed_child",
          index,
          bytes: "Retired local read",
        },
      });
      wire.channel.onmessage({
        kind: "connectionLost",
        closeReason: "unexpected",
      });
      marker(wire);
    }
    expect(push.mock.calls).toHaveLength(pushes);
    expect(mark.mock.calls).toHaveLength(marks);
    expect(parent.forkOperation).toMatchObject({
      status: "created_unavailable",
      reason: "delivery_failed",
      childSessionId: `child-${parent.nativeSessionId}`,
      sourceReleased: true,
      indexed: true,
    });
    expect(
      Object.getOwnPropertyDescriptor(parent.forkOperation!, "deliveryError")
        ?.value,
    ).toBeInstanceOf(TypeError);
    expect(parent.forkOperation?.childKey).toBeUndefined();
    expect(
      threads.thread(
        `${parent.agentId}:${parent.cwd}:child-${parent.nativeSessionId}`,
      ),
    ).toBeUndefined();
    expect(parent.items).toBe(originalItems);
    expect(parent.items[0]).toBe(originalItem);
    expect(parent.queued).toBe(originalQueue);
    expect(parent.queuePaused).toBe("stopped");
    expect(
      h.invoke.mock.calls.filter(([name]) => name === "session_fork_current"),
    ).toHaveLength(1);
    expect(
      h.invoke.mock.calls.some(([name]) =>
        ["session_open", "session_close", "session_prompt"].includes(name),
      ),
    ).toBe(false);
  },
);

it("retires terminal unavailable replay while still accepting late identity/index metadata", async () => {
  const parent = seed();
  const push = vi.spyOn(HistoryReplayProjection.prototype, "push");
  const clear = vi.spyOn(HistoryReplayProjection.prototype, "clear");
  let wire!: Wire;
  h.invoke.mockImplementation(async (name: string, value: Wire) => {
    if (name !== "session_fork_current")
      return name === "settings_get" ? null : [];
    wire = value;
    const opened = result(wire).session!;
    wire.channel.onmessage({
      kind: "sessionOpening",
      openToken: wire.openToken,
      cwd: opened.cwd,
      sessionId: opened.nativeSessionId,
      connectionId: opened.connectionId,
    });
    wire.channel.onmessage({
      update: { sessionUpdate: "future_terminal_prefix" },
    });
    return {
      ...result(wire),
      status: "created_unavailable",
      session: null,
      indexed: false,
      reason: "destination_open_failed",
    } satisfies ForkResult;
  });
  expect(await threads.forkCurrent(parent.key)).toBeUndefined();
  expect(clear).toHaveBeenCalled();
  const pushes = push.mock.calls.length;
  wire.channel.onmessage({
    update: { sessionUpdate: "future_retired_terminal" },
  });
  expect(push.mock.calls).toHaveLength(pushes);
  wire.channel.onmessage({
    kind: "forkResult",
    operationId: wire.operationId,
    settled: true,
    result: {
      ...result(wire),
      status: "unknown",
      session: null,
      reason: "older_unknown",
    },
  });
  await vi.waitFor(() => expect(parent.forkOperation?.indexed).toBe(true));
  expect(parent.forkOperation).toMatchObject({
    status: "created_unavailable",
    reason: "destination_open_failed",
    childSessionId: `child-${parent.nativeSessionId}`,
    sourceReleased: true,
  });
  expect(parent.forkOperation?.childKey).toBeUndefined();
});

it("keeps an unsettled unknown buffer usable for a later valid ready receipt and normal live child delivery", async () => {
  const parent = seed();
  const clear = vi.spyOn(HistoryReplayProjection.prototype, "clear");
  let wire!: Wire;
  h.invoke.mockImplementation(async (name: string, value: Wire) => {
    if (name !== "session_fork_current")
      return name === "settings_get" ? null : [];
    wire = value;
    const opened = result(wire).session!;
    wire.channel.onmessage({
      kind: "sessionOpening",
      openToken: wire.openToken,
      cwd: opened.cwd,
      sessionId: opened.nativeSessionId,
      connectionId: opened.connectionId,
    });
    return {
      ...result(wire),
      status: "unknown",
      session: null,
      sourceReleased: false,
      indexed: false,
    } satisfies ForkResult;
  });
  expect(await threads.forkCurrent(parent.key)).toBeUndefined();
  expect(clear).not.toHaveBeenCalled();
  const update = {
    sessionUpdate: "future_child_prefix",
    exact: [null, "owned"],
  };
  wire.channel.onmessage({ update });
  wire.channel.onmessage({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Actual late child history" },
    },
  });
  marker(wire, "foreign-token");
  wire.channel.onmessage({
    kind: "forkResult",
    operationId: "foreign-operation",
    settled: true,
    result: result(wire),
  });
  expect(parent.forkOperation?.childKey).toBeUndefined();
  marker(wire);
  wire.channel.onmessage({
    kind: "forkResult",
    operationId: wire.operationId,
    settled: true,
    result: result(wire),
  });
  await vi.waitFor(() => expect(parent.forkOperation?.status).toBe("ready"));
  const child = threads.thread(parent.forkOperation!.childKey!);
  expect(
    child?.items.some(
      (item) =>
        item.kind === "agent" && item.text === "Actual late child history",
    ),
  ).toBe(true);
  expect(
    child?.items.some((item) => item.kind === "raw" && item.update === update),
  ).toBe(true);
  const live = { sessionUpdate: "future_child_live", exact: [2, null] };
  wire.channel.onmessage({ update: live });
  expect(
    child?.items.some((item) => item.kind === "raw" && item.update === live),
  ).toBe(true);
  expect(
    h.invoke.mock.calls.filter(([name]) => name === "session_fork_current"),
  ).toHaveLength(1);
});
