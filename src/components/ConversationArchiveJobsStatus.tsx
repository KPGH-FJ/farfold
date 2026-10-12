import {
  conversationArchiveJobs,
  useConversationArchiveJobs,
} from "../runtime/conversation_archive_jobs";
import { ARCHIVE_STRINGS as S } from "../runtime/conversation_archive_strings";
export function ConversationArchiveJobsStatus({
  operationId,
}: {
  operationId?: string;
}) {
  const jobs = useConversationArchiveJobs().filter(
    (j) => !operationId || j.identity.operationId === operationId,
  );
  if (!jobs.length) return null;
  return (
    <section
      className="artifact-provenance file-copy-jobs"
      aria-label={S.activity}
    >
      {jobs.map((job) => {
        const r = job.reply;
        const ended =
          !!r && (r.state === "absent" ? r.admissionClosed : r.settled);
        const unknown = r?.state === "unknown" || r?.state === "absent";
        return (
          <div
            key={job.identity.operationId}
            style={{ overflowWrap: "anywhere" }}
          >
            <p>
              <strong>{S.activity}</strong> · {job.identity.destination}
            </p>
            <p role="status">
              {job.phase === "preparing"
                ? S.preparing
                : job.phase === "unconfirmed"
                  ? S.unconfirmed
                  : r && r.state !== "absent"
                    ? S.states[r.state]
                    : S.unconfirmed}
            </p>
            {job.cancelRequested && !ended && <p>{S.cancelRequested}</p>}
            {r?.state === "absent" && <p>{S.absence}</p>}
            {job.code && <p role="alert">{S.errors[job.code]}</p>}
            {r && r.state !== "absent" && (
              <p>
                {S.progress(
                  r.processedInputBytes,
                  r.totalInputBytes,
                  r.itemsCompleted,
                  r.includedCount,
                )}
              </p>
            )}
            {r?.state === "completed" && (
              <>
                <p>
                  {S.receipt(
                    r.receipt.zipSize,
                    r.receipt.includedCount,
                    r.receipt.omittedCount,
                  )}
                </p>
                <details>
                  <summary>文件校验信息</summary>
                  <code>SHA-256 {r.receipt.zipSha256}</code>
                </details>
              </>
            )}
            {job.closeFailed && <p role="alert">{S.closeFailed}</p>}
            <div className="ac-actions" style={{ flexWrap: "wrap" }}>
              {!ended && (
                <>
                  <button
                    type="button"
                    className="btn btn-text"
                    disabled={job.checking}
                    onClick={() =>
                      void conversationArchiveJobs.check(
                        job.identity.operationId,
                      )
                    }
                  >
                    {S.check}
                  </button>
                  <button
                    type="button"
                    className="btn btn-text"
                    onClick={() =>
                      void conversationArchiveJobs.cancel(
                        job.identity.operationId,
                      )
                    }
                  >
                    {S.cancel}
                  </button>
                </>
              )}
              {ended && (
                <button
                  type="button"
                  className="btn btn-text"
                  disabled={job.checking}
                  onClick={() =>
                    void conversationArchiveJobs.dismiss(
                      job.identity.operationId,
                      unknown,
                    )
                  }
                >
                  {unknown ? S.closeUnknown : S.closeResult}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
