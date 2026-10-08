/**
 * One danger-confirmation pattern for every irreversible action (删除对话、
 * 清空归档、移除 Agent、清除数据、卸载、退出登录、丢弃未发内容):
 * scope statement → what stays → irreversibility note → error surface →
 * busy-locked cancel/confirm with a consistent danger button.
 * Inline surfaces use `DangerConfirm`; modal surfaces use
 * `DangerConfirmDialog`, which also locks Escape/backdrop while busy.
 */
import type { ReactNode, RefObject } from "react";
import { LIBRARY } from "../runtime/library_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";

export function DangerConfirm({
  children,
  error,
  busy = false,
  confirmLabel,
  confirmDisabled = false,
  onConfirm,
  cancelLabel,
  onCancel,
}: {
  /** Scope, kept-items and irreversibility content. */
  children: ReactNode;
  error?: string | null;
  /** Working state: locks cancel and confirm. */
  busy?: boolean;
  confirmLabel: ReactNode;
  /** Preconditions that block confirming even while idle. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  cancelLabel?: ReactNode;
  onCancel: () => void;
}) {
  return (
    <div className="danger-confirm" role="alert">
      {children}
      {error && <p role="alert">{error}</p>}
      <div className="danger-confirm-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={onCancel}
        >
          {cancelLabel ?? LIBRARY.cancel}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy || confirmDisabled}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

export function DangerConfirmDialog({
  title,
  children,
  error,
  busy = false,
  confirmLabel,
  confirmDisabled = false,
  onConfirm,
  cancelLabel,
  onCancel,
  returnFocusRef,
}: {
  title: string;
  children: ReactNode;
  error?: string | null;
  /** Working state: locks the footer and Escape/backdrop dismissal. */
  busy?: boolean;
  confirmLabel: ReactNode;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  cancelLabel?: ReactNode;
  onCancel: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <WorkspaceDialog
      title={title}
      busy={busy}
      onClose={onCancel}
      returnFocusRef={returnFocusRef}
    >
      <div className="workspace-dialog-body">
        {children}
        {error && <p role="alert">{error}</p>}
      </div>
      <footer>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={onCancel}
        >
          {cancelLabel ?? LIBRARY.cancel}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy || confirmDisabled}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </footer>
    </WorkspaceDialog>
  );
}
