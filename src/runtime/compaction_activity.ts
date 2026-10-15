import type { ThreadState } from "./session_types";

/** Current connection ownership only. Replayed transcript cards grant no work. */
export interface CompactionActivityState {
  connectionId: string;
  sessionId: string;
  compactionIds: string[];
  uncertain: boolean;
  processEnded?: true;
}

type Owner = Pick<
  ThreadState,
  "connectionId" | "nativeSessionId" | "connectionLost" | "compactionActivity"
>;

export function hasActiveCompaction(thread: Owner): boolean {
  const activity = thread.compactionActivity;
  return Boolean(
    !thread.connectionLost &&
    thread.connectionId &&
    activity?.connectionId === thread.connectionId &&
    activity.sessionId === thread.nativeSessionId &&
    (activity.compactionIds.length || activity.uncertain),
  );
}

export function compactionUncertain(thread: Owner): boolean {
  return (
    hasActiveCompaction(thread) && Boolean(thread.compactionActivity?.uncertain)
  );
}

/** An ordinary prompt receipt cannot settle a separate lost activity. */
export function unconfirmedCompactionOutcome(thread: Owner): boolean {
  const activity = thread.compactionActivity;
  return Boolean(
    thread.connectionId &&
    activity?.connectionId === thread.connectionId &&
    activity.sessionId === thread.nativeSessionId &&
    (thread.connectionLost || activity.processEnded) &&
    (activity.compactionIds.length || activity.uncertain),
  );
}

/** The backend classifies live work separately from original updates. Its
 * owner receipt can be buffered before open replies; raw-prefix flags cannot
 * discard that already verified activity. */
export function receiveCompactionActivity(
  thread: ThreadState,
  value: Record<string, unknown>,
): boolean {
  if (
    thread.connectionLost ||
    !thread.connectionId ||
    thread.compactionActivity?.processEnded ||
    value.connectionId !== thread.connectionId ||
    value.sessionId !== thread.nativeSessionId ||
    !Array.isArray(value.compactionIds) ||
    typeof value.uncertain !== "boolean" ||
    (value.reason !== undefined && value.reason !== "process_ended")
  )
    return false;
  const ids = value.compactionIds;
  if (
    ids.length > 512 ||
    ids.some(
      (id) =>
        typeof id !== "string" ||
        !id ||
        id.includes("\0") ||
        new TextEncoder().encode(id).byteLength > 4096,
    ) ||
    new Set(ids).size !== ids.length
  )
    return false;
  if (value.reason === "process_ended") {
    const unknown =
      hasActiveCompaction(thread) || Boolean(ids.length) || value.uncertain;
    if (unknown) thread.connectionOutcomeUnknown = true;
    thread.compactionActivity = {
      connectionId: thread.connectionId,
      sessionId: thread.nativeSessionId,
      compactionIds: [],
      uncertain: unknown,
      processEnded: true,
    };
  } else {
    thread.compactionActivity = {
      connectionId: thread.connectionId,
      sessionId: thread.nativeSessionId,
      compactionIds: [...ids] as string[],
      uncertain: value.uncertain,
    };
  }
  return true;
}
