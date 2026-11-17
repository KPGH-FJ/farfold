import { expect, it, vi } from "vitest";
import { draftPersistence } from "./drafts";
import {
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
} from "./session_projection";
import {
  stoppedWorkTarget,
  applyStoppedWorkClose,
  unconfirmedStopTarget,
  WorkConnectionClosures,
} from "./stopped_work_close";
import { toolActivityState } from "./session_types";
import { updateConversationBlocker } from "./update_impact";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {},
}));

function stopped() {
  const thread = freshThreadState("a:/p:A", "a", "/p", "A");
  thread.identity = "established";
  thread.connectionId = "old-owner";
  thread.running = true;
  thread.queued = [[{ type: "text", text: "待发" }]];
  applyUpdate(thread, {
    sessionUpdate: "tool_call",
    toolCallId: "awaited-tool",
    title: "Test command",
    status: "pending",
  });
  thread.activeToolCallIds = ["awaited-tool"];
  applyTurnEnd(thread, { stopReason: "cancelled" });
  return thread;
}

it("clears only the exact closed activity and retains history and paused input", () => {
  const thread = stopped();
  const target = stoppedWorkTarget(thread)!;
  const proof = { ...target, proofId: "1" };
  const oldItems = thread.items.slice();
  const oldQueue = thread.queued;
  expect(updateConversationBlocker(thread)).not.toBeNull();
  expect(applyStoppedWorkClose(thread, target, proof, proof)).toBe(true);
  expect(thread.items).toEqual(oldItems);
  const tool = thread.items.find((item) => item.kind === "tool");
  expect(tool?.call.status).toBe("pending");
  expect(toolActivityState(thread, tool!.call)).toBe("unknown");
  expect(thread.queued).toBe(oldQueue);
  expect(thread.queuePaused).toBe("stopped");
  expect(thread.connectionLost).toBe(true);
  expect(thread.connectionCloseReason).toBe("user");
  expect(thread.connectionOutcomeUnknown).toBe(false);
  expect(thread.historicalOutcomeUnknown).toBe(true);
  expect(updateConversationBlocker(thread)).toBeNull();
});

it.each(["stopped", "work_disabled"] as const)(
  "preserves protection when the owner, tool, or current work has changed (%s)",
  (pause) => {
    const thread = stopped();
    const target = stoppedWorkTarget(thread)!;
    const proof = { ...target, proofId: "1" };
    thread.queuePaused = pause;
    expect(
      applyStoppedWorkClose(thread, target, proof, {
        ...proof,
        toolCallId: "other-tool",
      }),
    ).toBe(false);
    expect(
      applyStoppedWorkClose(thread, target, proof, { ...proof, proofId: "2" }),
    ).toBe(false);
    thread.connectionId = "new-owner";
    expect(applyStoppedWorkClose(thread, target, proof, proof)).toBe(false);
    thread.connectionId = target.connectionId;
    thread.running = true;
    expect(applyStoppedWorkClose(thread, target, proof, proof)).toBe(false);
    applyTurnEnd(thread, { stopReason: "cancelled" });
    expect(stoppedWorkTarget(thread)?.turnItemId).not.toBe(target.turnItemId);
    thread.queuePaused = pause;
    expect(applyStoppedWorkClose(thread, target, proof, proof)).toBe(false);
    expect(thread.activeToolCallIds).toEqual(["awaited-tool"]);
    expect(thread.historicalOutcomeUnknown).toBeFalsy();
  },
);

function unconfirmed() {
  const thread = freshThreadState("a:/p:A", "a", "/p", "A");
  thread.connectionId = "old-owner";
  thread.identity = "established";
  thread.sessionOperations = {
    forkCurrentContext: false,
    closeAfterUnconfirmedStop: true,
  };
  thread.running = true;
  thread.stopUnconfirmed = true;
  thread.queuePaused = "uncertain";
  thread.queued = [[{ type: "text", text: "待发" }]];
  thread.items.push({
    kind: "user",
    id: "original-message",
    text: "original prompt",
    attachments: [],
    streaming: false,
    time: 1,
  });
  thread.roundItemBase = thread.items.length;
  return thread;
}

it.each([false, true])(
  "confirms only the official close and preserves any original result reported during it (%s)",
  async (lateTerminal) => {
    invoke.mockReset();
    const thread = unconfirmed();
    const queue = thread.queued;
    const publish = vi.fn();
    const delivery = {
      settle: vi.fn(async () => {
        if (lateTerminal) applyTurnEnd(thread, { stopReason: "cancelled" });
      }),
    };
    const actions = new WorkConnectionClosures(
      () => true,
      publish,
      () => delivery,
    );
    const target = unconfirmedStopTarget(thread)!;
    const proof = { sessionId: "A", connectionId: "old-owner", proofId: "9" };
    const flush = vi.spyOn(draftPersistence, "flush").mockResolvedValue();
    invoke.mockResolvedValue(proof);
    try {
      expect(await actions.check(thread, target)).toEqual(proof);
      expect(invoke).toHaveBeenCalledExactlyOnceWith(
        "session_check_unconfirmed_stop_close",
        { agentId: "a", cwd: "/p", sessionId: "A", connectionId: "old-owner" },
      );
      await actions.close(thread, target, proof);
      expect(flush).toHaveBeenCalledOnce();
      expect(delivery.settle).toHaveBeenCalledOnce();
      expect(invoke.mock.calls[1]).toEqual([
        "session_close_unconfirmed_stop",
        { agentId: "a", cwd: "/p", ...proof },
      ]);
      expect(thread.connectionLost).toBe(true);
      expect(thread.processEndedConnectionId).toBeUndefined();
      expect(thread.connectionOutcomeUnknown).toBe(false);
      expect(thread.historicalOutcomeUnknown).toBe(!lateTerminal);
      expect(thread.items.at(-1)).toMatchObject({
        kind: "settled",
        status: lateTerminal ? "stopped" : "unknown",
      });
      expect(thread.queued).toBe(queue);
      expect(thread.queuePaused).toBe("stopped");
      expect(publish).toHaveBeenCalledExactlyOnceWith(thread);
    } finally {
      flush.mockRestore();
    }
  },
);

it("invalidates the reviewed close when the original terminal arrives before confirmation", async () => {
  invoke.mockReset();
  const thread = unconfirmed();
  const actions = new WorkConnectionClosures(() => true, vi.fn());
  const target = unconfirmedStopTarget(thread)!;
  const proof = { sessionId: "A", connectionId: "old-owner", proofId: "9" };
  invoke.mockResolvedValue(proof);
  expect(await actions.check(thread, target)).toEqual(proof);
  applyTurnEnd(thread, { stopReason: "cancelled" });
  await expect(actions.close(thread, target, proof)).rejects.toThrow();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(thread.connectionLost).toBe(false);
});
