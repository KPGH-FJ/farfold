import { Channel } from "@tauri-apps/api/core";
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

/** A process receipt outlives raw delivery retirement. It applies only to
 * its captured state and connection, including a receipt received before bind. */
export class ProcessEndedChannel extends Channel<unknown> {
  private ended: ProcessEndedReceipt | null = null;
  private state?: ThreadState;
  constructor(
    private current: (key: string) => ThreadState | undefined,
    private apply: (key: string, event: unknown) => void,
  ) {
    super();
    this.onmessage = (value) => {
      const receipt = processEndedReceipt(value);
      if (
        !receipt ||
        (this.state && receipt.connectionId !== this.state.connectionId)
      )
        return;
      this.ended ??= receipt;
      this.applyEnded();
    };
  }
  bind(state: ThreadState): void {
    this.state = state;
    this.applyEnded();
  }
  private applyEnded(): void {
    const state = this.state;
    const ended = this.ended;
    if (!state || !ended) return;
    if (ended.connectionId !== state.connectionId) {
      this.ended = null;
      return;
    }
    if (this.current(state.key) !== state) return;
    state.processEndedConnectionId = ended.connectionId;
    this.ended = null;
    this.onmessage = () => {};
    this.apply(state.key, {
      kind: "connectionLost",
      closeReason: ended.closeReason,
    });
  }
}
