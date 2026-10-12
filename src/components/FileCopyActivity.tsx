import { useConversationArchiveJobs } from "../runtime/conversation_archive_jobs";
import { ConversationArchiveJobsStatus } from "./ConversationArchiveJobsStatus";
import { useRef, useState } from "react";
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { useFileCopyJobs } from "../runtime/file_copy_jobs";
import { FILE_COPY_STRINGS as S } from "../runtime/file_copy_strings";
import { FileCopyJobsStatus } from "./FileCopyJobsStatus";
import { WorkspaceDialog } from "./WorkspaceDialog";

/** Saving continues when the source preview is closed or another file opens. */
export function FileCopyActivity() {
  const jobs = useFileCopyJobs();
  const archives = useConversationArchiveJobs();
  const count = jobs.length + archives.length;
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  if (!count && !open) return null;
  return (
    <>
      <button
        type="button"
        className="product-settings"
        ref={opener}
        onClick={() => setOpen(true)}
      >
        <DownloadSimpleIcon size={18} />
        {S.activityCount(count)}
      </button>
      {open && (
        <WorkspaceDialog
          title={S.activityTitle}
          returnFocusRef={opener}
          onClose={() => setOpen(false)}
        >
          <div className="workspace-dialog-body">
            <FileCopyJobsStatus />
            <ConversationArchiveJobsStatus />
            {!count && <p role="status">{S.activityEmpty}</p>}
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
