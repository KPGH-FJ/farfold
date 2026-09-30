import {
  hasPendingRequests,
  type PromptBlock,
  type ThreadState,
} from "./session_types";
import { queuedAttachmentsNeedReview } from "./recovered_attachments";
export type QueuePause =
  | "work_disabled"
  | "unavailable"
  | "failed"
  | "uncertain"
  | "stopped"
  | "no_result"
  | null;
export interface PromptAdmission {
  status: "accepted" | "rejected" | "unknown";
  reason?:
    | "work_disabled"
    | "unavailable"
    | "uncertain"
    | "failed"
    | "config_blocked"
    | "config_confirmation_required"
    | "config_record_failed"
    | "service_unavailable";
}
export function pauseQueue(s: ThreadState, reason: QueuePause): void {
  s.queuePaused = reason;
}
function canAdmit(s: ThreadState): boolean {
  return (
    !s.running &&
    !s.submitting &&
    !s.reconnecting &&
    !s.configuring &&
    !s.configError &&
    !s.stopping &&
    !s.uncertainPrompt &&
    !s.connectionOutcomeUnknown &&
    !hasPendingRequests(s) &&
    (!s.permissionConfigId || s.permissionState === "ready") &&
    !s.stopUnconfirmed &&
    !s.modelDrift &&
    !s.connectionLost &&
    !s.openError &&
    s.workEnabled
  );
}
export function canDrain(s: ThreadState): boolean {
  return (
    canAdmit(s) &&
    !s.queuePaused &&
    !s.queued.some(queuedAttachmentsNeedReview) &&
    s.queued.length > 0
  );
}
/** An explicit new message can release an empty pause; existing input stays paused. */
export function canReleaseEmptyQueuePause(
  s: ThreadState,
  blocks?: PromptBlock[],
): boolean {
  return (
    (s.queuePaused === "stopped" ||
      s.queuePaused === "work_disabled" ||
      s.queuePaused === "no_result") &&
    s.queued.length === 0 &&
    canAdmit(s) &&
    (!blocks || !queuedAttachmentsNeedReview(blocks))
  );
}
export function removeQueued(s: ThreadState, blocks: PromptBlock[]): void {
  const i = s.queued.indexOf(blocks);
  if (i >= 0) s.queued.splice(i, 1);
}
