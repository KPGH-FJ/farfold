import {
  PROJECT_FILES as F,
  PROJECT_FILE_LIMIT_REASONS,
} from "../runtime/project_files";
import type { ProjectFileScan } from "./useProjectFiles";
import "./ProjectFileScanNotice.css";

export function ProjectFileScanNotice({
  state,
  cwd,
  noMatch,
  matchesLimited,
  onCancel,
  onRetry,
  onChoose,
}: {
  state: ProjectFileScan | null;
  cwd: string | null | undefined;
  noMatch: boolean;
  matchesLimited: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onChoose: () => void;
}) {
  const r = state?.result;
  const skippedNonlocal = r?.counts.skippedNonlocalDirectories ?? 0;
  const pending = state?.phase === "pending";
  const loading =
    !!cwd &&
    (!state || state.phase === "loading" || state.phase === "cancelling");
  return (
    <div className="project-file-scan">
      <p role="status">
        {!cwd
          ? F.folder
          : (state?.error ??
            (state?.phase === "cancelling"
              ? F.cancelling
              : loading
                ? F.loading
                : r?.cancelled
                  ? F.cancelled
                  : r?.partial
                    ? F.partial
                    : r?.truncated
                      ? F.truncated
                      : noMatch
                        ? F.noMatch
                        : `已扫描 ${r?.files.length ?? 0} 个文件`))}
      </p>
      {r?.truncated && r.partial && <p>{F.truncated}</p>}
      {skippedNonlocal > 0 && <p>{F.skippedNonlocal(skippedNonlocal)}</p>}
      {matchesLimited && <p>{F.matchesLimited}</p>}
      {r && (
        <details>
          <summary>{F.scope}</summary>
          <p>{F.budget}</p>
          {r.limitReasons.length > 0 && (
            <p>
              {r.limitReasons
                .map((reason) => PROJECT_FILE_LIMIT_REASONS[reason])
                .join("、")}
            </p>
          )}
          <p>
            {F.excluded}：{r.excludedDirectoryNames.join("、") || "无"}
          </p>
          <p>
            {F.skipped}：{r.counts.skippedDirectories}；{F.unreadable}：
            {r.counts.unreadableDirectories} / {r.counts.unreadableEntries}；
            {F.names}：{r.counts.unsupportedNames}
          </p>
        </details>
      )}
      <div className="project-file-scan-actions">
        {(loading || pending) && (
          <button
            type="button"
            className="btn btn-text"
            disabled={
              !state || state.phase === "cancelling" || state.cancelRequested
            }
            onClick={onCancel}
          >
            {F.cancel}
          </button>
        )}
        {!loading && cwd && (
          <button type="button" className="btn btn-text" onClick={onRetry}>
            {F.retry}
          </button>
        )}
        <button type="button" className="btn btn-text" onClick={onChoose}>
          {F.choose}
        </button>
      </div>
    </div>
  );
}
