import {
  ArrowRight,
  CheckCircle,
  GitBranch,
  Warning,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HostSessionBinding } from "../runtime/host-shadow";
import {
  createManagedWorktree,
  previewManagedWorktree,
  type ManagedWorktreeCreateResult,
  type ManagedWorktreePreview,
  type WorkingCopyGitStatus,
} from "../runtime/working-copy";

interface ManagedWorktreeDialogProps {
  session: HostSessionBinding;
  onCreateSession: (workingCopyPath: string) => Promise<void>;
  onClose: () => void;
}

function suggestedBranch(session: HostSessionBinding): string {
  const title = session.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
  const suffix = session.farfoldSessionId.slice(-8).toLowerCase();
  return `farfold/${title || "session"}-${suffix}`;
}

function statusSummary(status: WorkingCopyGitStatus): string {
  if (status.state === "clean") return "源 Working Copy 当前干净";
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

export function ManagedWorktreeDialog({
  session,
  onCreateSession,
  onClose,
}: ManagedWorktreeDialogProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeDialog = useRef(onClose);
  const busyRef = useRef(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [branchName, setBranchName] = useState(() => suggestedBranch(session));
  const [preview, setPreview] = useState<ManagedWorktreePreview | null>(null);
  const [created, setCreated] = useState<ManagedWorktreeCreateResult | null>(
    null,
  );
  const [useHeadOnly, setUseHeadOnly] = useState(false);
  const [phase, setPhase] = useState<
    "idle" | "previewing" | "creating" | "opening"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== "idle";
  closeDialog.current = onClose;
  busyRef.current = busy;
  const shortHead = useMemo(
    () => preview?.sourceHeadOid.slice(0, 12) ?? null,
    [preview?.sourceHeadOid],
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
    return () => {
      window.removeEventListener("keydown", onEscape);
      window.setTimeout(() => {
        const fallback = document.querySelector<HTMLElement>(
          "[data-worktree-trigger]",
        );
        const target = previousFocus.current;
        (target?.isConnected ? target : fallback)?.focus();
      }, 0);
    };
  }, []);

  async function inspect() {
    const branch = branchName.trim();
    if (!branch) {
      setError("请填写新分支名称。");
      return;
    }
    setError(null);
    setPreview(null);
    setCreated(null);
    setUseHeadOnly(false);
    setPhase("previewing");
    try {
      setPreview(await previewManagedWorktree(session.workingCopyId, branch));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPhase("idle");
    }
  }

  async function create() {
    if (!preview) return;
    if (preview.requiresLocalChangesChoice && !useHeadOnly) {
      setError("源 Working Copy 有本地改动；请明确选择只使用当前 HEAD。");
      return;
    }
    setError(null);
    setPhase("creating");
    try {
      setCreated(
        await createManagedWorktree(
          preview,
          preview.requiresLocalChangesChoice ? "use_head_only" : undefined,
        ),
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPhase("idle");
    }
  }

  async function openCreated() {
    if (!created) return;
    setError(null);
    setPhase("opening");
    try {
      await onCreateSession(created.workingCopyPath);
      onClose();
    } catch (reason) {
      setError(String(reason));
      setPhase("idle");
    }
  }

  return (
    <div className="managed-worktree-backdrop">
      <section
        className="managed-worktree-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="managed-worktree-title"
      >
        <header>
          <div>
            <small>Working Copy 隔离</small>
            <h2 id="managed-worktree-title">创建独立 Worktree</h2>
          </div>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭创建 Worktree"
          >
            <X size={17} />
          </button>
        </header>

        {!created ? (
          <>
            <p className="managed-worktree-intro">
              从当前精确 HEAD 创建新分支。Farfold 不会
              stash、reset，也不会静默复制本地改动。
            </p>
            <label className="managed-worktree-field">
              <span>新分支</span>
              <input
                value={branchName}
                onChange={(event) => {
                  setBranchName(event.target.value);
                  setPreview(null);
                  setUseHeadOnly(false);
                }}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="managed-worktree-source">
              <span>{session.projectName}</span>
              <code>{session.workingCopyPath}</code>
            </div>

            {preview && (
              <div className="managed-worktree-preview" aria-live="polite">
                <div>
                  <GitBranch size={18} />
                  <span>
                    <strong>{preview.branchName}</strong>
                    <small>
                      {preview.sourceBranchName ?? "detached HEAD"} ·{" "}
                      {shortHead}
                    </small>
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>源状态</dt>
                    <dd>{statusSummary(preview.sourceGitStatus)}</dd>
                  </div>
                  <div>
                    <dt>新位置</dt>
                    <dd>{preview.workingCopyPath}</dd>
                  </div>
                </dl>
                {preview.requiresLocalChangesChoice && (
                  <label className="managed-worktree-confirmation">
                    <input
                      type="checkbox"
                      checked={useHeadOnly}
                      onChange={(event) => setUseHeadOnly(event.target.checked)}
                    />
                    <span>
                      <Warning size={17} />
                      只使用当前 HEAD；不把 staged、unstaged、untracked
                      或冲突内容复制到新 Worktree。
                    </span>
                  </label>
                )}
              </div>
            )}

            {error && (
              <p className="managed-worktree-error" role="alert">
                {error}
              </p>
            )}

            <footer>
              <button type="button" onClick={onClose} disabled={busy}>
                取消
              </button>
              {!preview ? (
                <button
                  className="primary"
                  type="button"
                  onClick={() => void inspect()}
                  disabled={busy}
                >
                  {phase === "previewing" ? "检查中…" : "检查创建条件"}
                </button>
              ) : (
                <button
                  className="primary"
                  type="button"
                  onClick={() => void create()}
                  disabled={
                    busy || (preview.requiresLocalChangesChoice && !useHeadOnly)
                  }
                >
                  {phase === "creating" ? "创建中…" : "创建 Worktree"}
                </button>
              )}
            </footer>
          </>
        ) : (
          <div className="managed-worktree-success" aria-live="polite">
            <CheckCircle size={28} weight="fill" />
            <h3>独立 Worktree 已创建</h3>
            <p>{created.branchName}</p>
            <code>{created.workingCopyPath}</code>
            <span>
              分支从 {created.sourceHeadOid.slice(0, 12)} 创建；原 Working Copy
              未被修改。
            </span>
            {error && (
              <p className="managed-worktree-error" role="alert">
                {error}
              </p>
            )}
            <footer>
              <button type="button" onClick={onClose} disabled={busy}>
                稍后使用
              </button>
              <button
                className="primary"
                type="button"
                onClick={() => void openCreated()}
                disabled={busy}
              >
                {phase === "opening" ? "正在创建 Session…" : "在此新建 Session"}
                <ArrowRight size={16} />
              </button>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}
