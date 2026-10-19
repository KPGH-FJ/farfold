import type { ThreadState } from "./session_types";
import type { ConnectionCloseReason } from "./connection_close";

export interface ProcessEndedReceipt {
  connectionId: string;
  closeReason: ConnectionCloseReason;
}
// Validate only the independent typed IPC channel, never a raw Agent event.
export function processEndedReceipt(
  value: unknown,
): ProcessEndedReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== 2 ||
    !Object.hasOwn(v, "connectionId") ||
    !Object.hasOwn(v, "closeReason") ||
    typeof v.connectionId !== "string" ||
    !v.connectionId ||
    v.connectionId.length > 4096 ||
    v.connectionId.includes("\0") ||
    typeof v.closeReason !== "string" ||
    ![
      "idle",
      "user",
      "shutdown",
      "configuration",
      "startup_failed",
      "unexpected",
    ].includes(v.closeReason)
  )
    return null;
  return v as unknown as ProcessEndedReceipt;
}
/** Actual external work ended; the old request result may still be unknown. */
export function connectionWorkEnded(thread: ThreadState): boolean {
  return Boolean(
    thread.connectionLost &&
    thread.connectionId &&
    thread.processEndedConnectionId === thread.connectionId,
  );
}
