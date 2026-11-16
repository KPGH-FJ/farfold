import { expect, it } from "vitest";
import {
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
} from "./session_projection";
import { stoppedWorkTarget, applyStoppedWorkClose } from "./stopped_work_close";
import { toolActivityState } from "./session_types";
import { updateConversationBlocker } from "./update_impact";

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
