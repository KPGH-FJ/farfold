import type { ThreadState } from "./session_types";
import { receiveCompactionActivity } from "./compaction_activity";
import { pushRaw } from "./session_projection";

/** Keep transient activity separate from the Agent's transcript/status. */
export function receiveWorkActivity(
  thread: ThreadState,
  event: Record<string, unknown>,
  activityConnectionId?: string,
): boolean {
  if (event.kind === "compactionActivity")
    return receiveCompactionActivity(thread, event);
  if (event.kind !== "toolActivity") return false;
  const failedOwner = Boolean(
    thread.historyUnavailable && activityConnectionId,
  );
  // Use this same parser for the qualification. Invalid owned observations
  // are handled as exact raw envelopes, never active/idle proof. The legacy
  // two-argument caller keeps its original array filtering behavior.
  if (
    !Array.isArray(event.toolCallIds) ||
    (failedOwner &&
      (thread.connectionId !== activityConnectionId ||
        event.toolCallIds.some((id) => typeof id !== "string")))
  ) {
    if (!failedOwner) return false;
    pushRaw(thread, event);
    return true;
  }
  // Process exit ends local activity, but is not a successful tool result.
  if (event.reason === "process_ended" && thread.activeToolCallIds.length > 0)
    thread.connectionOutcomeUnknown = true;
  thread.activeToolCallIds = event.toolCallIds.filter(
    (id): id is string => typeof id === "string",
  );
  if (
    thread.historyUnavailable &&
    activityConnectionId &&
    thread.connectionId === activityConnectionId
  )
    thread.historyUnavailable.toolActivityConnectionId = activityConnectionId;
  return true;
}
