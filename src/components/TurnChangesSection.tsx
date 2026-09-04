import {
  ArrowClockwise,
  Check,
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
  turnChangeReviewSnapshot,
  type TurnChangeKind,
  type TurnChangeReview,
} from "../runtime/turn-changes";
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

export function TurnChangesSection({ session }: TurnChangesSectionProps) {
  const [reviews, setReviews] = useState<TurnChangeReview[]>([]);
  const [workingCopy, setWorkingCopy] = useState<WorkingCopyRecord | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [markingTurnId, setMarkingTurnId] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    const request = requestSequence.current + 1;
    requestSequence.current = request;
    setLoading(true);
    setError(null);
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

  return (
    <div className="turn-changes-panel">
      <header>
        <span>
          <GitDiff size={16} />
          <strong>Per-Turn Changes</strong>
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
                  标记已审阅
                </button>
              ) : null}
            </header>

            <p>{reviewExplanation(review)}</p>

            {review.provenanceState === "available" ? (
              <>
                <div className="turn-change-range">
                  <code>{shortOid(review.baselineHeadOid)}</code>
                  <span>→</span>
                  <code>{shortOid(review.terminalHeadOid)}</code>
                  <em>{review.changePathCount} 个路径</em>
                </div>
                {review.changes.length > 0 && (
                  <ul>
                    {review.changes.map((change) => (
                      <li key={`${change.changeKind}:${change.relativePath}`}>
                        <span data-change-kind={change.changeKind}>
                          {CHANGE_KIND_LABELS[change.changeKind]}
                        </span>
                        <code title={change.relativePath}>
                          {change.previousPath
                            ? `${change.previousPath} → ${change.relativePath}`
                            : change.relativePath}
                        </code>
                      </li>
                    ))}
                  </ul>
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
