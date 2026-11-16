import type { ThreadState } from "../runtime/session_types";
import { threads } from "../runtime/sessions";
import { PROMPT_ADMISSION as S } from "../runtime/prompt_admission_strings";
import { STRINGS } from "../runtime/strings";

export function PromptAdmissionStatus({
  thread,
  active,
}: {
  thread: ThreadState | null | undefined;
  active: boolean;
}) {
  if (
    !active ||
    !thread ||
    !thread.submitting ||
    thread.promptAdmission?.phase === "offered"
  )
    return null;
  const waiting = thread.promptAdmission;
  const observingStop = thread.stopping || thread.stopUnconfirmed;
  const cancelling = thread.stopping || waiting?.cancelling;
  const stopLabel = cancelling
    ? STRINGS.repair.stopping
    : STRINGS.repair.retryStop;
  return (
    <div className="history-read-status" role="status">
      <span>
        {observingStop
          ? S.unconfirmed
          : (waiting?.notice ??
            (waiting?.phase === "waiting" ? S.waiting : S.preparing))}
      </span>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={cancelling}
        onClick={() => void threads.cancel(thread.key)}
      >
        {observingStop ? stopLabel : cancelling ? S.cancelling : S.cancel}
      </button>
    </div>
  );
}
