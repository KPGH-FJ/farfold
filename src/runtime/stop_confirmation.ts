import { invoke } from "@tauri-apps/api/core";
import { pauseQueue } from "./queue";
import type { ThreadState } from "./session_types";

/** A cancel acknowledgement is not a prompt completion. No normal-task timeout. */
export class StopConfirmation {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private preparations = new WeakSet<ThreadState>();

  /** Only the in-memory interval before session_prompt can reach the Agent. */
  prepare(s: ThreadState): () => void {
    this.preparations.add(s);
    return () => this.preparations.delete(s);
  }

  async cancel(
    s: ThreadState | undefined,
    current: () => ThreadState | undefined,
    emit: () => void,
    dispatch?: () => Promise<void>,
  ): Promise<void> {
    if (
      !s ||
      (!s.running && !s.submitting && !s.connectionOutcomeUnknown) ||
      s.connectionLost ||
      s.stopping
    )
      return;
    pauseQueue(s, "stopped");
    for (const request of s.pendingPermissions)
      if (request.status === "pending") request.decision = null;
    if (this.preparations.has(s)) {
      // No Agent request exists to cancel or produce a completion receipt.
      // Keep submission protected until its pending checks/save finish.
      s.running = false;
      emit();
      return;
    }
    s.stopping = true;
    const isCurrentStop = this.start(s, current, emit);
    emit();
    try {
      if (dispatch) await dispatch();
      else
        await invoke("session_cancel", {
          agentId: s.agentId,
          cwd: s.cwd,
          sessionId: s.nativeSessionId,
        });
    } catch {
      if (
        !isCurrentStop() ||
        current() !== s ||
        (!s.running && !s.connectionOutcomeUnknown)
      )
        return;
      this.clear(s.key);
      s.stopping = false;
      s.stopUnconfirmed = true;
      pauseQueue(s, "uncertain");
      emit();
    }
    // Cancel acknowledgement is not the request's completion receipt.
  }

  clear(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(key);
  }

  start(
    s: ThreadState,
    current: () => ThreadState | undefined,
    emit: () => void,
  ): () => boolean {
    this.clear(s.key);
    s.stopUnconfirmed = false;
    const timer = setTimeout(() => {
      this.timers.delete(s.key);
      if (
        current() !== s ||
        (!s.running && !s.connectionOutcomeUnknown) ||
        !s.stopping
      )
        return;
      s.stopping = false;
      s.stopUnconfirmed = true;
      s.queuePaused = "uncertain";
      emit();
    }, 30_000);
    this.timers.set(s.key, timer);
    // Completion, expiry or a later retry retires this particular request.
    return () => this.timers.get(s.key) === timer;
  }
}
