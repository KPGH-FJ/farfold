import type { ThreadItem, ThreadState } from "./session_types";
import { validForkId } from "./session_fork_activity";

export interface HistoryForkPoint {
  messageId: string;
}
export interface OwnedHistoryForkPoint extends HistoryForkPoint {
  connectionId: string;
}
export interface HistoryForkSelection {
  item: ThreadItem;
  point: HistoryForkPoint;
  preview: string;
}
const record = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));

/** Only the connection layer qualifies an official message identity. Raw
 * Agent metadata and local display IDs never authorize a historical fork. */
export function historyForkHint(
  thread: ThreadState,
  update: unknown,
  envelope: unknown,
): OwnedHistoryForkPoint | undefined {
  if (
    !record(envelope) ||
    !record(update) ||
    envelope.update !== update ||
    envelope.sessionId !== thread.nativeSessionId ||
    !thread.connectionId ||
    thread.connectionLost ||
    !["user_message_chunk", "agent_message_chunk"].includes(
      String(update.sessionUpdate),
    ) ||
    !record(envelope.presentation)
  )
    return;
  const hint = envelope.presentation;
  if (
    Object.keys(hint).length !== 3 ||
    hint.kind !== "historyForkPoint" ||
    hint.connectionId !== thread.connectionId ||
    !validForkId(hint.messageId) ||
    (update.messageId !== undefined && update.messageId !== hint.messageId)
  )
    return;
  return { messageId: hint.messageId, connectionId: thread.connectionId };
}

function isMessage(item: ThreadItem) {
  return item.kind === "user" || item.kind === "agent";
}

function forkConnection(thread: ThreadState): string | undefined {
  if (thread.sessionOperations?.forkHistoricalPoint && !thread.connectionLost)
    return thread.connectionId;
}

function forkMessageId(
  item: ThreadItem,
  connection: string,
): string | undefined {
  if (
    !isMessage(item) ||
    item.streaming ||
    item.historyForkPoint?.connectionId !== connection ||
    !validForkId(item.historyForkPoint.messageId) ||
    item.messageId !== item.historyForkPoint.messageId
  )
    return;
  return item.messageId;
}

/** A render-scoped index. The action still rechecks the current thread. */
export function historyForkableItems(
  thread: ThreadState,
): ReadonlySet<ThreadItem> {
  const items = new Set<ThreadItem>();
  const connection = forkConnection(thread);
  if (!connection) return items;
  const unique = new Map<string, ThreadItem | null>();
  for (const item of thread.items) {
    if (isMessage(item) && item.messageId)
      unique.set(item.messageId, unique.has(item.messageId) ? null : item);
  }
  for (const item of unique.values()) {
    if (item && forkMessageId(item, connection)) items.add(item);
  }
  return items;
}

export function historyForkSelection(
  thread: ThreadState,
  item: ThreadItem,
): HistoryForkSelection | undefined {
  const connection = forkConnection(thread);
  if (!connection || !isMessage(item)) return;
  const messageId = forkMessageId(item, connection);
  if (!messageId) return;
  const matches = thread.items.filter(
    (other) => isMessage(other) && other.messageId === messageId,
  );
  if (matches.length !== 1 || matches[0] !== item) return;
  return {
    item,
    point: { messageId },
    preview: item.text.slice(0, 240),
  };
}

export function hasHistoryForkPoint(
  thread: ThreadState,
  point: HistoryForkPoint,
): boolean {
  const item = thread.items.find(
    (candidate) =>
      isMessage(candidate) && candidate.messageId === point.messageId,
  );
  return !!item && !!historyForkSelection(thread, item);
}
export function sameHistoryForkPoint(
  value: unknown,
  point: HistoryForkPoint | undefined,
): boolean {
  if (!point) return value === undefined || value === null;
  return (
    record(value) &&
    Object.keys(value).length === 1 &&
    value.messageId === point.messageId
  );
}
