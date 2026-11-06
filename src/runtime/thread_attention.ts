import {
  hasActiveTools,
  hasPendingRequests,
  type ThreadState,
} from "./session_types";
import { hasAsyncTasks } from "./async_tasks";
import {
  compactionUncertain,
  hasActiveCompaction,
} from "./compaction_activity";
import { hasActiveFork } from "./session_fork_activity";

/** Shared by the conversation store and sidebar; no history-derived activity. */
export function threadNeedsAttention(thread: ThreadState): boolean {
  return Boolean(
    thread.openError ||
    thread.unrecoverable ||
    thread.stopUnconfirmed ||
    thread.modelDrift ||
    (thread.permissionConfigId &&
      ["required", "unknown"].includes(thread.permissionState)) ||
    thread.uncertainPrompt ||
    thread.queuePaused === "no_result" ||
    hasPendingRequests(thread) ||
    thread.connectionOutcomeUnknown ||
    thread.historicalOutcomeUnknown ||
    thread.forkOperation?.status === "unknown" ||
    thread.forkOperation?.status === "created_unavailable" ||
    compactionUncertain(thread),
  );
}

/** Display only: an older stopped/failed reply cannot describe newer work. */
export function hasUnconfirmedToolTail(thread: ThreadState): boolean {
  if (
    thread.running ||
    thread.submitting ||
    thread.reconnecting ||
    thread.configuring ||
    thread.stopping ||
    hasAsyncTasks(thread) ||
    hasActiveCompaction(thread) ||
    hasActiveFork(thread) ||
    !hasActiveTools(thread) ||
    hasPendingRequests(thread)
  )
    return false;
  for (let i = thread.items.length - 1; i >= 0; i -= 1) {
    const item = thread.items[i];
    if (item.kind === "user") return false;
    if (item.kind === "settled")
      return item.status === "stopped" || item.status === "failed";
  }
  return false;
}
