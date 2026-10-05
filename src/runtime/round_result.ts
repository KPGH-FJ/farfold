import { hasReadableMessages } from "./message_attachments";
import type { ThreadItem, ThreadState, ToolCallView } from "./session_types";

/** A received result is separate from the Agent's reason for ending a request. */
export type RoundResult = "reply" | "tool" | "pending" | "none";
type Settled = Extract<ThreadItem, { kind: "settled" }>;

export function hasAgentReply(items: readonly ThreadItem[]): boolean {
  return hasReadableMessages(items.filter((item) => item.kind === "agent"));
}

function suppliedOutput(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Inputs, titles, plans and thoughts are not results. A terminal tool status
 * is a real result even for a command that intentionally produces no output.
 * Failed tools remain failed in their own cards; this never asserts success. */
export function hasToolResult(call: ToolCallView): boolean {
  if (call.kind === "think") return false;
  if (call.status === "completed" || call.status === "failed") return true;
  if (suppliedOutput(call.rawOutput) || call.terminalOutput?.trim())
    return true;
  return call.content.some((content) => {
    switch (content.type) {
      case "text":
        return content.text.trim().length > 0;
      case "diff":
        return content.path.trim().length > 0;
      case "attachment":
        return Boolean(
          content.attachment.data ||
          content.attachment.text?.trim() ||
          content.attachment.uri,
        );
      case "link":
        return Boolean(content.uri && content.name);
      default:
        // A terminal handle alone and an opaque extension do not prove output.
        return false;
    }
  });
}

export function roundResult(
  replyReceived: boolean,
  tools: readonly ToolCallView[],
  activeIds: readonly string[],
  connected = true,
): RoundResult {
  if (replyReceived) return "reply";
  if (tools.some(hasToolResult)) return "tool";
  if (connected && tools.some((tool) => activeIds.includes(tool.toolCallId)))
    return "pending";
  return "none";
}

/** Existing in-memory tool IDs keep a late tool result with its original
 * round. Updating the display never resumes a paused queue. No history ledger. */
export function settledRoundResults(
  state: Pick<ThreadState, "items" | "activeToolCallIds" | "connectionLost">,
): Map<string, RoundResult> {
  const tools = new Map(
    state.items.flatMap((item) =>
      item.kind === "tool" ? [[item.id, item.call] as const] : [],
    ),
  );
  const results = new Map<string, RoundResult>();
  for (const item of state.items) {
    if (item.kind !== "settled" || item.replyReceived === undefined) continue;
    results.set(item.id, settledResult(item, tools, state));
  }
  return results;
}

function settledResult(
  item: Settled,
  tools: ReadonlyMap<string, ToolCallView>,
  state: Pick<ThreadState, "activeToolCallIds" | "connectionLost">,
): RoundResult {
  return roundResult(
    item.replyReceived === true,
    (item.artifactToolItemIds ?? []).flatMap((id) => {
      const tool = tools.get(id);
      return tool ? [tool] : [];
    }),
    state.activeToolCallIds,
    !state.connectionLost,
  );
}
