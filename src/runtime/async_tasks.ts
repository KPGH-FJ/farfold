import type { ThreadState } from "./session_types";

export type TaskState =
  "running" | "unknown" | "completed" | "failed" | "stopped";
export type StopRequest =
  "idle" | "requested" | "accepted" | "rejected" | "unknown";
export interface AsyncTask {
  asyncTaskId: string;
  name: string;
  taskType: string;
  toolCallId: string | null;
  canStop: boolean;
  state: TaskState;
  stopRequest: StopRequest;
}
export interface AsyncTasksState {
  connectionId: string;
  sessionId: string;
  supported: boolean;
  overflow: boolean;
  tasks: AsyncTask[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, limit = 4096): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    !value.includes("\0")
  );
}

/** Only the backend's live owner-checked event grants controls; raw replay never does. */
export function receiveAsyncTasks(
  thread: ThreadState,
  value: unknown,
): boolean {
  if (
    !record(value) ||
    value.kind !== "asyncTasks" ||
    thread.connectionLost ||
    value.connectionId !== thread.connectionId ||
    value.sessionId !== thread.nativeSessionId ||
    typeof value.supported !== "boolean" ||
    typeof value.overflow !== "boolean" ||
    !Array.isArray(value.tasks) ||
    value.tasks.length > 512
  )
    return false;
  const ids = new Set<string>();
  const tasks: AsyncTask[] = [];
  for (const raw of value.tasks) {
    if (
      !record(raw) ||
      !text(raw.asyncTaskId) ||
      ids.has(raw.asyncTaskId) ||
      !text(raw.name) ||
      !text(raw.taskType, 128) ||
      !(raw.toolCallId === null || text(raw.toolCallId)) ||
      typeof raw.canStop !== "boolean" ||
      typeof raw.state !== "string" ||
      !["running", "unknown", "completed", "failed", "stopped"].includes(
        raw.state,
      ) ||
      typeof raw.stopRequest !== "string" ||
      !["idle", "requested", "accepted", "rejected", "unknown"].includes(
        raw.stopRequest,
      )
    )
      return false;
    ids.add(raw.asyncTaskId);
    tasks.push({
      asyncTaskId: raw.asyncTaskId,
      name: raw.name,
      taskType: raw.taskType,
      toolCallId: raw.toolCallId,
      canStop: raw.canStop,
      state: raw.state as TaskState,
      stopRequest: raw.stopRequest as StopRequest,
    });
  }
  if (!value.supported && (tasks.length > 0 || value.overflow)) return false;
  thread.asyncTasks = {
    connectionId: value.connectionId as string,
    sessionId: thread.nativeSessionId,
    supported: value.supported,
    overflow: value.overflow,
    tasks,
  };
  return true;
}

export function hasAsyncTasks(thread: {
  asyncTasks?: AsyncTasksState;
}): boolean {
  return Boolean(
    thread.asyncTasks?.overflow ||
    thread.asyncTasks?.tasks.some(
      (t) => t.state === "running" || t.state === "unknown",
    ),
  );
}

export function canStopAsyncTask(
  thread: ThreadState,
  task: AsyncTask,
): boolean {
  const owned = thread.asyncTasks;
  return Boolean(
    owned?.supported &&
    owned.connectionId === thread.connectionId &&
    owned.sessionId === thread.nativeSessionId &&
    owned.tasks.includes(task) &&
    !thread.connectionLost &&
    !thread.reconnecting &&
    !thread.openError &&
    task.canStop &&
    task.state === "running" &&
    (task.stopRequest === "idle" || task.stopRequest === "rejected"),
  );
}
