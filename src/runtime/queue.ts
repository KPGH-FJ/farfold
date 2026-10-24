import {
  hasActiveTools,
  hasPendingRequests,
  type PromptBlock,
  type ThreadState,
} from "./session_types";
import { queuedAttachmentsNeedReview } from "./recovered_attachments";
import { forgetConfigurationPause } from "./configuration_pause";
import { hasActiveCompaction } from "./compaction_activity";
import { hasActiveFork } from "./session_fork_activity";
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
    | "send_wait_limit"
    | "send_wait_payload"
    | "send_wait_cancelled"
    | "send_wait_timeout"
    | "work_disabled"
    | "unavailable"
    | "uncertain"
    | "failed"
    | "config_blocked"
    | "config_confirmation_required"
    | "config_record_failed"
    | "service_unavailable"
    | "audio_unknown"
    | "audio_unsupported"
    | "audio_limit"
    | "audio_invalid"
    | "audio_format_unsupported"
    | "audio_duration_limit"
    | "embedded_context_unsupported"
    | "embedded_context_unknown"
    | "permission_scope_unverified";
}
export function pauseQueue(s: ThreadState, reason: QueuePause): void {
  forgetConfigurationPause(s);
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
    !hasActiveCompaction(s) &&
    !hasActiveFork(s) &&
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
      s.queuePaused === "no_result" ||
      (s.queuePaused === "failed" && s.activeToolCallIds.length === 0)) &&
    s.queued.length === 0 &&
    canAdmit(s) &&
    (!blocks || !queuedAttachmentsNeedReview(blocks))
  );
}

/** Display the two explicit queue actions; never relax admission or settle tools. */
export function canExplainFailedToolQueue(s: ThreadState): boolean {
  return (
    s.queuePaused === "failed" &&
    s.queued.length === 0 &&
    hasActiveTools(s) &&
    !s.sourceError &&
    !s.unrecoverable &&
    !s.historyUnavailable &&
    canAdmit(s)
  );
}
export function removeQueued(s: ThreadState, blocks: PromptBlock[]): void {
  const i = s.queued.indexOf(blocks);
  if (i >= 0) s.queued.splice(i, 1);
}
