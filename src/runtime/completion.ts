import { STRINGS } from "./strings";

export interface CompletionEvent {
  stopReason?: string;
  error?: string;
  failure?: unknown;
}

export function completion(event: CompletionEvent): {
  status: "failed" | "stopped" | "done" | "unknown";
  error?: string;
} {
  const category = (event.failure as { category?: unknown } | undefined)
    ?.category;
  const failureText: Record<string, string> = {
    access: STRINGS.repair.authRequired,
    limit: STRINGS.repair.requestLimit,
    service: STRINGS.repair.serviceFailed,
    connection: STRINGS.thread.connectionLost,
    request: STRINGS.repair.rejected,
  };
  const error = event.failure
    ? (typeof category === "string" && failureText[category]) ||
      STRINGS.repair.requestFailed
    : event.error
      ? STRINGS.repair.requestFailed
      : event.stopReason === "refusal"
        ? STRINGS.repair.rejected
        : event.stopReason === "max_tokens" ||
            event.stopReason === "max_turn_requests"
          ? STRINGS.repair.limitReached
          : undefined;
  return {
    error,
    status: error
      ? "failed"
      : event.stopReason === "cancelled"
        ? "stopped"
        : event.stopReason === "end_turn"
          ? "done"
          : "unknown",
  };
}
