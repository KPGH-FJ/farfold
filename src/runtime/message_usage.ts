import type { ThreadState } from "./session_types";

/** One reported message, never context occupancy or conversation totals. */
export interface MessageUsage {
  messageId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cost: number | null;
  costSource: "provider_reported" | "estimated" | null;
  elapsedMs: number | null;
  timeToFirstTokenMs: number | null;
  isCompaction: boolean | null;
}
export interface ReceivedMessageUsage extends MessageUsage {
  /** Local receipt time; a load can deliver old messages in any order. */
  receivedAtMs: number;
}
interface Receipt {
  identity: string;
  value: ReceivedMessageUsage;
  owns?: () => boolean;
}
// Single passive receipt per exact view, not a transcript or persisted ledger.
// An accepted history open transfers this same object; private previews do not.
const latest = new WeakMap<ThreadState, Receipt>();
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
// The existing connection owns its selected service; opening assigns service
// metadata later, so do not mistake that baseline assignment for a source swap.
const identity = (s: ThreadState) =>
  JSON.stringify([s.key, s.agentId, s.cwd, s.nativeSessionId, s.connectionId]);
const available = (s: ThreadState) =>
  Boolean(
    s.connectionId &&
    !s.connectionLost &&
    !s.reconnecting &&
    !s.sourceError &&
    !s.openError &&
    !s.historyUnavailable &&
    s.processEndedConnectionId !== s.connectionId,
  );
export function getMessageUsage(s: ThreadState): ReceivedMessageUsage | null {
  const receipt = latest.get(s);
  if (!receipt) return null;
  if (
    !available(s) ||
    receipt.identity !== identity(s) ||
    (receipt.owns && !receipt.owns())
  ) {
    latest.delete(s);
    return null;
  }
  return receipt.value;
}
export function isMessageUsageNotification(e: unknown): e is Record<
  string,
  unknown
> & {
  presentation: Record<string, unknown>;
} {
  return (
    record(e) &&
    e.kind === "notification" &&
    !Object.hasOwn(e, "sessionId") &&
    record(e.presentation) &&
    e.presentation.kind === "messageUsage"
  );
}
const countKeys = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "elapsedMs",
  "timeToFirstTokenMs",
] as const;
const usageKeys = [
  "messageId",
  ...countKeys,
  "cost",
  "costSource",
  "isCompaction",
];
function validUsage(v: unknown): v is MessageUsage {
  if (!record(v) || !exact(v, usageKeys)) return false;
  if (
    v.messageId !== null &&
    (typeof v.messageId !== "string" ||
      !v.messageId.length ||
      [...v.messageId].length > 1024 ||
      /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(v.messageId))
  )
    return false;
  if (
    countKeys.some(
      (key) =>
        v[key] !== null &&
        !(
          typeof v[key] === "number" &&
          Number.isSafeInteger(v[key]) &&
          v[key] >= 0
        ),
    )
  )
    return false;
  return (
    (v.cost === null ||
      (typeof v.cost === "number" && Number.isFinite(v.cost) && v.cost >= 0)) &&
    (v.costSource === null ||
      v.costSource === "provider_reported" ||
      v.costSource === "estimated") &&
    (v.isCompaction === null || typeof v.isCompaction === "boolean")
  );
}
/** Public opening and live delivery share one passive metadata projection.
 * Existing opening admission controls publication. No effect may send work. */
export function receiveMessageUsage(
  s: ThreadState,
  e: unknown,
  owns?: () => boolean,
  deliveryConnectionId?: string,
): boolean {
  if (!isMessageUsageNotification(e)) return false;
  getMessageUsage(s);
  const hint = e.presentation;
  if (
    (owns && !owns()) ||
    !available(s) ||
    (deliveryConnectionId !== undefined &&
      deliveryConnectionId !== s.connectionId) ||
    !exact(e, ["kind", "method", "params", "presentation"]) ||
    typeof e.method !== "string" ||
    !record(e.params) ||
    e.params.sessionId !== s.nativeSessionId ||
    !exact(hint, ["kind", "connectionId", "usage"]) ||
    hint.connectionId !== s.connectionId ||
    !validUsage(hint.usage)
  )
    return true;
  latest.set(s, {
    identity: identity(s),
    owns,
    value: Object.freeze({ ...hint.usage, receivedAtMs: Date.now() }),
  });
  return true;
}
