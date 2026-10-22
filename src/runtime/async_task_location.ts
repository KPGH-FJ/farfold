import type { ThreadItem, ThreadState } from "./session_types";

export type AsyncTaskTool = Extract<ThreadItem, { kind: "tool" }>;

/** Only exact, unambiguous references in the same loaded conversation qualify.
 * This is navigation, not evidence that the task or its tool has finished. */
export function asyncTaskToolLocations(thread: ThreadState) {
  const locations = new Map<string, AsyncTaskTool>();
  const ambiguous = new Set<string>();
  const owner = thread.asyncTasks;
  if (
    !owner?.supported ||
    owner.connectionId !== thread.connectionId ||
    owner.sessionId !== thread.nativeSessionId
  )
    return locations;
  for (const item of thread.items) {
    if (item.kind !== "tool") continue;
    const id = item.call.toolCallId;
    if (locations.has(id)) ambiguous.add(id);
    else locations.set(id, item);
  }
  for (const id of ambiguous) locations.delete(id);
  return locations;
}
