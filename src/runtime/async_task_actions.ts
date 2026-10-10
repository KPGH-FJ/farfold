import { invoke } from "@tauri-apps/api/core";
import {
  canStopAsyncTask,
  type AsyncTask,
  type StopRequest,
} from "./async_tasks";
import type { ThreadState } from "./session_types";

export async function stopAsyncTask(
  thread: ThreadState,
  task: AsyncTask,
  current: () => ThreadState | undefined,
  emit: () => void,
): Promise<void> {
  if (current() !== thread || !canStopAsyncTask(thread, task)) return;
  const owner = thread.asyncTasks!;
  const taskId = task.asyncTaskId,
    agentId = thread.agentId,
    cwd = thread.cwd;
  const owns = () =>
    current() === thread &&
    thread.asyncTasks === owner &&
    !thread.connectionLost &&
    !thread.reconnecting &&
    !thread.openError &&
    thread.connectionId === owner.connectionId &&
    thread.nativeSessionId === owner.sessionId &&
    thread.agentId === agentId &&
    thread.cwd === cwd &&
    task.asyncTaskId === taskId &&
    owner.tasks.includes(task);
  task.stopRequest = "requested";
  emit();
  if (!owns()) {
    if (task.stopRequest === "requested") task.stopRequest = "idle";
    return;
  }
  // An observation bound, never proof that the remote command ended.
  const timer = setTimeout(() => {
    if (owns() && task.stopRequest === "requested") {
      task.stopRequest = "unknown";
      emit();
    }
  }, 11_000);
  try {
    const reply = await invoke<Record<string, unknown>>("session_stop_task", {
      agentId,
      cwd,
      sessionId: owner.sessionId,
      connectionId: owner.connectionId,
      taskId,
    });
    if (!owns()) return;
    const valid =
      reply &&
      reply.connectionId === owner.connectionId &&
      reply.sessionId === owner.sessionId &&
      reply.asyncTaskId === task.asyncTaskId &&
      typeof reply.status === "string" &&
      ["accepted", "rejected", "unknown"].includes(reply.status);
    task.stopRequest = valid ? (reply.status as StopRequest) : "unknown";
    emit();
  } catch {
    if (owns()) {
      task.stopRequest = "unknown";
      emit();
    }
  } finally {
    clearTimeout(timer);
  }
}
