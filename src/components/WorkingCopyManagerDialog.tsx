import {
  ArrowClockwise,
  CheckCircle,
  GitBranch,
  HardDrives,
  ShieldCheck,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  previewManagedWorktreeRemoval,
  removeManagedWorktree,
  workingCopySnapshot,
  type ManagedWorktreeRemovalBlocker,
  type ManagedWorktreeRemovalPreview,
  type ManagedWorktreeRemovalResult,
  type WorkingCopyRecord,
} from "../runtime/working-copy";

interface WorkingCopyManagerDialogProps {
  onClose: () => void;
}

const blockerLabels: Record<ManagedWorktreeRemovalBlocker, string> = {
  not_ready: "创建状态尚未就绪",
  removal_in_progress: "另一次移除仍在对账",
  already_removed: "Worktree 目录已经移除",
  bound_sessions: "仍有 Farfold Session 绑定到这里",
  path_unavailable: "Worktree 路径不可用",
  identity_mismatch: "Git 身份、路径或分支与 Host 记录不一致",
  changes_present: "Worktree 含 staged、unstaged、untracked 或冲突内容",
  git_unavailable: "Git 状态暂时无法验证",
};

function statusLabel(copy: WorkingCopyRecord): string {
  if (copy.removalState === "removed") return "目录已移除 · 分支已保留";
  if (copy.removalState === "failed") return "上次移除未完成";
  if (copy.removalState === "removing") return "正在对账移除结果";
  if (copy.managedState === "orphaned") return "需要人工检查 Git 资产";
  if (copy.managedState === "creating") return "正在对账创建结果";
  if (copy.boundSessionCount) {
    return `${copy.boundSessionCount} 个 Session 正在使用`;
  }
  if (copy.gitStatus.state === "clean") return "可检查移除条件";
  if (copy.gitStatus.state === "dirty") return "有本地改动";
  if (copy.gitStatus.state === "conflicted") return "有冲突";
  return "状态不可用";
}

function changeSummary(status: WorkingCopyRecord["gitStatus"]): string {
  if (status.state === "clean") return "Working Copy 当前干净";
  const parts = [
    status.stagedPathCount ? `${status.stagedPathCount} staged` : null,
    status.unstagedPathCount ? `${status.unstagedPathCount} unstaged` : null,
    status.untrackedPathCount ? `${status.untrackedPathCount} untracked` : null,
    status.conflictedPathCount
      ? `${status.conflictedPathCount} conflicted`
      : null,
  ].filter(Boolean);
  return parts.join(" · ") || status.state;
}

export function WorkingCopyManagerDialog({
  onClose,
}: WorkingCopyManagerDialogProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeDialog = useRef(onClose);
  const busyRef = useRef(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [copies, setCopies] = useState<WorkingCopyRecord[]>([]);
  const [selected, setSelected] =
    useState<ManagedWorktreeRemovalPreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [removed, setRemoved] = useState<ManagedWorktreeRemovalResult | null>(
    null,
  );
  const [phase, setPhase] = useState<
    "loading" | "idle" | "checking" | "removing"
  >("loading");
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== "idle";
  closeDialog.current = onClose;
  busyRef.current = busy;

  const managedCopies = useMemo(
    () => copies.filter((copy) => copy.managedState !== null),
    [copies],
  );

  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeButton.current?.focus();
    function onEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || busyRef.current) return;
      event.preventDefault();
      closeDialog.current();
    }
    window.addEventListener("keydown", onEscape);
    void reload();
    return () => {
      window.removeEventListener("keydown", onEscape);
      window.setTimeout(() => {
        const fallback = document.querySelector<HTMLElement>(
          "[data-session-context-trigger]",
        );
        const target = previousFocus.current;
        (target?.isConnected ? target : fallback)?.focus();
      }, 0);
    };
  }, []);

  async function reload() {
    setPhase("loading");
    setError(null);
    try {
      const snapshot = await workingCopySnapshot();
      setCopies(snapshot.workingCopies);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPhase("idle");
    }
  }

  async function inspect(copy: WorkingCopyRecord) {
    setPhase("checking");
    setError(null);
    setSelected(null);
    setRemoved(null);
    setConfirmation("");
    try {
      setSelected(await previewManagedWorktreeRemoval(copy.workingCopyId));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPhase("idle");
    }
  }

  async function executeRemoval() {
    if (!selected || confirmation !== selected.branchName) return;
    setPhase("removing");
    setError(null);
    try {
      const result = await removeManagedWorktree(selected);
      setRemoved(result);
      setSelected(null);
      setConfirmation("");
      const snapshot = await workingCopySnapshot();
      setCopies(snapshot.workingCopies);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPhase("idle");
    }
  }

  return (
    <div className="working-copy-manager-backdrop">
      <section
        className="working-copy-manager"
        role="dialog"
        aria-modal="true"
        aria-labelledby="working-copy-manager-title"
      >
        <header>
          <div>
            <small>Host Storage</small>
            <h2 id="working-copy-manager-title">Working Copy 管理</h2>
          </div>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭 Working Copy 管理"
          >
            <X size={17} />
          </button>
        </header>

        <div className="working-copy-manager-body">
          <div className="working-copy-manager-heading">
            <div>
              <HardDrives size={19} />
              <span>
                <strong>Farfold 管理的 Worktree</strong>
                <small>根检出和外部 Worktree 永远不会在这里被移除。</small>
              </span>
            </div>
            <button
              type="button"
              onClick={() => void reload()}
              disabled={busy}
              aria-label="刷新 Working Copy 状态"
            >
              <ArrowClockwise size={15} />
              刷新
            </button>
          </div>

          {phase === "loading" && !managedCopies.length ? (
            <p className="working-copy-manager-empty">
              正在读取 Host Working Copy 状态…
            </p>
          ) : managedCopies.length ? (
            <div className="working-copy-list">
              {managedCopies.map((copy) => (
                <article
                  key={copy.workingCopyId}
                  className={`working-copy-entry${copy.removalState === "removed" ? " removed" : ""}`}
                >
                  <GitBranch size={18} />
                  <div>
                    <strong>{copy.branchName ?? "detached HEAD"}</strong>
                    <code>{copy.canonicalPath}</code>
                    <span>{statusLabel(copy)}</span>
                    {copy.removalErrorCode && (
                      <small>记录：{copy.removalErrorCode}</small>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void inspect(copy)}
                    disabled={
                      busy ||
                      copy.removalState === "removed" ||
                      copy.removalState === "removing"
                    }
                  >
                    {copy.removalState === "removed" ? "已移除" : "检查移除"}
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <p className="working-copy-manager-empty">
              还没有由 Farfold 创建并管理的 Worktree。
            </p>
          )}

          {selected && (
            <section
              className="working-copy-removal-preview"
              aria-live="polite"
            >
              <header>
                <Warning size={19} />
                <span>
                  <strong>移除 Worktree 目录</strong>
                  <small>{selected.branchName}</small>
                </span>
              </header>
              <dl>
                <div>
                  <dt>当前 HEAD</dt>
                  <dd>{selected.currentHeadOid?.slice(0, 12) ?? "不可用"}</dd>
                </div>
                <div>
                  <dt>Git 状态</dt>
                  <dd>{changeSummary(selected.gitStatus)}</dd>
                </div>
              </dl>
              <div className="working-copy-removal-policy">
                <ShieldCheck size={18} />
                <p>
                  仅移除 Worktree 目录。分支{" "}
                  <strong>{selected.branchName}</strong>
                  、Project、源 Working Copy 与 Runtime
                  原生历史都会保留；不会删除任何 Farfold Session。
                </p>
              </div>
              {selected.blockers.length > 0 && (
                <ul className="working-copy-removal-blockers">
                  {selected.blockers.map((blocker) => (
                    <li key={blocker}>{blockerLabels[blocker]}</li>
                  ))}
                </ul>
              )}
              {selected.executionEnabled && (
                <label className="working-copy-removal-confirmation">
                  <span>
                    输入分支名 <code>{selected.branchName}</code> 以确认
                  </span>
                  <input
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              )}
              <footer>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(null);
                    setConfirmation("");
                  }}
                  disabled={busy}
                >
                  返回
                </button>
                <button
                  className="danger"
                  type="button"
                  onClick={() => void executeRemoval()}
                  disabled={
                    busy ||
                    !selected.executionEnabled ||
                    confirmation !== selected.branchName
                  }
                >
                  <Trash size={15} />
                  {phase === "removing" ? "正在移除…" : "移除 Worktree 目录"}
                </button>
              </footer>
            </section>
          )}

          {removed && (
            <div className="working-copy-removal-success" aria-live="polite">
              <CheckCircle size={20} weight="fill" />
              <span>
                <strong>Worktree 目录已移除</strong>
                <small>
                  分支 {removed.branchName} 已保留，可继续恢复或合并。
                </small>
              </span>
            </div>
          )}

          {error && (
            <p className="working-copy-manager-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
