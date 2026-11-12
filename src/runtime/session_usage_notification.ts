import { retainReportedDetails } from "./reported_details";
import type { ThreadState } from "./session_types";

interface CumulativeTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
}
interface Receipt {
  identity: string;
  value: CumulativeTokens;
  owns?: () => boolean;
}
// One passive report per existing view, not history or persisted accounting.
// Standard context reports carry no cumulative counters and must not erase it.
const latest = new WeakMap<ThreadState, Receipt>();
/** A later complete official report supersedes this pair, even when the
 * details panel was never opened between reports. */
export function forgetSessionCumulativeTokens(s: ThreadState): void {
  latest.delete(s);
}
const identity = (s: ThreadState) =>
  JSON.stringify([s.key, s.agentId, s.cwd, s.nativeSessionId, s.connectionId]);
export function getSessionCumulativeTokens(
  s: ThreadState,
): CumulativeTokens | null {
  const receipt = latest.get(s);
  if (!receipt) return null;
  if (
    !s.connectionId ||
    s.connectionLost ||
    s.reconnecting ||
    s.openError ||
    s.historyUnavailable ||
    s.sourceError ||
    s.processEndedConnectionId === s.connectionId ||
    receipt.identity !== identity(s) ||
    (receipt.owns && !receipt.owns())
  ) {
    latest.delete(s);
    return null;
  }
  return receipt.value;
}

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const counts = [
  "used",
  "contextLimit",
  "accumulatedInputTokens",
  "accumulatedOutputTokens",
] as const;

/** A reviewed backend presentation fact, never a transcript or work result.
 * Original notification fields remain visible in the existing detail store. */
export function receiveSessionUsage(
  s: ThreadState,
  event: unknown,
  owns?: () => boolean,
  deliveryConnectionId?: string,
): boolean {
  if (
    !record(event) ||
    !exact(event, ["kind", "method", "params", "presentation"]) ||
    event.kind !== "notification" ||
    typeof event.method !== "string" ||
    !record(event.params) ||
    event.params.sessionId !== s.nativeSessionId ||
    !record(event.presentation)
  )
    return false;
  const hint = event.presentation;
  if (
    !exact(hint, ["kind", "connectionId", "usage"]) ||
    hint.kind !== "sessionUsage" ||
    typeof hint.connectionId !== "string" ||
    !hint.connectionId ||
    hint.connectionId !== s.connectionId ||
    (deliveryConnectionId !== undefined &&
      deliveryConnectionId !== s.connectionId) ||
    (owns && !owns()) ||
    s.connectionLost ||
    !record(hint.usage)
  )
    return false;
  const usage = hint.usage;
  if (
    !exact(usage, [...counts, "accumulatedCost"]) ||
    counts.some(
      (key) =>
        typeof usage[key] !== "number" ||
        !Number.isSafeInteger(usage[key]) ||
        usage[key] < 0,
    ) ||
    !(
      usage.accumulatedCost === null ||
      (typeof usage.accumulatedCost === "number" &&
        Number.isFinite(usage.accumulatedCost) &&
        usage.accumulatedCost >= 0)
    )
  )
    return false;
  const context = {
    used: usage.used as number,
    size: usage.contextLimit as number,
  };
  s.usage = context;
  latest.set(s, {
    identity: identity(s),
    owns,
    value: Object.freeze({
      inputTokens: usage.accumulatedInputTokens as number,
      outputTokens: usage.accumulatedOutputTokens as number,
    }),
  });
  // No currency or total is invented from counters. Keep the original fields
  // rather than a second event list, including future source metadata.
  retainReportedDetails(
    s,
    { sessionUpdate: "usage_update", ...context },
    event,
  );
  return true;
}
