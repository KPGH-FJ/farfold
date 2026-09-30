import type { ThreadState } from "./session_types";

/** A cancel acknowledgement is not a prompt completion. No normal-task timeout. */
export class StopConfirmation {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

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
