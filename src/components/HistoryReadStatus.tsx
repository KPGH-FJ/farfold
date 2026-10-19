import { useSyncExternalStore } from "react";
import { historyReads } from "../runtime/session_history_admission";
import { HISTORY_READ as S } from "../runtime/history_read_strings";

export function HistoryReadStatus({
  target,
  agentId,
  purpose,
  releaseOnly,
  active,
}: {
  target?: string;
  agentId?: string;
  purpose?: "preview";
  releaseOnly?: boolean;
  active: boolean;
}) {
  const reads = useSyncExternalStore(
    historyReads.subscribe,
    historyReads.getSnapshot,
    historyReads.getSnapshot,
  );
  if (!active) return null;
  return reads
    .filter((read) =>
      purpose
        ? (read.purpose === purpose && read.agentId === agentId) ||
          read.phase === "finishing"
        : releaseOnly
          ? read.phase === "finishing"
          : read.target === target && read.phase !== "finishing",
    )
    .map((read) => (
      <div className="history-read-status" role="status" key={read.token}>
        <span>{read.notice ?? S[read.phase]}</span>
        {(read.releaseRetry || read.releasing) && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={read.releasing}
            onClick={() => void historyReads.retryRelease(read.token)}
          >
            {read.releasing ? S.releasing : S.retryRelease}
          </button>
        )}
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
