import { Brain, GitBranch, IdentificationCard, X } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import type { HostSessionBinding } from "../runtime/host-shadow";

interface SessionContextPanelProps {
  session: HostSessionBinding | null;
  lifeModelItemCount: number;
  onOpenLifeModel: () => void;
  onClose: () => void;
}

function runtimeName(productId: string): string {
  if (productId === "pi") return "Pi";
  if (productId === "opencode") return "OpenCode";
  return productId;
}

export function SessionContextPanel({
  session,
  lifeModelItemCount,
  onOpenLifeModel,
  onClose,
}: SessionContextPanelProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const closePanel = useRef(onClose);
  const previousFocus = useRef<HTMLElement | null>(null);
  closePanel.current = onClose;

  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeButton.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      closePanel.current();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.setTimeout(() => {
        const fallback = document.querySelector<HTMLElement>(
          "[data-session-context-trigger]",
        );
        const target = previousFocus.current;
        (target?.isConnected ? target : fallback)?.focus();
      }, 0);
    };
  }, []);

  return (
    <aside
      className="session-context-panel"
      aria-labelledby="session-context-title"
    >
      <header>
        <div>
          <small>上下文</small>
          <h2 id="session-context-title">对话详情</h2>
        </div>
        <button
          ref={closeButton}
          type="button"
          onClick={onClose}
          aria-label="关闭对话详情"
        >
          <X size={16} />
        </button>
      </header>

      {session ? (
        <>
          <section>
            <span className="context-section-icon">
              <IdentificationCard size={16} />
            </span>
            <div>
              <small>Agent Runtime</small>
              <strong>{runtimeName(session.runtimeProductId)}</strong>
              <p>{session.nativeSessionId}</p>
            </div>
          </section>

          <section>
            <span className="context-section-icon">
              <GitBranch size={16} />
            </span>
            <div>
              <small>Working Copy</small>
              <strong>{session.projectName}</strong>
              <p>{session.workingCopyPath}</p>
              <em>
                {session.workingCopyKind === "worktree" ? "Worktree" : "根检出"}
                {session.branchName ? ` · ${session.branchName}` : ""}
              </em>
            </div>
          </section>

          <details className="context-identities">
            <summary>连接身份</summary>
            <dl>
              <div>
                <dt>Installation</dt>
                <dd>{session.installationId}</dd>
              </div>
              <div>
                <dt>Connection</dt>
                <dd>{session.connectionId}</dd>
              </div>
              <div>
                <dt>Adapter</dt>
                <dd>{session.adapterId}</dd>
              </div>
            </dl>
          </details>

          <button
            className="context-lifemodel"
            data-lifemodel-trigger
            onClick={onOpenLifeModel}
          >
            <Brain size={17} />
            <span>
              <strong>LifeModel</strong>
              <small>
                {lifeModelItemCount
                  ? `${lifeModelItemCount} 项可选上下文`
                  : "没有可用条目"}
              </small>
            </span>
          </button>
        </>
      ) : (
        <div className="context-empty">
          <p>尚未选择 Farfold Session。</p>
          <span>选择或创建对话后，这里会显示它的持久身份。</span>
        </div>
      )}
    </aside>
  );
}
