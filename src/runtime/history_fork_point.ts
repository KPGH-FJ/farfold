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

export function historyForkSelection(
  thread: ThreadState,
  item: ThreadItem,
): HistoryForkSelection | undefined {
  if (
    !thread.sessionOperations?.forkHistoricalPoint ||
    !thread.connectionId ||
    thread.connectionLost ||
    !thread.items.includes(item) ||
    (item.kind !== "user" && item.kind !== "agent") ||
    item.streaming ||
    item.historyForkPoint?.connectionId !== thread.connectionId ||
    !validForkId(item.historyForkPoint.messageId) ||
    item.messageId !== item.historyForkPoint.messageId ||
    thread.items.filter(
      (other) =>
        (other.kind === "user" || other.kind === "agent") &&
        other.messageId === item.messageId,
    ).length !== 1
  )
    return;
  return {
    item,
    point: { messageId: item.messageId },
    preview: item.text.slice(0, 240),
  };
}

export function hasHistoryForkPoint(
  thread: ThreadState,
  point: HistoryForkPoint,
): boolean {
  return thread.items.some(
    (item) =>
      historyForkSelection(thread, item)?.point.messageId === point.messageId,
  );
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
