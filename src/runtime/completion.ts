import { STRINGS } from "./strings";
import type { RoundResult } from "./round_result";

export interface CompletionEvent {
  stopReason?: string;
  error?: string;
  failure?: unknown;
  usage?: unknown;
}

/** A normal end receipt alone does not prove an answer or tool result arrived. */
export function canContinueAfterCompletion(
  status: ReturnType<typeof completion>["status"],
  result: RoundResult,
): boolean {
  return status === "done" && (result === "reply" || result === "tool");
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
      ? event.error === "AUTH_REQUIRED"
        ? STRINGS.access.authRequired
        : STRINGS.repair.requestFailed
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
