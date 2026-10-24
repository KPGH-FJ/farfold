import { hasPendingRequests, type ThreadState } from "./session_types";
import { compactionUncertain } from "./compaction_activity";

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
