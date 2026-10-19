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
import { applyUpdate } from "./session_projection";
import {
  hasActiveTools,
  hasActiveWork,
  toolActivityState,
} from "./session_types";
import { authenticationWorkBlockers } from "./auth_blockers";
import { AUTH_ACTIVITY_STRINGS as A } from "./auth_strings";

interface Wire {
  cwd: string;
  nativeSessionId: string;
  openToken: string;
  channel: { onmessage(event: unknown): void };
}
function seed() {
  const native = `observation-${++h.sequence}`;
  const state = threads.markOpenFailed(
    `observation:/owner:${native}`,
    "observation",
    "/owner",
    native,
    "retry",
  );
  state.connectionId = `prior-${native}`;
  state.items.push({
    kind: "agent",
    id: `prior-body-${native}`,
    text: "Prior complete body",
    streaming: false,
    time: 0,
  });
  applyUpdate(state, {
    sessionUpdate: "tool_call",
    toolCallId: "old-tool",
    title: "Prior command",
    status: "in_progress",
  });
  state.activeToolCallIds = ["old-tool"];
  state.connectionOutcomeUnknown = false;
  state.stopUnconfirmed = false;
  state.uncertainPrompt = null;
  return state;
}
function marker(wire: Wire) {
  wire.channel.onmessage({
    kind: "session_history_complete",
    openToken: wire.openToken,
  });
}
function open(state: ReturnType<typeof seed>) {
  return threads.open({
    agentId: state.agentId,
    cwd: state.cwd,
    nativeSessionId: state.nativeSessionId,
  });
}
beforeEach(() => vi.spyOn(draftPersistence, "flush").mockResolvedValue());
afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockReset();
});

it("keeps old tools unknown with a real replacement ID until this exact channel reports actual tool activity", async () => {
  const state = seed();
  const originalTools = state.activeToolCallIds;
  const originalBody = state.items[0];
  let wire!: Wire;
  h.invoke.mockImplementation(async (name, value: Wire) => {
    if (name !== "session_open") return [];
    wire = value;
    marker(wire);
    return {
      cwd: wire.cwd,
      nativeSessionId: wire.nativeSessionId,
      connectionId: `actual-${wire.nativeSessionId}`,
      resumed: true,
      configOptions: [],
      warnings: [],
    } satisfies OpenResult;
  });
  await expect(open(state)).rejects.toBeTruthy();
  expect(state.connectionId).toBe(`actual-${state.nativeSessionId}`);
  expect(state.activeToolCallIds).toBe(originalTools);
  const old = state.items.find((item) => item.kind === "tool");
  if (old?.kind !== "tool") throw new Error("Missing original tool evidence");
  expect(hasActiveTools(state)).toBe(false);
  expect(toolActivityState(state, old.call)).toBe("unknown");
  expect(hasActiveWork(state)).toBe(true);
  expect(authenticationWorkBlockers(state.agentId, [state])[0]?.reason).toBe(
    A.workUnknown,
  );
  const forged = {
    kind: "toolActivity",
    toolCallIds: ["old-tool"],
    update: { sessionUpdate: "future-colliding-activity" },
  };
  wire.channel.onmessage(forged);
  expect(hasActiveTools(state)).toBe(false);
  expect(toolActivityState(state, old.call)).toBe("unknown");
  const text = {
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "Actual following must not repair old body",
      },
    },
  };
  wire.channel.onmessage(text);
  expect(state.items[0]).toBe(originalBody);
  expect(
    state.items
      .filter((item) => item.kind === "agent")
      .map((item) => item.text),
  ).toEqual(["Prior complete body"]);
  expect(
    state.items.some((item) => item.kind === "raw" && item.update === text),
  ).toBe(true);
  wire.channel.onmessage({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "new-live-tool",
      title: "Actual new work",
      status: "in_progress",
    },
  });
  expect(hasActiveTools(state)).toBe(false);
  wire.channel.onmessage({
    kind: "toolActivity",
    toolCallIds: ["new-live-tool"],
  });
  expect(hasActiveTools(state)).toBe(true);
  const actual = state.items.find(
    (item) => item.kind === "tool" && item.call.toolCallId === "new-live-tool",
  );
  if (actual?.kind !== "tool") throw new Error("Missing actual live tool");
  expect(toolActivityState(state, actual.call)).toBe("active");
  expect(toolActivityState(state, old.call)).toBe("unknown");
  expect(old.call.status).toBe("in_progress");
  wire.channel.onmessage({ kind: "toolActivity", toolCallIds: [] });
  expect(hasActiveTools(state)).toBe(false);
  expect(hasActiveWork(state)).toBe(false);
  expect(state.historyUnavailable?.reason).toBe("empty");
  expect(state.connectionOutcomeUnknown).toBe(false);
  expect(
    h.invoke.mock.calls.some(([name]) =>
      ["session_prompt", "session_set_config", "session_fork_current"].includes(
        name,
      ),
    ),
  ).toBe(false);
});

it("does not borrow an old connection ID to admit following from a reply that omitted its actual connection identity", async () => {
  const state = seed();
  const originalItems = state.items.slice();
  const originalTools = state.activeToolCallIds;
  let wire!: Wire;
  h.invoke.mockImplementation(async (name, value: Wire) => {
    if (name !== "session_open") return [];
    wire = value;
    marker(wire);
    wire.channel.onmessage({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "UNCONFIRMED_REPAIR" },
      },
    });
    wire.channel.onmessage({
      update: { sessionUpdate: "future-missing-owner" },
    });
    wire.channel.onmessage({
      kind: "toolActivity",
      toolCallIds: ["not-owned"],
    });
    return {
      cwd: wire.cwd,
      nativeSessionId: wire.nativeSessionId,
      resumed: true,
      configOptions: [],
      warnings: [],
    } satisfies OpenResult;
  });
  await expect(open(state)).rejects.toBeTruthy();
  expect(state.items).toEqual(originalItems);
  expect(state.items[0]).toBe(originalItems[0]);
  expect(state.items[1]).toBe(originalItems[1]);
  expect(state.activeToolCallIds).toBe(originalTools);
  wire.channel.onmessage({
    update: { sessionUpdate: "future-late-missing-owner" },
  });
  wire.channel.onmessage({
    kind: "toolActivity",
    toolCallIds: ["still-not-owned"],
  });
  expect(state.items).toEqual(originalItems);
  expect(state.activeToolCallIds).toBe(originalTools);
  expect(hasActiveTools(state)).toBe(false);
  wire.channel.onmessage({ kind: "connectionLost", closeReason: "unexpected" });
  expect(state.connectionLost).toBe(true);
  expect(state.connectionCloseReason).toBe("unexpected");
  expect(state.historyUnavailable?.reason).toBe("empty");
  expect(
    h.invoke.mock.calls.some(([name]) =>
      ["session_prompt", "session_set_config", "session_fork_current"].includes(
        name,
      ),
    ),
  ).toBe(false);
});
