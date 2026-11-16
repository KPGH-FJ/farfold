import type { ThreadState } from "./session_types";

export interface ProgramStatus {
  type: "notice" | "progress";
  message: string;
  truncated: boolean;
  /** Local receipt time, not an Agent start time or evidence of ongoing work. */
  receivedAtMs: number;
}

interface ReceivedStatus {
  context: string;
  owns: () => boolean;
  value: ProgramStatus;
}

// Presentation only: no transcript, persisted field, activity or notice ledger.
const latest = new WeakMap<ThreadState, ReceivedStatus>();
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const contextOf = (thread: ThreadState) =>
  JSON.stringify([
    thread.key,
    thread.agentId,
    thread.cwd,
    thread.nativeSessionId,
    thread.connectionId,
    thread.serviceContext ?? null,
    thread.service?.id ?? null,
    thread.service?.fingerprint ?? null,
  ]);
const connected = (thread: ThreadState) =>
  Boolean(
    thread.connectionId &&
    !thread.connectionLost &&
    !thread.sourceError &&
    !thread.reconnecting &&
    !thread.historyUnavailable &&
    thread.processEndedConnectionId !== thread.connectionId,
  );

/** Only the exact still-published live owner can display its latest receipt. */
export function getProgramStatus(thread: ThreadState): ProgramStatus | null {
  const received = latest.get(thread);
  if (!received) return null;
  if (
    !connected(thread) ||
    received.context !== contextOf(thread) ||
    !received.owns()
  ) {
    latest.delete(thread);
    return null;
  }
  return received.value;
}

function safeMessage(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)
  )
    return false;
  let length = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if ((code >= 0xd800 && code <= 0xdfff) || ++length > 2048) return false;
  }
  return true;
}

export function isProgramStatusNotification(event: unknown): event is Record<
  string,
  unknown
> & {
  presentation: Record<string, unknown>;
} {
  return (
    record(event) &&
    event.kind === "notification" &&
    !Object.hasOwn(event, "sessionId") &&
    record(event.presentation) &&
    event.presentation.kind === "liveStatus"
  );
}

/** Consume only a backend-normalized live-only notification. Malformed known
 * hints stay on the original event bus but never become history or authority.
 * Unknown presentation kinds keep the ordinary raw-notification behavior. */
export function receiveProgramStatus(
  thread: ThreadState,
  event: Record<string, unknown>,
  live: boolean,
  owns?: () => boolean,
  deliveryConnectionId?: string,
): boolean {
  if (!isProgramStatusNotification(event)) return false;
  const hint = event.presentation;
  // Invalidate a former context even if this new receipt is malformed.
  getProgramStatus(thread);
  if (
    !live ||
    !owns?.() ||
    !connected(thread) ||
    (deliveryConnectionId !== undefined &&
      deliveryConnectionId !== thread.connectionId) ||
    !exact(event, ["kind", "method", "params", "presentation"]) ||
    typeof event.method !== "string" ||
    !record(event.params) ||
    event.params.sessionId !== thread.nativeSessionId ||
    !exact(hint, ["kind", "status"])
  )
    return true;
  const status = hint.status;
  if (
    !record(status) ||
    !exact(status, ["type", "message", "truncated"]) ||
    (status.type !== "notice" && status.type !== "progress") ||
    !safeMessage(status.message) ||
    typeof status.truncated !== "boolean"
  )
    return true;
  latest.set(thread, {
    context: contextOf(thread),
    owns,
    value: Object.freeze({
      type: status.type,
      message: status.message,
      truncated: status.truncated,
      receivedAtMs: Date.now(),
    }),
  });
  return true;
}
