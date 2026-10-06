import type { ThreadState } from "../runtime/session_types";
import { useWorkPolicy } from "../runtime/work_policy";
import { STRINGS } from "../runtime/strings";

/** The parent already checked the conversation. Match the input's live work rule too. */
export function FailedToolQueueHint({ thread }: { thread: ThreadState }) {
  const work = useWorkPolicy(thread.cwd);
  return work.ready && work.enabled(thread.agentId) ? (
    <span>{STRINGS.thread.failedToolQueueHint}</span>
  ) : null;
}
