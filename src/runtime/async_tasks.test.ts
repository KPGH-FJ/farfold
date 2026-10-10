import { afterEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { invoke } from "@tauri-apps/api/core";
import {
  freshThreadState,
  applyConnectionLost,
  applyUpdate,
} from "./session_projection";
import {
  receiveAsyncTasks,
  hasAsyncTasks,
  canStopAsyncTask,
} from "./async_tasks";
import { stopAsyncTask } from "./async_task_actions";
import { hasActiveTools } from "./session_types";
import { configChangeBusy } from "./protected_config";
import { updateConversationBlocker } from "./update_impact";

function setup() {
  const thread = freshThreadState(
    "task-view",
    "fixture",
    "/controlled",
    "native",
  );
  thread.connectionId = "connection";
  const event = {
    kind: "asyncTasks",
    connectionId: "connection",
    sessionId: "native",
    supported: true,
    overflow: false,
    tasks: [
      {
        asyncTaskId: "exact-task",
        name: "A task",
        taskType: "shell",
        toolCallId: "original-tool",
        canStop: true,
        state: "running",
        stopRequest: "idle",
      },
    ],
  };
  expect(receiveAsyncTasks(thread, event)).toBe(true);
  return { thread, event, task: thread.asyncTasks!.tasks[0]! };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it.each(["accepted", "rejected", "unknown"])(
  "records %s receipt without rewriting task, tool, turn, or queue",
  async (status) => {
    const { thread, task } = setup();
    thread.queuePaused = "stopped";
    thread.queued = [[{ type: "text", text: "Keep queued" }]];
    thread.items.push({
      kind: "settled",
      id: "end",
      status: "stopped",
      diffCount: 0,
      artifactCount: 0,
      time: 1,
    });
    const before = structuredClone({
      items: thread.items,
      queued: thread.queued,
    });
    vi.mocked(invoke).mockResolvedValue({
      connectionId: "connection",
      sessionId: "native",
      asyncTaskId: "exact-task",
      status,
    });
    await stopAsyncTask(thread, task, () => thread, vi.fn());
    expect(invoke).toHaveBeenCalledExactlyOnceWith("session_stop_task", {
      agentId: "fixture",
      cwd: "/controlled",
      sessionId: "native",
      connectionId: "connection",
      taskId: "exact-task",
    });
    expect(task.stopRequest).toBe(status);
    expect(task.state).toBe("running");
    expect({ items: thread.items, queued: thread.queued }).toEqual(before);
    expect(thread.queuePaused).toBe("stopped");
    expect(hasActiveTools(thread)).toBe(true);
    expect(configChangeBusy(thread)).toBe(true);
    expect(updateConversationBlocker(thread)).not.toBeNull();
  },
);

it("permits one current task request; cloned task, old connection and duplicate clicks cannot dispatch", async () => {
  const { thread, task } = setup();
  let resolve!: (v: unknown) => void;
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }) as never,
  );
  await stopAsyncTask(thread, { ...task }, () => thread, vi.fn());
  const flight = stopAsyncTask(thread, task, () => thread, vi.fn());
  await stopAsyncTask(thread, task, () => thread, vi.fn());
  expect(invoke).toHaveBeenCalledTimes(1);
  thread.connectionId = "replacement";
  resolve({
    connectionId: "connection",
    sessionId: "native",
    asyncTaskId: "exact-task",
    status: "accepted",
  });
  await flight;
  expect(task.stopRequest).toBe("requested");
  expect(canStopAsyncTask(thread, task)).toBe(false);
});

it("times out to unknown while preserving actual work, then accepts a late matching receipt without inventing a task end", async () => {
  vi.useFakeTimers();
  const { thread, task } = setup();
  let resolve!: (v: unknown) => void;
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }) as never,
  );
  const flight = stopAsyncTask(thread, task, () => thread, vi.fn());
  await vi.advanceTimersByTimeAsync(11_000);
  expect(task.stopRequest).toBe("unknown");
  expect(task.state).toBe("running");
  expect(canStopAsyncTask(thread, task)).toBe(false);
  resolve({
    connectionId: "connection",
    sessionId: "native",
    asyncTaskId: "exact-task",
    status: "accepted",
  });
  await flight;
  expect(task.stopRequest).toBe("accepted");
  expect(task.state).toBe("running");
});

it("lets a terminal event outrank the earlier stop response and rejects stale task objects", async () => {
  const { thread, event, task } = setup();
  let resolve!: (v: unknown) => void;
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }) as never,
  );
  const flight = stopAsyncTask(thread, task, () => thread, vi.fn());
  event.tasks[0]!.state = "completed";
  expect(receiveAsyncTasks(thread, event)).toBe(true);
  resolve({
    connectionId: "connection",
    sessionId: "native",
    asyncTaskId: "exact-task",
    status: "accepted",
  });
  await flight;
  expect(thread.asyncTasks!.tasks[0]!.state).toBe("completed");
  expect(hasActiveTools(thread)).toBe(false);
  expect(canStopAsyncTask(thread, task)).toBe(false);
});

it("connection loss retains work as unknown and disables control instead of completing it", () => {
  const { thread, task, event } = setup();
  applyConnectionLost(thread);
  expect(thread.connectionOutcomeUnknown).toBe(true);
  expect(task.state).toBe("running");
  expect(canStopAsyncTask(thread, task)).toBe(false);
  expect(hasAsyncTasks(thread)).toBe(true);
  expect(receiveAsyncTasks(thread, event)).toBe(false);
  expect(updateConversationBlocker(thread)).not.toBeNull();
});

it("keeps raw historical extensions but never grants a live control from replay", () => {
  const { thread } = setup();
  delete thread.asyncTasks;
  const raw = {
    sessionUpdate: "async_task_spawned",
    asyncTaskId: "exact-task",
    name: "history",
    taskType: "shell",
    canStop: true,
  };
  applyUpdate(thread, raw);
  expect(thread.items.some((i) => i.kind === "raw" && i.update === raw)).toBe(
    true,
  );
  expect(thread.asyncTasks).toBeUndefined();
  expect(hasAsyncTasks(thread)).toBe(false);
});

it.each([
  { connectionId: "old" },
  { sessionId: "other" },
  { supported: false },
  { tasks: [{ state: ["running"] }] },
  { tasks: [{ stopRequest: ["accepted"] }] },
  { tasks: [{ asyncTaskId: 123 }] },
  { tasks: [{ toolCallId: [] }] },
])("rejects malformed/foreign live event atomically: %j", (patch) => {
  const { thread, event } = setup();
  const old = thread.asyncTasks;
  const changed = {
    ...event,
    ...patch,
    tasks: patch.tasks
      ? patch.tasks.map((t) => ({ ...event.tasks[0], ...t }))
      : event.tasks,
  };
  expect(receiveAsyncTasks(thread, changed)).toBe(false);
  expect(thread.asyncTasks).toBe(old);
});
it("rejects duplicate IDs and a coercible status receipt", async () => {
  const { thread, event, task } = setup();
  expect(
    receiveAsyncTasks(thread, {
      ...event,
      tasks: [...event.tasks, ...event.tasks],
    }),
  ).toBe(false);
  vi.mocked(invoke).mockResolvedValue({
    connectionId: "connection",
    sessionId: "native",
    asyncTaskId: "exact-task",
    status: ["accepted"],
  });
  await stopAsyncTask(thread, task, () => thread, vi.fn());
  expect(task.stopRequest).toBe("unknown");
});

it.each(["thread", "session", "lost"])(
  "does not dispatch after synchronous %s retirement during pending publication",
  async (mode) => {
    const { thread, task } = setup();
    let current = thread;
    await stopAsyncTask(
      thread,
      task,
      () => current,
      () => {
        if (mode === "thread") current = { ...thread };
        else if (mode === "session") thread.nativeSessionId = "other";
        else thread.connectionLost = true;
      },
    );
    expect(invoke).not.toHaveBeenCalled();
  },
);

it("actual channel keeps cancelled reply/queued draft independent from task acknowledgements and terminal events", async () => {
  const { threads } = await import("./sessions");
  vi.mocked(invoke).mockResolvedValue([]);
  const thread = threads.markOpenFailed(
    "async-channel",
    "fixture",
    "/controlled",
    "native",
    "controlled",
  );
  thread.openError = null;
  thread.connectionId = "connection";
  thread.running = true;
  thread.queuePaused = "stopped";
  thread.queued = [[{ type: "text", text: "original queued draft" }]];
  const event = (value: unknown) =>
    (
      threads as unknown as {
        applyChannelEvent: (key: string, value: unknown) => void;
      }
    ).applyChannelEvent(thread.key, value);
  const initial = setup().event;
  event({
    update: {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "exact-task",
      name: "reported raw",
      canStop: true,
      taskType: "shell",
    },
  });
  expect(thread.asyncTasks).toBeUndefined();
  event(initial);
  expect(thread.asyncTasks!.tasks[0].state).toBe("running");
  event({ kind: "turnEnd", stopReason: "cancelled" });
  expect(
    thread.items.filter((i) => i.kind === "settled").map((i) => i.status),
  ).toEqual(["stopped"]);
  expect(hasActiveTools(thread)).toBe(true);
  expect(thread.queued).toHaveLength(1);
  initial.tasks[0].stopRequest = "accepted";
  event(initial);
  expect(hasActiveTools(thread)).toBe(true);
  initial.tasks[0].state = "completed";
  event(initial);
  expect(hasActiveTools(thread)).toBe(false);
  expect(thread.queuePaused).toBe("stopped");
  expect(thread.queued[0][0]).toEqual({
    type: "text",
    text: "original queued draft",
  });
  expect(
    vi.mocked(invoke).mock.calls.some(([name]) => name === "session_prompt"),
  ).toBe(false);
  expect(
    thread.items.filter((i) => i.kind === "settled").map((i) => i.status),
  ).toEqual(["stopped"]);
});
