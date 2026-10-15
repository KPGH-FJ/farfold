import type { ThreadState } from "./session_types";
import { receiveCompactionActivity } from "./compaction_activity";

/** Keep transient activity separate from the Agent's transcript/status. */
export function receiveWorkActivity(
  thread: ThreadState,
  event: Record<string, unknown>,
): boolean {
  if (event.kind === "compactionActivity")
    return receiveCompactionActivity(thread, event);
  if (event.kind !== "toolActivity" || !Array.isArray(event.toolCallIds))
    return false;
  // Process exit ends local activity, but is not a successful tool result.
  if (event.reason === "process_ended" && thread.activeToolCallIds.length > 0)
    thread.connectionOutcomeUnknown = true;
  thread.activeToolCallIds = event.toolCallIds.filter(
    (id): id is string => typeof id === "string",
  );
  return true;
}
