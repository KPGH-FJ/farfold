import { describe, expect, it, vi } from "vitest";
import { SuccessNotifications } from "./success_notification";
import {
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
} from "./session_projection";
import { receiveAsyncTasks } from "./async_tasks";
import type { CompletionEvent } from "./completion";

const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
function fixture() {
  const s = freshThreadState("key", "agent", "/own", "session");
  s.connectionId = "connection";
  s.running = true;
  const notify = vi.fn();
  const current = vi.fn(() => true);
  const controller = new SuccessNotifications(notify);
  controller.begin(s, current);
  const observe = (event: unknown, project: () => void, live = true) => {
    controller.observe(s, event, live);
    project();
  };
  const update = (value: Record<string, unknown>) =>
    observe({ update: value }, () => applyUpdate(s, value));
  const reply = () =>
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Result" },
    });
  const end = (
    event: CompletionEvent = { stopReason: "end_turn" },
    live = true,
  ) =>
    observe({ kind: "turnEnd", ...event }, () => applyTurnEnd(s, event), live);
  const task = (state: string, id = "task") => {
    const event = {
      kind: "asyncTasks",
      connectionId: s.connectionId,
      sessionId: s.nativeSessionId,
      supported: true,
      overflow: false,
      tasks: [
        {
          asyncTaskId: id,
          name: "Task",
          taskType: "shell",
          toolCallId: null,
          canStop: true,
          state,
          stopRequest: "idle",
        },
      ],
    };
    observe(event, () => {
      expect(receiveAsyncTasks(s, event)).toBe(true);
    });
  };
  return { s, notify, current, controller, observe, update, reply, end, task };
}

describe("actual live successful work eligibility", () => {
  it("uses a projected live ending and never reply text alone or a repeated ending", async () => {
    const f = fixture();
    f.reply();
    await tick();
    expect(f.notify).not.toHaveBeenCalled();
    f.end();
    await tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
    f.end();
    f.controller.check(f.s);
    await tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify.mock.calls[0][2]()).toBe(true);
  });
  it.each<CompletionEvent>([
    { stopReason: "cancelled" },
    { stopReason: "refusal" },
    { stopReason: "max_tokens" },
    { stopReason: "max_turn_requests" },
    { stopReason: "future" },
    {},
    { stopReason: "end_turn", error: "failure" },
    { stopReason: "end_turn", failure: { category: "service" } },
  ])("never reports non-success official terminal %j", async (event) => {
    const f = fixture();
    f.reply();
    f.end(event);
    await tick();
    expect(f.notify).not.toHaveBeenCalled();
  });
  it("rejects history, empty endings and replay without a real local send owner", async () => {
    const f = fixture();
    f.reply();
    f.end({ stopReason: "end_turn" }, false);
    await tick();
    f.controller.check(f.s);
    expect(f.notify).not.toHaveBeenCalled();
    const empty = fixture();
    empty.end();
    await tick();
    expect(empty.notify).not.toHaveBeenCalled();
    const notify = vi.fn();
    const controller = new SuccessNotifications(notify);
    controller.observe(f.s, { kind: "turnEnd", stopReason: "end_turn" }, true);
    await tick();
    expect(notify).not.toHaveBeenCalled();
  });
  it.each(["failed", "pending", "in_progress", "future"])(
    "reply cannot hide %s tool",
    async (status) => {
      const f = fixture();
      f.reply();
      f.update({
        sessionUpdate: "tool_call",
        toolCallId: "t",
        kind: "execute",
        status,
      });
      f.end();
      await tick();
      expect(f.notify).not.toHaveBeenCalled();
    },
  );
  it("allows successful no-output tools only after actual completion and active IDs clear", async () => {
    const f = fixture();
    f.update({
      sessionUpdate: "tool_call",
      toolCallId: "t",
      kind: "execute",
      status: "in_progress",
    });
    f.s.activeToolCallIds = ["t"];
    f.end();
    await tick();
    expect(f.notify).not.toHaveBeenCalled();
    f.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "completed",
    });
    await tick();
    expect(f.notify).not.toHaveBeenCalled();
    f.observe({ kind: "toolActivity", toolCallIds: [] }, () => {
      f.s.activeToolCallIds = [];
    });
    await tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
  });
  it.each(["unknown", "failed", "stopped"])(
    "never treats async %s as successful",
    async (state) => {
      const f = fixture();
      f.task(state);
      f.reply();
      f.end();
      await tick();
      expect(f.notify).not.toHaveBeenCalled();
    },
  );
  it("waits for exact async completion, and a missing task does not manufacture its completion", async () => {
    const f = fixture();
    f.task("running");
    f.reply();
    f.end();
    await tick();
    expect(f.notify).not.toHaveBeenCalled();
    f.s.asyncTasks!.tasks = [];
    f.controller.check(f.s);
    expect(f.notify).not.toHaveBeenCalled();
    f.task("completed");
    await tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
  });
  it("does not carry prior terminal tasks into a fresh request, but keeps prior active tasks", async () => {
    const f = fixture();
    f.task("failed", "old");
    await tick();
    f.controller.begin(f.s, f.current);
    f.reply();
    f.end();
    await tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
    const g = fixture();
    g.task("running", "old");
    await tick();
    g.controller.begin(g.s, g.current);
    g.reply();
    g.end();
    await tick();
    expect(g.notify).not.toHaveBeenCalled();
  });
  it.each(["owner", "connection", "base", "lost"])(
    "retires %s before deferred eligibility",
    async (change) => {
      const f = fixture();
      f.reply();
      f.end();
      if (change === "owner") f.current.mockReturnValue(false);
      else if (change === "connection") f.s.connectionId = "next";
      else if (change === "base") f.s.roundItemBase = f.s.items.length;
      else f.s.connectionLost = true;
      await tick();
      expect(f.notify).not.toHaveBeenCalled();
    },
  );
  it("rechecks tasks even after eligibility while the notification waits on preferences", async () => {
    const f = fixture();
    f.reply();
    f.end();
    await tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
    f.task("running");
    await tick();
    expect(f.notify.mock.calls[0][2]()).toBe(false);
  });
  it("process-ended clearing is not success, and a replacement send cannot receive the old completion", async () => {
    const f = fixture();
    f.reply();
    f.s.activeToolCallIds = ["t"];
    f.end();
    await tick();
    f.observe(
      { kind: "toolActivity", reason: "process_ended", toolCallIds: [] },
      () => {
        f.s.activeToolCallIds = [];
      },
    );
    await tick();
    expect(f.notify).not.toHaveBeenCalled();
    const g = fixture();
    g.reply();
    g.end();
    g.s.roundItemBase = g.s.items.length;
    g.s.running = true;
    g.controller.begin(g.s, g.current);
    await tick();
    expect(g.notify).not.toHaveBeenCalled();
  });
  it("clearing a carried live tool ID alone cannot hide its unconfirmed card", async () => {
    const f = fixture();
    f.update({
      sessionUpdate: "tool_call",
      toolCallId: "old",
      kind: "execute",
      status: "in_progress",
    });
    f.s.activeToolCallIds = ["old"];
    f.s.roundItemBase = f.s.items.length;
    f.controller.begin(f.s, f.current);
    f.reply();
    f.end();
    await tick();
    f.observe({ kind: "toolActivity", toolCallIds: [] }, () => {
      f.s.activeToolCallIds = [];
    });
    await tick();
    expect(f.notify).not.toHaveBeenCalled();
    f.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "old",
      status: "completed",
    });
    await tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
  });
});
