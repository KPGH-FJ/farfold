import type { ThreadState } from "../runtime/session_types";
import { getProgramStatus } from "../runtime/program_status";
import { PROGRAM_STATUS_STRINGS as S } from "../runtime/program_status_strings";
import "./ProgramStatusNotice.css";

type Status = NonNullable<ReturnType<typeof getProgramStatus>>;

/** A recent program message is information, never a work-completion receipt. */
export function ProgramStatusView({ status }: { status: Status }) {
  const characters = Array.from(status.message);
  const preview = characters.slice(0, 120).join("");
  const received = new Date(status.receivedAtMs);
  return (
    <aside className="program-status" aria-label={S.title}>
      <details
        onKeyDown={(event) => {
          if (["Enter", " ", "Backspace"].includes(event.key))
            event.stopPropagation();
        }}
      >
        <summary>
          <span className="program-status-label">{S.label}</span>
          <span className="program-status-preview" role="status">
            {preview}
            {characters.length > 120 ? "…" : ""}
          </span>
        </summary>
        <div className="program-status-details">
          <p className="program-status-message">{status.message}</p>
          <p className="program-status-received">
            {S.received}：
            <time dateTime={received.toISOString()}>
              {received.toLocaleString()}
            </time>
          </p>
          {status.truncated && <p>{S.truncated}</p>}
        </div>
      </details>
    </aside>
  );
}

export function ProgramStatusNotice({
  thread,
  active,
}: {
  thread: ThreadState | null | undefined;
  active: boolean;
}) {
  if (!active || !thread) return null;
  const status = getProgramStatus(thread);
  return status ? <ProgramStatusView status={status} /> : null;
}
