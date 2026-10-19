import type { ThreadState } from "../runtime/session_types";
import { threads } from "../runtime/sessions";
import { PROMPT_ADMISSION as S } from "../runtime/prompt_admission_strings";

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
  return (
    <div className="history-read-status" role="status">
      <span>
        {waiting?.notice ??
          (waiting?.phase === "waiting" ? S.waiting : S.preparing)}
      </span>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={waiting?.cancelling}
        onClick={() => void threads.cancel(thread.key)}
      >
        {waiting?.cancelling ? S.cancelling : S.cancel}
      </button>
    </div>
  );
}
