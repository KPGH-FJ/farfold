import { finishHistoryPrefix } from "./history_replay";
import { hasReadableMessages } from "./message_attachments";
import { pushRaw } from "./session_projection";
import {
  historyProjectionFailure,
  requireReadableProjectedHistory,
} from "./session_recovery";
import type { OpenResult } from "./session_open_types";
import type { ThreadState } from "./session_types";
import { isProgramStatusNotification } from "./program_status";
import { STRINGS } from "./strings";

export type HistoryProjectionPhase = "history" | "following";
type ProjectionOutcome = "consumed" | "discarded";
type Project = (
  state: ThreadState,
  event: unknown,
  phase: HistoryProjectionPhase,
) => void;

/** One private view, projected as delivery arrives and transferred on success.
 * The caller supplies the existing reducer and an already known session owner;
 * this object neither guesses a child identity nor retains a raw replay list.
 * A final loaded view can still be large: this removes duplicate staging, not
 * the product's complete history, and is not an RSS limit. */
export class HistoryReplayProjection {
  private owned: ThreadState | undefined;
  private marked = false;
  private readable = false;
  private failed = false;
  private failure: unknown;

  constructor(
    state: ThreadState,
    private readonly token: string,
    private readonly apply: Project,
    private readonly current: () => boolean = () => true,
  ) {
    this.owned = state;
  }

  /** Metadata can be merged into this same owner before publication. A caller
   * must not insert it into the live map until its original open is accepted. */
  get state(): ThreadState | undefined {
    return this.owned;
  }

  get complete(): boolean {
    return this.marked;
  }

  get readablePrefix(): boolean {
    return this.readable;
  }

  get phase(): HistoryProjectionPhase {
    return this.marked ? "following" : "history";
  }

  push(event: unknown): ProjectionOutcome {
    const state = this.owned;
    if (!state || !this.current()) return "discarded";
    // Temporary live receipts never enter even an already-failed raw replay.
    if (isProgramStatusNotification(event)) return "consumed";
    if (this.failed) {
      pushRaw(state, event);
      return "consumed";
    }
    try {
      this.apply(state, event, this.phase);
      return "consumed";
    } catch (error) {
      // Keep the first actual local conversion failure for the original open.
      // Continue receiving raw bytes so the same queue's completion/control
      // receipts can arrive. This private view can never pass requireReadable;
      // consumed means raw ownership, not a successful history projection.
      this.failed = true;
      this.failure = error;
      pushRaw(state, event);
      return "consumed";
    }
  }

  /** The entrypoint validates the control's exact shape and ownership first.
   * A repeated marker cannot admit following text or zero its observed time. */
  mark(token: string): boolean {
    const state = this.owned;
    if (!state || !this.current() || token !== this.token) return false;
    if (!this.marked) {
      this.readable = hasReadableMessages(state.items);
      finishHistoryPrefix(state);
      this.marked = true;
    }
    return true;
  }

  /** A preview may expose a complete empty snapshot without adopting it.
   * Missing markers/loss retain their original precedence over conversion. */
  requireComplete(agentId: string, result: OpenResult, lost: boolean): void {
    this.requireOwner();
    requireReadableProjectedHistory(agentId, result, this.marked, true, lost);
    if (this.failed) {
      if (this.failure instanceof TypeError)
        throw historyProjectionFailure(agentId, result, this.failure);
      throw this.failure;
    }
  }

  /** Read only the actually projected state and the original marker facts.
   * Caller-owned loss remains independent of a conversion exception. */
  requireReadable(agentId: string, result: OpenResult, lost: boolean): void {
    this.requireComplete(agentId, result, lost);
    requireReadableProjectedHistory(
      agentId,
      result,
      this.marked,
      this.readable,
      false,
    );
  }

  /** Transfer the exact object; never recreate or copy its items. Completeness
   * and metadata acceptance belong to the entrypoint's existing contract. */
  take(): ThreadState {
    const state = this.requireOwner();
    if (this.failed) throw this.failure;
    this.clear();
    return state;
  }

  clear(): void {
    this.owned = undefined;
    this.failure = undefined;
    this.failed = false;
  }

  private requireOwner(): ThreadState {
    if (!this.owned || !this.current())
      throw new Error(STRINGS.repair.reconnectFailed);
    return this.owned;
  }
}
