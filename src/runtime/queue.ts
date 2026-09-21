import type { PromptBlock, ThreadState } from "./session_types";
export type QueuePause =
  "work_disabled" | "unavailable" | "failed" | "uncertain" | "stopped" | null;
export interface PromptAdmission {
  status: "accepted" | "rejected" | "unknown";
  reason?: "work_disabled" | "unavailable" | "uncertain" | "failed";
}
export function pauseQueue(s: ThreadState, reason: QueuePause): void {
  s.queuePaused = reason;
}
export function canDrain(s: ThreadState): boolean {
  return (
    !s.running &&
    !s.submitting &&
    !s.reconnecting &&
    !s.configuring &&
    !s.configError &&
    !s.connectionLost &&
    !s.openError &&
    !s.queuePaused &&
    s.workEnabled &&
    s.queued.length > 0
  );
}
export function removeQueued(s: ThreadState, blocks: PromptBlock[]): void {
  const i = s.queued.indexOf(blocks);
  if (i >= 0) s.queued.splice(i, 1);
}
