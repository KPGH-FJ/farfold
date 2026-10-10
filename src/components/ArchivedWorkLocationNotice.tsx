import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import {
  currentWorkLocationGuidance,
  sameWorkLocationGuidance,
  useWorkLocationGuidance,
} from "../runtime/archived_work_location";
import { ARCHIVED_WORK_LOCATION as S } from "../runtime/archived_work_location_strings";
import { worktreeManagement } from "../runtime/worktree_management";
import { ErrorNotice } from "./ErrorNotice";

export function ArchivedWorkLocationNotice({
  cwd,
  active,
  archiveHandled = false,
  archiveDetails,
  ...fallback
}: ComponentProps<typeof ErrorNotice> & {
  cwd: string | null;
  active: boolean;
  archiveHandled?: boolean;
  archiveDetails?: ReactNode;
}) {
  const archive = useWorkLocationGuidance(cwd, active);
  const current = useRef({ cwd, active, archive });
  current.current = { cwd, active, archive };
  const mounted = useRef(true);
  const button = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (!archive) return <ErrorNotice {...fallback} />;
  if (archiveHandled)
    return archive.kind === "archive" ? null : <ErrorNotice {...fallback} />;
  const guidance = (
    <ErrorNotice
      className={fallback.className}
      role={fallback.role}
      message={archive.kind === "archive" ? S.notice : S.recoveryNotice}
      detail={archive.kind === "archive" ? fallback.detail : undefined}
    >
      {archive.kind === "archive" && archiveDetails}
      <button
        type="button"
        className="btn btn-ghost"
        ref={button}
        onClick={() => {
          if (
            !mounted.current ||
            !current.current.active ||
            current.current.cwd !== cwd ||
            !sameWorkLocationGuidance(current.current.archive, archive) ||
            !sameWorkLocationGuidance(currentWorkLocationGuidance(cwd), archive)
          )
            return;
          worktreeManagement.open({
            cwd,
            target: null,
            returnFocusRef: button,
          });
        }}
      >
        {archive.kind === "archive" ? S.manage : S.recoveryManage}
      </button>
    </ErrorNotice>
  );
  // A retained backup does not establish that the original directory is absent.
  return archive.kind === "archive" ? (
    guidance
  ) : (
    <>
      <ErrorNotice {...fallback} />
      {guidance}
    </>
  );
}
