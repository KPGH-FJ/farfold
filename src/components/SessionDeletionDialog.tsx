import {
  Archive,
  CheckCircle,
  ShieldCheck,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import {
  deleteSessionMetadata,
  previewSessionDeletion,
  refreshHostNavigation,
  type DeletedSessionMetadata,
  type SessionDeletionBlocker,
  type SessionDeletionPreview,
} from "../runtime/host-shadow";

interface SessionDeletionDialogProps {
  sessionId: string;
  sessionTitle: string;
  onClose: () => void;
}

const blockerLabels: Record<SessionDeletionBlocker, string> = {
  session_not_archived: "请先归档这个 Session。",
  open_attention: "这个 Session 仍有待处理交互。",
  agent_runtimes_not_stopped: "请先停止 Pi 与 OpenCode Runtime。",
};

export function SessionDeletionDialog({
  sessionId,
  sessionTitle,
  onClose,
}: SessionDeletionDialogProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const closeDialog = useRef(onClose);
  const busyRef = useRef(true);
  const [preview, setPreview] = useState<SessionDeletionPreview | null>(null);
  const [deleted, setDeleted] = useState<DeletedSessionMetadata | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [phase, setPhase] = useState<"loading" | "idle" | "deleting">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== "idle";
  closeDialog.current = onClose;
  busyRef.current = busy;

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
    void inspect();
    return () => {
      window.removeEventListener("keydown", onEscape);
      window.setTimeout(() => {
        const fallback = document.querySelector<HTMLElement>(
          "[data-archive-filter]",
        );
        const target = previousFocus.current;
        (target?.isConnected ? target : fallback)?.focus();
      }, 0);
    };
  }, [sessionId]);

  async function inspect() {
    setPhase("loading");
    setError(null);
    try {
      setPreview(await previewSessionDeletion(sessionId));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPhase("idle");
    }
  }

  async function executeDeletion() {
    if (!preview || confirmation !== preview.farfoldSessionId) return;
    setPhase("deleting");
    setError(null);
    try {
      const result = await deleteSessionMetadata(preview);
      setDeleted(result);
      setPreview(null);
      setConfirmation("");
      try {
        await refreshHostNavigation();
      } catch (reason) {
        setError(`删除已完成，但 Session 列表刷新失败：${String(reason)}`);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPhase("idle");
    }
  }

  return (
    <div className="session-deletion-backdrop">
      <section
        className="session-deletion-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-deletion-title"
      >
        <header>
          <div>
            <small>Farfold metadata</small>
            <h2 id="session-deletion-title">删除已归档 Session 记录</h2>
          </div>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭 Session 删除确认"
          >
            <X size={17} />
          </button>
        </header>

        <div className="session-deletion-body">
          {phase === "loading" && !preview ? (
            <p className="session-deletion-loading">
              正在核对“{sessionTitle}”的删除边界…
            </p>
          ) : deleted ? (
            <div className="session-deletion-success" aria-live="polite">
              <CheckCircle size={28} weight="fill" />
              <h3>Farfold Session 记录已删除</h3>
              <p>
                Runtime 原生 Session 与历史仍然保留。Project、Working
                Copy、仓库和文件均未删除。
              </p>
              <button type="button" onClick={onClose}>
                完成
              </button>
            </div>
          ) : preview ? (
            <>
              <div className="session-deletion-target">
                <Archive size={20} />
                <span>
                  <strong>{preview.title}</strong>
                  <small>
                    {preview.runtimeProductId} · {preview.projectName}
                  </small>
                  <code>{preview.farfoldSessionId}</code>
                </span>
              </div>

              <div className="session-deletion-policy">
                <ShieldCheck size={19} />
                <div>
                  <strong>只删除 Farfold 拥有的记录</strong>
                  <p>
                    会删除此 Session 的 Farfold 元数据
                    {preview.effects.deletesDraft ? "、草稿" : ""}
                    {preview.effects.deletesAttentionRecordCount
                      ? `、${preview.effects.deletesAttentionRecordCount} 条处理记录`
                      : ""}
                    {preview.effects.deletesNativeLocator
                      ? "与原生定位引用"
                      : ""}
                    。 Runtime 原生 Session、历史、Project 与 Working Copy
                    会保留。
                  </p>
                </div>
              </div>

              <dl className="session-deletion-facts">
                <div>
                  <dt>原生 Session</dt>
                  <dd>{preview.nativeSessionId}</dd>
                </div>
                <div>
                  <dt>Working Copy</dt>
                  <dd>{preview.workingCopy.canonicalPath}</dd>
                </div>
                <div>
                  <dt>绑定数量</dt>
                  <dd>
                    {preview.workingCopy.boundSessionCount} 个 Farfold Session
                  </dd>
                </div>
              </dl>

              {preview.blockers.length > 0 && (
                <div className="session-deletion-blockers">
                  <Warning size={18} />
                  <ul>
                    {preview.blockers.map((blocker) => (
                      <li key={blocker}>{blockerLabels[blocker]}</li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.executionEnabled && (
                <label className="session-deletion-confirmation">
                  <span>
                    输入 Farfold Session ID{" "}
                    <code>{preview.farfoldSessionId}</code>
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
                <button type="button" onClick={onClose} disabled={busy}>
                  取消
                </button>
                <button
                  className="danger"
                  type="button"
                  onClick={() => void executeDeletion()}
                  disabled={
                    busy ||
                    !preview.executionEnabled ||
                    confirmation !== preview.farfoldSessionId
                  }
                >
                  <Trash size={15} />
                  {phase === "deleting" ? "正在删除…" : "删除 Farfold 记录"}
                </button>
              </footer>
            </>
          ) : null}

          {error && (
            <p className="session-deletion-error" role="alert">
              {error}
            </p>
          )}
          {!preview && !deleted && phase === "idle" && (
            <button
              className="session-deletion-retry"
              type="button"
              onClick={() => void inspect()}
            >
              重新检查
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
