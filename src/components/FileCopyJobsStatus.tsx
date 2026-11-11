import { fileCopyJobs, useFileCopyJobs } from "../runtime/file_copy_jobs";
import type { VerifiedFile } from "../runtime/file_delivery";
import { samePreviewFile } from "../runtime/preview_capture";
import { copyTerminal } from "../runtime/file_copy_types";
import { FILE_COPY_STRINGS as S } from "../runtime/file_copy_strings";
import { SavedCopyActions } from "./SavedCopyActions";
export function FileCopyJobsStatus({
  file,
  active = true,
}: {
  file?: VerifiedFile;
  active?: boolean;
}) {
  const jobs = useFileCopyJobs().filter(
    (j) => !file || samePreviewFile(j.file, file),
  );
  if (!jobs.length) return null;
  return (
    <section
      className="artifact-provenance file-copy-jobs"
      aria-label={S.statusLabel}
    >
      <p>{S.scope}</p>
      {jobs.map((job) => (
        <div key={job.id} style={{ overflowWrap: "anywhere" }}>
          <p>
            <strong>{job.file.name}</strong> · {job.destination}
          </p>
          <p role="status">
            {job.phase === "preparing"
              ? S.preparing
              : job.phase === "notStarted"
                ? job.code
                  ? S.rejected
                  : S.notStarted
                : job.phase === "uncertain"
                  ? S.uncertain
                  : job.status
                    ? S.states[job.status.state]
                    : S.uncertain}
            {job.code ? ` ${S.failures[job.code]}` : ""}
          </p>
          {job.closeFailed && <p role="status">{S.closeFailed}</p>}
          {job.status && (
            <p>{S.progress(job.status.bytesCopied, job.status.total)}</p>
          )}
          <div className="ac-actions" style={{ flexWrap: "wrap" }}>
            <SavedCopyActions job={job} active={active} />
            {job.phase !== "notStarted" &&
              !job.absence &&
              (!job.status ||
                (!copyTerminal(job.status.state) && !job.status.settled)) && (
                <>
                  {job.status && (
                    <button
                      type="button"
                      className="btn btn-text"
                      disabled={job.checking}
                      onClick={() => void fileCopyJobs.check(job.id)}
                    >
                      {S.check}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-text"
                    onClick={() => void fileCopyJobs.cancel(job.id)}
                  >
                    {S.cancel}
                  </button>
                </>
              )}
            {(job.absence ||
              (job.status?.state === "unknown" && job.status.settled)) &&
              job.phase !== "notStarted" && (
                <button
                  type="button"
                  className="btn btn-text"
                  disabled={job.checking}
                  onClick={() => void fileCopyJobs.dismiss(job.id, true)}
                >
                  {S.closeUnknown}
                </button>
              )}
            {(job.phase === "notStarted" ||
              (job.phase === "known" &&
                job.status &&
                copyTerminal(job.status.state))) && (
              <button
                type="button"
                className="btn btn-text"
                disabled={job.checking}
                onClick={() => void fileCopyJobs.dismiss(job.id)}
              >
                {S.close}
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
