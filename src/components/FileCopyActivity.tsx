import { useRef, useState } from "react";
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { useFileCopyJobs } from "../runtime/file_copy_jobs";
import { FILE_COPY_STRINGS as S } from "../runtime/file_copy_strings";
import { FileCopyJobsStatus } from "./FileCopyJobsStatus";
import { WorkspaceDialog } from "./WorkspaceDialog";

/** Saving continues when the source preview is closed or another file opens. */
export function FileCopyActivity() {
  const jobs = useFileCopyJobs();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  if (!jobs.length && !open) return null;
  return (
    <>
      <button
        type="button"
        className="product-settings"
        ref={opener}
        onClick={() => setOpen(true)}
      >
        <DownloadSimpleIcon size={18} />
        {S.activityCount(jobs.length)}
      </button>
      {open && (
        <WorkspaceDialog
          title={S.activityTitle}
          returnFocusRef={opener}
          onClose={() => setOpen(false)}
        >
          <div className="workspace-dialog-body">
            <FileCopyJobsStatus />
            {!jobs.length && <p role="status">{S.activityEmpty}</p>}
          </div>
          <footer>
            <button
              type="button"
              className="btn"
              onClick={() => setOpen(false)}
            >
              {S.back}
            </button>
          </footer>
        </WorkspaceDialog>
      )}
    </>
  );
}
