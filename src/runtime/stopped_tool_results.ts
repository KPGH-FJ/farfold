import type { ThreadState } from "./session_types";

type StoppedToolEvidence = Partial<
  Pick<
    ThreadState,
    | "items"
    | "activeToolCallIds"
    | "connectionId"
    | "connectionLost"
    | "historyUnavailable"
  >
>;

export const NO_STOPPED_TOOL_CALLS: ReadonlySet<string> = new Set<string>();

/** A matched cancelled reply ends the reply, not the tool. Reuse its existing
 * in-memory links; only the owning connection can retire the active ID. */
export function unfinishedStoppedToolCallIds({
  items,
  activeToolCallIds,
  connectionId,
  connectionLost,
  historyUnavailable,
}: StoppedToolEvidence): ReadonlySet<string> {
  if (
    !items ||
    !connectionId ||
    connectionLost !== false ||
    historyUnavailable ||
    !activeToolCallIds?.length
  )
    return NO_STOPPED_TOOL_CALLS;

  const unknown = new Set<string>();
  const active = new Set(activeToolCallIds);
  const stoppedItems = new Set<string>();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (
      item.kind === "settled" &&
      item.status === "stopped" &&
      item.stopReason === "cancelled" &&
      item.replyReceived !== undefined
    ) {
      for (const id of item.artifactToolItemIds ?? []) stoppedItems.add(id);
    } else if (item.kind === "tool" && active.delete(item.call.toolCallId)) {
      if (stoppedItems.has(item.id)) unknown.add(item.call.toolCallId);
      // An ending only links to tool items that precede it.
      if (active.size === 0) break;
    }
  }
  return unknown;
}
