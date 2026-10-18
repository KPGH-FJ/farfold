import { useSyncExternalStore } from "react";
import { historyReads } from "../runtime/session_history_admission";
import { HISTORY_READ as S } from "../runtime/history_read_strings";

export function HistoryReadStatus({
  target,
  active,
}: {
  target: string;
  active: boolean;
}) {
  const reads = useSyncExternalStore(
    historyReads.subscribe,
    historyReads.getSnapshot,
    historyReads.getSnapshot,
  );
  if (!active) return null;
  return reads
    .filter((read) => read.target === target)
    .map((read) => (
      <div className="history-read-status" role="status" key={read.token}>
        <span>{read.notice ?? S[read.phase]}</span>
        {read.phase === "waiting" && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={read.cancelling}
            onClick={() => void historyReads.cancel(read.token)}
          >
            {read.cancelling ? S.cancelling : S.cancel}
          </button>
        )}
      </div>
    ));
}
