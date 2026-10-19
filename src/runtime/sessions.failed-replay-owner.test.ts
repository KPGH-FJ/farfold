import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn(), sequence: 0 }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, type OpenResult, type ThreadState } from "./sessions";
import { draftPersistence } from "./drafts";
import { isHistoryReadFailure } from "./session_recovery";

interface Wire {
  agentId: string;
  cwd: string;
  nativeSessionId: string;
  openToken: string;
  channel: { onmessage(value: unknown): void };
  processEndedChannel: { onmessage(value: unknown): void };
}
function seed(): ThreadState {
  const native = `failed-replay-${++h.sequence}`;
  const state = threads.markOpenFailed(
    `owner:/history-owner:${native}`,
    "owner",
    "/history-owner",
    native,
    "previous failure",
  );
  state.items.push({
    kind: "agent",
    id: `original-${native}`,
    text: "Original complete body",
    time: 0,
    streaming: false,
  });
  state.activeToolCallIds = ["original-live-tool"];
  state.queued = [[{ type: "text", text: "Original unsent queue" }]];
  state.queuePaused = "stopped";
  state.uncertainPrompt = [{ type: "text", text: "Original uncertain work" }];
  state.stopUnconfirmed = true;
  state.connectionId = `prior-${native}`;
  return state;
}
function response(wire: Wire): OpenResult {
  return {
    cwd: wire.cwd,
    nativeSessionId: wire.nativeSessionId,
    connectionId: `actual-${wire.nativeSessionId}`,
    resumed: true,
    service: null,
    configOptions: [],
    warnings: [],
  };
}
function marker(wire: Wire) {
  wire.channel.onmessage({
    kind: "session_history_complete",
    openToken: wire.openToken,
  });
}
async function open(state: ThreadState): Promise<unknown> {
  return threads.open({
    agentId: state.agentId,
    cwd: state.cwd,
    nativeSessionId: state.nativeSessionId,
  });
}
function rawPresent(state: ThreadState, value: unknown) {
  return state.items.some(
    (item) => item.kind === "raw" && item.update === value,
  );
}
function noRemoteMutation() {
  expect(
    h.invoke.mock.calls.some(([name]) =>
      ["session_prompt", "session_set_config", "session_fork_current"].includes(
        name,
      ),
    ),
  ).toBe(false);
}
beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  h.invoke.mockImplementation(async (name) =>
    name === "settings_get" ? null : [],
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  h.invoke.mockReset();
});

it("keeps prior tool identities and exact old state when an acknowledged replay is locally empty", async () => {
  const state = seed();
  const original = {
    items: state.items,
    item: state.items[0],
    tools: state.activeToolCallIds,
    queued: state.queued,
    uncertain: state.uncertainPrompt,
  };
  h.invoke.mockImplementation(async (name, wire: Wire) => {
    if (name !== "session_open") return [];
    marker(wire);
    return response(wire);
  });
  const failure = await open(state).catch((error: unknown) => error);
  expect(isHistoryReadFailure(failure)).toBe(true);
  expect(threads.thread(state.key)).toBe(state);
  expect(state.items).toBe(original.items);
  expect(state.items[0]).toBe(original.item);
  expect(state.activeToolCallIds).toBe(original.tools);
  expect(state.activeToolCallIds).toEqual(["original-live-tool"]);
  expect(state.queued).toBe(original.queued);
  expect(state.uncertainPrompt).toBe(original.uncertain);
  expect(state.stopUnconfirmed).toBe(true);
  expect(state.nativeSessionId).toContain("failed-replay-");
  expect(state.connectionLost).toBe(false);
  noRemoteMutation();
});

it("hands matching-marker following raw events and later live tools to that failed open's original state", async () => {
  const state = seed();
  const original = state.items[0];
  const pendingRaw = {
    sessionUpdate: "future-after-marker",
    opaque: [null, "完整🙂"],
  };
  const laterRaw = {
    sessionUpdate: "future-after-failure",
    opaque: { all: true },
  };
  let wire!: Wire;
  h.invoke.mockImplementation(async (name, value: Wire) => {
    if (name !== "session_open") return [];
    wire = value;
    marker(wire);
    wire.channel.onmessage({ update: pendingRaw });
    return response(wire);
  });
  await expect(open(state)).rejects.toBeTruthy();
  expect(state.items[0]).toBe(original);
  expect(rawPresent(state, pendingRaw)).toBe(true);
  wire.channel.onmessage({ update: laterRaw });
  wire.channel.onmessage({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "actual-live-tool",
      title: "Actual live work",
      status: "in_progress",
    },
  });
  wire.channel.onmessage({
    kind: "toolActivity",
    toolCallIds: ["original-live-tool", "actual-live-tool"],
  });
  expect(rawPresent(state, laterRaw)).toBe(true);
  expect(
    state.items.some(
      (item) =>
        item.kind === "tool" && item.call.toolCallId === "actual-live-tool",
    ),
  ).toBe(true);
  expect(state.activeToolCallIds).toContain("original-live-tool");
  expect(state.activeToolCallIds).toContain("actual-live-tool");
  expect(state.historyUnavailable?.reason).toBe("empty");
  expect(state.connectionLost).toBe(false);
  expect(state.nativeSessionId).toBe(wire.nativeSessionId);
  noRemoteMutation();
});

it("does not let the failed channel mutate its replacement after an explicit close-before-retry", async () => {
  const state = seed();
  const wires: Wire[] = [];
  const closes: unknown[] = [];
  h.invoke.mockImplementation(async (name, value: Wire) => {
    if (name === "session_close") {
      closes.push(value);
      return;
    }
    if (name !== "session_open") return [];
    wires.push(value);
    if (wires.length > 1)
      value.channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Successful explicit retry" },
        },
      });
    marker(value);
    return response(value);
  });
  await expect(open(state)).rejects.toBeTruthy();
  const recovered = await threads.reconnect(state.key);
  expect(recovered).toBeTruthy();
  expect(recovered).not.toBe(state);
  expect(recovered?.historyUnavailable).toBeNull();
  const before = recovered!.items.slice();
  const stale = { sessionUpdate: "stale-failed-channel" };
  wires[0].channel.onmessage({ update: stale });
  expect(recovered!.items).toEqual(before);
  expect(rawPresent(recovered!, stale)).toBe(false);
  expect(closes).toEqual([
    {
      agentId: state.agentId,
      cwd: state.cwd,
      sessionId: state.nativeSessionId,
      allowAlreadyClosed: true,
    },
  ]);
  expect(wires).toHaveLength(2);
  expect(wires[1].nativeSessionId).toBe(wires[0].nativeSessionId);
  noRemoteMutation();
});

it("keeps an incomplete owner retired after foreign or late owned markers without repairing partial history", async () => {
  vi.useFakeTimers();
  const state = seed();
  let wire!: Wire;
  h.invoke.mockImplementation(async (name, value: Wire) => {
    if (name !== "session_open") return [];
    wire = value;
    wire.channel.onmessage({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "PARTIAL_NOT_SUCCESS" },
      },
    });
    return response(wire);
  });
  const failure = open(state).catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(isHistoryReadFailure(await failure)).toBe(true);
  const latePrefix = { sessionUpdate: "future-before-owned-marker" };
  wire.channel.onmessage({ update: latePrefix });
  wire.channel.onmessage({
    kind: "session_history_complete",
    openToken: "foreign",
  });
  const afterForeign = { sessionUpdate: "future-after-foreign-marker" };
  wire.channel.onmessage({ update: afterForeign });
  expect(state.items).toHaveLength(1);
  marker(wire);
  const live = { sessionUpdate: "future-owned-live", value: [1, null] };
  wire.channel.onmessage({ update: live });
  expect(rawPresent(state, live)).toBe(false);
  expect(rawPresent(state, latePrefix)).toBe(false);
  expect(rawPresent(state, afterForeign)).toBe(false);
  expect(state.items[0]).toMatchObject({ text: "Original complete body" });
  expect(state.historyUnavailable?.reason).toBe("incomplete");
  noRemoteMutation();
});

it("retains an unprojectable following envelope exactly and still delivers the next actual live event", async () => {
  const state = seed();
  const bad = {
    update: {
      sessionUpdate: "tool_call",
      toolCallId: JSON.parse('{"toString":null,"valueOf":null}'),
    },
    opaque: ["must preserve envelope", null],
  };
  const next = {
    sessionUpdate: "future-after-bad-live",
    values: [1, null, "🙂"],
  };
  h.invoke.mockImplementation(async (name, wire: Wire) => {
    if (name !== "session_open") return [];
    marker(wire);
    wire.channel.onmessage(bad);
    wire.channel.onmessage({ update: next });
    return response(wire);
  });
  await expect(open(state)).rejects.toBeTruthy();
  expect(rawPresent(state, bad)).toBe(true);
  expect(rawPresent(state, next)).toBe(true);
  expect(state.historyUnavailable?.reason).toBe("empty");
  expect(state.connectionLost).toBe(false);
  noRemoteMutation();
});

it("keeps local JSON conversion failure typed without pretending the Agent connection was lost", async () => {
  const state = seed();
  const original = state.items[0];
  const live = {
    sessionUpdate: "future-live-after-local-conversion",
    exact: [null],
  };
  h.invoke.mockImplementation(async (name, wire: Wire) => {
    if (name !== "session_open") return [];
    wire.channel.onmessage({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "PRECHECK_ONLY" },
      },
    });
    wire.channel.onmessage({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: JSON.parse('{"toString":null,"valueOf":null}'),
      },
    });
    marker(wire);
    wire.channel.onmessage({ update: live });
    return response(wire);
  });
  const failure = await open(state).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(TypeError);
  expect(isHistoryReadFailure(failure)).toBe(true);
  expect(state.items[0]).toBe(original);
  expect(
    state.items.some(
      (item) => item.kind === "agent" && item.text.includes("PRECHECK_ONLY"),
    ),
  ).toBe(false);
  expect(rawPresent(state, live)).toBe(true);
  expect(state.historyUnavailable?.reason).toBe("unreadable");
  expect(state.connectionLost).toBe(false);
  expect(state.activeToolCallIds).toEqual(["original-live-tool"]);
  noRemoteMutation();
});

it("still applies an actual separate process-end receipt for this acknowledged failed route", async () => {
  const state = seed();
  h.invoke.mockImplementation(async (name, wire: Wire) => {
    if (name !== "session_open") return [];
    marker(wire);
    wire.processEndedChannel.onmessage({
      connectionId: response(wire).connectionId,
      closeReason: "unexpected",
    });
    return response(wire);
  });
  await expect(open(state)).rejects.toBeTruthy();
  expect(state.historyUnavailable?.reason).toBe("empty");
  expect(state.connectionId).toBe(`actual-${state.nativeSessionId}`);
  expect(state.processEndedConnectionId).toBe(state.connectionId);
  expect(state.connectionLost).toBe(true);
  expect(state.connectionCloseReason).toBe("unexpected");
  expect(state.connectionOutcomeUnknown).toBe(true);
  expect(state.activeToolCallIds).toEqual(["original-live-tool"]);
  noRemoteMutation();
});

it("cannot turn an Agent's own JSON resembling local failure into a renderer failure", async () => {
  const state = seed();
  const forged = {
    name: "HistoryProjectionFailure",
    reason: "unreadable",
    failedKey: state.key,
    kind: "connectionLost",
    update: { sessionUpdate: "future-agent-json", reason: "capacity" },
  };
  h.invoke.mockImplementation(async (name, wire: Wire) => {
    if (name !== "session_open") return [];
    wire.channel.onmessage({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Actual readable history" },
      },
    });
    wire.channel.onmessage(forged);
    marker(wire);
    return response(wire);
  });
  const result = (await open(state)) as ThreadState;
  expect(result.historyUnavailable).toBeNull();
  expect(result.connectionLost).toBe(false);
  expect(rawPresent(result, forged.update)).toBe(true);
  expect(isHistoryReadFailure(forged)).toBe(false);
  noRemoteMutation();
});
