import {
  ArrowClockwise,
  Check,
  FileText,
  FolderOpen,
  GitDiff,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  refreshHostNavigation,
  type HostSessionBinding,
} from "../runtime/host-shadow";
import {
  markTurnChangesReviewed,
  turnChangeFilePreview,
  turnChangePathDiffPreview,
  type TurnChangeFilePreview,
  type TurnChangePathDiffPreview,
  turnChangeReviewSnapshot,
  type TurnChangeKind,
  type TurnChangeReview,
  type TurnChangeFileState,
  type TurnChangeCurrentPathState,
} from "../runtime/turn-changes";
import { revealProjectFile } from "../runtime/project-file-reference";
import {
  workingCopySnapshot,
  type WorkingCopyRecord,
} from "../runtime/working-copy";

interface TurnChangesSectionProps {
  session: HostSessionBinding;
}

const CHANGE_KIND_LABELS: Record<TurnChangeKind, string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
  copied: "复制",
  untracked: "未跟踪",
  conflicted: "冲突",
};

const FILE_STATE_LABELS: Record<TurnChangeFileState, string> = {
  text: "文本",
  binary: "二进制",
  large: "大文件",
  deleted: "已删除",
  missing: "缺失",
  not_regular: "非普通文件",
  outside_working_copy: "越界",
  unknown: "未知",
};

const CURRENT_PATH_LABELS: Record<TurnChangeCurrentPathState, string> = {
  matches_recorded_paths: "当前路径集合仍匹配终止快照",
  changed_after_turn: "终止后路径集合已有变化",
  unavailable: "当前路径集合不可核对",
  not_applicable: "无 Turn 级路径快照",
};

function shortOid(oid: string | null): string {
  return oid?.slice(0, 8) ?? "—";
}

function projectStatusLabel(workingCopy: WorkingCopyRecord | null): string {
  if (!workingCopy) return "当前项目状态不可用";
  const status = workingCopy.gitStatus;
  if (status.state === "clean") return "当前项目干净";
  if (status.state === "not_git") return "当前目录不是 Git Working Copy";
  if (status.state === "unavailable") return "当前项目状态不可用";
  const details = [
    status.stagedPathCount ? `已暂存 ${status.stagedPathCount}` : null,
    status.unstagedPathCount ? `未暂存 ${status.unstagedPathCount}` : null,
    status.untrackedPathCount ? `未跟踪 ${status.untrackedPathCount}` : null,
    status.conflictedPathCount ? `冲突 ${status.conflictedPathCount}` : null,
  ].filter(Boolean);
  return details.length ? `当前项目：${details.join(" · ")}` : "当前项目有变化";
}

function reviewExplanation(review: TurnChangeReview): string {
  if (review.provenanceState === "available") {
    return review.changePathCount
      ? "这些路径是在该 Turn 的干净基线与终止快照之间观察到的变化；这不等同于声称全部由 Agent 造成。"
      : "该 Turn 的干净基线与终止快照一致，没有观察到路径变化。";
  }
  if (review.provenanceState === "capturing") {
    return "Host 已建立干净基线，正在等待这个 Turn 的终止快照。";
  }
  if (review.provenanceState === "interrupted") {
    return "应用在终止快照完成前重启；Host 没有为这个 Turn 推断或补写变化。";
  }
  if (review.provenanceState === "failed") {
    return "Host 无法形成可审阅的 Turn 级证据，没有把项目变化归到这个 Turn。";
  }
  if (review.terminalReason === "working_copy_not_clean_at_turn_start") {
    return "Turn 开始前 Working Copy 已有变化，无法把终止状态可靠归到这个 Turn。";
  }
  if (review.terminalReason === "working_copy_not_managed") {
    return "当前不是 Farfold 管理的隔离 Worktree，只提供项目级状态。";
  }
  return "Host 无法证明 Turn 级边界，只提供项目级状态。";
}

function reviewTitle(review: TurnChangeReview): string {
  if (review.provenanceState === "available") return "Turn 观察到的变化";
  if (review.provenanceState === "capturing") return "正在观察 Turn";
  if (review.provenanceState === "interrupted") return "Turn 观察已中断";
  return "仅项目级状态";
}

function canReveal(state: TurnChangeFileState): boolean {
  return state === "text" || state === "binary" || state === "large";
}

function canPreview(state: TurnChangeFileState): boolean {
  return state === "text" || state === "binary" || state === "large";
}

function previewSourceLabel(preview: TurnChangeFilePreview): string {
  if (preview.source === "current_disk") return "当前磁盘";
  return "未知来源";
}

function diffSourceLabel(preview: TurnChangePathDiffPreview): string {
  if (preview.source === "current_disk_against_baseline")
    return "记录基线 → 当前磁盘";
  return "未知来源";
}

export function TurnChangesSection({ session }: TurnChangesSectionProps) {
  const [reviews, setReviews] = useState<TurnChangeReview[]>([]);
  const [workingCopy, setWorkingCopy] = useState<WorkingCopyRecord | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [markingTurnId, setMarkingTurnId] = useState<string | null>(null);
  const [revealingPath, setRevealingPath] = useState<string | null>(null);
  const [previewingPath, setPreviewingPath] = useState<string | null>(null);
  const [diffingPath, setDiffingPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<TurnChangeFilePreview | null>(null);
  const [diffPreview, setDiffPreview] =
    useState<TurnChangePathDiffPreview | null>(null);
  const requestSequence = useRef(0);
  const previewSequence = useRef(0);

  const refresh = useCallback(async () => {
    const request = requestSequence.current + 1;
    requestSequence.current = request;
    previewSequence.current += 1;
    setLoading(true);
    setError(null);
    setPreview(null);
    setDiffPreview(null);
    try {
      const [nextReviews, snapshot] = await Promise.all([
        turnChangeReviewSnapshot(session.farfoldSessionId),
        workingCopySnapshot(),
      ]);
      if (request !== requestSequence.current) return;
      setReviews(nextReviews);
      setWorkingCopy(
        snapshot.workingCopies.find(
          (candidate) => candidate.workingCopyId === session.workingCopyId,
        ) ?? null,
      );
      await refreshHostNavigation().catch(() => undefined);
    } catch (reason) {
      if (request !== requestSequence.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request === requestSequence.current) setLoading(false);
    }
  }, [session.farfoldSessionId, session.workingCopyId]);

  useEffect(() => {
    void refresh();
    return () => {
      requestSequence.current += 1;
      previewSequence.current += 1;
    };
  }, [refresh]);

  async function markReviewed(review: TurnChangeReview) {
    setMarkingTurnId(review.turnId);
    setError(null);
    try {
      await markTurnChangesReviewed(session.farfoldSessionId, review.turnId);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMarkingTurnId(null);
    }
  }

  async function previewChange(review: TurnChangeReview, path: string) {
    const request = ++previewSequence.current;
    const previewKey = `${review.turnId}:${path}`;
    setPreviewingPath(previewKey);
    setError(null);
    try {
      const nextPreview = await turnChangeFilePreview(
        session.farfoldSessionId,
        review.turnId,
        path,
      );
      if (request !== previewSequence.current) return;
      setPreview(nextPreview);
      setDiffPreview(null);
    } catch (reason) {
      if (request !== previewSequence.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPreviewingPath(null);
    }
  }

  async function diffChange(review: TurnChangeReview, path: string) {
    const request = ++previewSequence.current;
    const diffKey = `${review.turnId}:${path}`;
    setDiffingPath(diffKey);
    setError(null);
    try {
      const nextPreview = await turnChangePathDiffPreview(
        session.farfoldSessionId,
        review.turnId,
        path,
      );
      if (request !== previewSequence.current) return;
      setDiffPreview(nextPreview);
      setPreview(null);
    } catch (reason) {
      if (request !== previewSequence.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDiffingPath(null);
    }
  }

  async function revealChange(path: string) {
    setRevealingPath(path);
    setError(null);
    try {
      await revealProjectFile(
        {
          farfoldSessionId: session.farfoldSessionId,
          nativeSessionId: session.nativeSessionId,
        },
        path,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRevealingPath(null);
    }
  }

  return (
    <div className="turn-changes-panel">
      <header>
        <span>
          <GitDiff size={16} />
          <span>
            <strong>磁盘 / Git 事实</strong>
            <small>Agent 工具报告保留在消息流</small>
          </span>
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="刷新 Turn Changes"
        >
          <ArrowClockwise size={14} className={loading ? "spinning" : ""} />
        </button>
      </header>

      {error && (
        <p className="turn-changes-error" role="alert">
          <WarningCircle size={14} />
          {error}
        </p>
      )}

      {!loading && reviews.length === 0 && (
        <p className="turn-changes-empty">
          尚无 Turn 记录。提交下一条消息后，Host
          会判断能否建立可审阅的变化边界。
        </p>
      )}

      <div className="turn-changes-list">
        {reviews.map((review) => (
          <article
            key={review.turnId}
            className={`turn-change-review ${review.reviewedAt ? "reviewed" : "unreviewed"}`}
          >
            <header>
              <div>
                <strong>{reviewTitle(review)}</strong>
                <small>
                  {review.runtimeProductId} · {review.turnId}
                </small>
              </div>
              {review.reviewedAt ? (
                <span className="turn-change-reviewed">
                  <Check size={12} /> 已审阅
                </span>
              ) : review.completedAt ? (
                <button
                  type="button"
                  onClick={() => void markReviewed(review)}
                  disabled={markingTurnId === review.turnId}
                >
                  标记记录已审阅
                </button>
              ) : null}
            </header>

            <p>{reviewExplanation(review)}</p>

            {review.provenanceState === "available" ? (
              <>
                <div className="turn-change-range">
                  <span>基线</span>
                  <code>{shortOid(review.baselineHeadOid)}</code>
                  <span>→</span>
                  <span>终止</span>
                  <code>{shortOid(review.terminalHeadOid)}</code>
                  <em>{review.changePathCount} 个路径</em>
                </div>
                <div className="turn-change-current">
                  {CURRENT_PATH_LABELS[review.currentPathState]}
                </div>
                {review.changes.length > 0 && (
                  <ul>
                    {review.changes.map((change) => (
                      <li key={`${change.changeKind}:${change.relativePath}`}>
                        <span data-change-kind={change.changeKind}>
                          {CHANGE_KIND_LABELS[change.changeKind]}
                        </span>
                        <div>
                          <code title={change.relativePath}>
                            {change.previousPath
                              ? `${change.previousPath} → ${change.relativePath}`
                              : change.relativePath}
                          </code>
                          <small data-file-state={change.fileState}>
                            {FILE_STATE_LABELS[change.fileState]}
                          </small>
                        </div>
                        <span className="turn-change-actions">
                          <button
                            type="button"
                            aria-label={`查看差异 ${change.relativePath}`}
                            title="查看记录基线到当前磁盘的差异"
                            disabled={
                              !canPreview(change.fileState) ||
                              diffingPath ===
                                `${review.turnId}:${change.relativePath}`
                            }
                            onClick={() =>
                              void diffChange(review, change.relativePath)
                            }
                          >
                            <GitDiff size={12} />
                          </button>
                          <button
                            type="button"
                            aria-label={`预览 ${change.relativePath}`}
                            title="预览当前磁盘内容"
                            disabled={
                              !canPreview(change.fileState) ||
                              previewingPath ===
                                `${review.turnId}:${change.relativePath}`
                            }
                            onClick={() =>
                              void previewChange(review, change.relativePath)
                            }
                          >
                            <FileText size={12} />
                          </button>
                          <button
                            type="button"
                            aria-label={`在访达中显示 ${change.relativePath}`}
                            title="在访达中显示"
                            disabled={
                              !canReveal(change.fileState) ||
                              revealingPath === change.relativePath
                            }
                            onClick={() =>
                              void revealChange(change.relativePath)
                            }
                          >
                            <FolderOpen size={12} />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {diffPreview?.turnId === review.turnId && (
                  <section className="turn-change-preview">
                    <header>
                      <code title={diffPreview.relativePath}>
                        {diffPreview.relativePath}
                      </code>
                      <span>{FILE_STATE_LABELS[diffPreview.fileState]}</span>
                    </header>
                    <div className="turn-change-preview-meta">
                      <span>{diffSourceLabel(diffPreview)}</span>
                      <span>
                        基线 {shortOid(diffPreview.baselineHeadOid)} → 终止{" "}
                        {shortOid(diffPreview.terminalHeadOid)}
                      </span>
                      <span>
                        {CURRENT_PATH_LABELS[diffPreview.currentPathState]}
                      </span>
                    </div>
                    <p>{diffPreview.detail}</p>
                    {diffPreview.text !== null && (
                      <pre>{diffPreview.text || " "}</pre>
                    )}
                  </section>
                )}
                {preview?.turnId === review.turnId && (
                  <section className="turn-change-preview">
                    <header>
                      <code title={preview.relativePath}>
                        {preview.relativePath}
                      </code>
                      <span>{FILE_STATE_LABELS[preview.fileState]}</span>
                    </header>
                    <div className="turn-change-preview-meta">
                      <span>{previewSourceLabel(preview)}</span>
                      <span>
                        基线 {shortOid(preview.baselineHeadOid)} → 终止{" "}
                        {shortOid(preview.terminalHeadOid)}
                      </span>
                      <span>
                        {CURRENT_PATH_LABELS[preview.currentPathState]}
                      </span>
                      {preview.byteCount !== null && (
                        <span>{preview.byteCount} 字节</span>
                      )}
                    </div>
                    <p>{preview.detail}</p>
                    {preview.text !== null && <pre>{preview.text || " "}</pre>}
                  </section>
                )}
              </>
            ) : review.provenanceState !== "capturing" ? (
              <div className="turn-change-project-status">
                {projectStatusLabel(workingCopy)}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
