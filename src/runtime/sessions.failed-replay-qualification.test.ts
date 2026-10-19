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
import { archiveActivity } from "./archive_activity";
import { applyUpdate } from "./session_projection";
import {
  hasActiveTools,
  hasActiveWork,
  toolActivityState,
} from "./session_types";
import { updateConversationBlocker, UPDATE_IMPACT } from "./update_impact";

interface Wire {
  cwd: string;
  nativeSessionId: string;
  openToken: string;
  channel: { onmessage(event: unknown): void };
}

async function failedOwner() {
  const native = `qualification-${++h.sequence}`;
  const state = threads.markOpenFailed(
    `qualification:/owner:${native}`,
    "qualification",
    "/owner",
    native,
    "retry",
  );
  state.connectionId = `prior-${native}`;
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
  let wire!: Wire;
  h.invoke.mockImplementation(async (name, value: Wire) => {
    if (name !== "session_open") return [];
    wire = value;
    wire.channel.onmessage({
      kind: "session_history_complete",
      openToken: wire.openToken,
    });
    return {
      cwd: wire.cwd,
      nativeSessionId: wire.nativeSessionId,
      connectionId: `actual-${native}`,
      resumed: true,
      configOptions: [],
      warnings: [],
    } satisfies OpenResult;
  });
  await expect(
    threads.open({
      agentId: state.agentId,
      cwd: state.cwd,
      nativeSessionId: native,
    }),
  ).rejects.toBeTruthy();
  return { state, receive: (event: unknown) => wire.channel.onmessage(event) };
}

beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.spyOn(archiveActivity, "finish").mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockReset();
});

it("does not turn invalid activity ID arrays into proof of either active or idle replacement work", async () => {
  const { state, receive } = await failedOwner();
  const original = state.activeToolCallIds;
  const old = state.items.find((item) => item.kind === "tool");
  if (old?.kind !== "tool") throw new Error("Missing original tool evidence");
  for (const toolCallIds of [[null, 42], ["old-tool", null], "old-tool"]) {
    const invalid = { kind: "toolActivity", toolCallIds };
    receive(invalid);
    expect(state.activeToolCallIds).toBe(original);
    expect(state.activeToolCallIds).toEqual(["old-tool"]);
    expect(hasActiveTools(state)).toBe(false);
    expect(hasActiveWork(state)).toBe(true);
    expect(toolActivityState(state, old.call)).toBe("unknown");
    expect(updateConversationBlocker(state)).toBe(UPDATE_IMPACT.unknown);
    expect(
      state.items.some(
        (item) => item.kind === "raw" && item.update === invalid,
      ),
    ).toBe(true);
  }
  receive({ kind: "toolActivity", toolCallIds: [] });
  expect(state.activeToolCallIds).toEqual([]);
  expect(hasActiveWork(state)).toBe(false);
  expect(updateConversationBlocker(state)).toBe(null);
  expect(state.historyUnavailable?.reason).toBe("empty");
});

it("keeps old tool uncertainty protected through unrelated activity and keeps independent async work visible", async () => {
  const { state, receive } = await failedOwner();
  const old = state.items.find((item) => item.kind === "tool");
  if (old?.kind !== "tool") throw new Error("Missing original tool evidence");
  state.items.push({
    kind: "settled",
    id: "prior-ending",
    status: "stopped",
    stopReason: "cancelled",
    diffCount: 0,
    artifactCount: 0,
    replyReceived: true,
    time: 0,
  });
  receive({
    kind: "compactionActivity",
    connectionId: state.connectionId,
    sessionId: state.nativeSessionId,
    compactionIds: [],
    uncertain: false,
  });
  expect(archiveActivity.finish).not.toHaveBeenCalled();
  receive({
    kind: "asyncTasks",
    connectionId: state.connectionId,
    sessionId: state.nativeSessionId,
    supported: true,
    overflow: false,
    tasks: [
      {
        asyncTaskId: "actual-task",
        name: "Actual task",
        taskType: "command",
        toolCallId: null,
        canStop: false,
        state: "running",
        stopRequest: "idle",
      },
    ],
  });
  expect(hasActiveTools(state)).toBe(true);
  expect(hasActiveWork(state)).toBe(true);
  expect(toolActivityState(state, old.call)).toBe("unknown");
  expect(updateConversationBlocker(state)).toBe(UPDATE_IMPACT.unknown);
  expect(archiveActivity.finish).not.toHaveBeenCalled();
  receive({ kind: "toolActivity", toolCallIds: [] });
  expect(hasActiveTools(state)).toBe(true);
  expect(hasActiveWork(state)).toBe(true);
  expect(archiveActivity.finish).not.toHaveBeenCalled();
  receive({
    kind: "asyncTasks",
    connectionId: state.connectionId,
    sessionId: state.nativeSessionId,
    supported: true,
    overflow: false,
    tasks: [],
  });
  expect(hasActiveTools(state)).toBe(false);
  expect(hasActiveWork(state)).toBe(false);
  expect(archiveActivity.finish).toHaveBeenCalledExactlyOnceWith(state.key);
  expect(old.call.status).toBe("in_progress");
});
