import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
import { useRef, useState } from "react";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { WorkspaceActionMenu } from "./WorkspaceActionMenu";
import { THREAD_VIEW_STRINGS as T } from "../runtime/thread_view_strings";
import { SESSION_FORK_STRINGS as F } from "../runtime/session_fork_strings";

/**
 * W3-6 用户消息操作菜单：复制、编辑后追加、准备再发、从这里开新对话。
 * 复制在组件内完成；其余语义由宿主接线，草稿归属与发送保护留在原处。
 */
export function UserMessageActions({
  text,
  disabled = false,
  onEditResend,
  onSendAgain,
  onNewFromMessage,
  onForkFromMessage,
}: {
  text: string;
  disabled?: boolean;
  /** Prepare a separate editable message without replacing the main draft. */
  onEditResend?: () => void;
  /** Prepare the same content for explicit confirmation; never send from the menu. */
  onSendAgain?: () => void;
  /** Seed the new-conversation draft with this message and open it. */
  onNewFromMessage?: () => void;
  /** Review a verified official historical point; never dispatch from this menu. */
  onForkFromMessage?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const enabled = useRef(!disabled);
  enabled.current = !disabled;
  const anchor = useRef<HTMLButtonElement>(null);
  if (!onEditResend && !onSendAgain && !onNewFromMessage && !onForkFromMessage)
    return null;
  const close = () => setOpen(false);
  return (
    <span className="message-actions" data-copy-exclude>
      <button
        ref={anchor}
        type="button"
        className="message-actions-trigger"
        aria-label={T.messageActions}
        title={T.messageActions}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen((value) => !value);
        }}
      >
        <DotsThreeIcon size={15} aria-hidden="true" />
      </button>
      {open && !disabled && (
        <WorkspaceActionMenu
          anchor={anchor.current}
          title={T.messageActions}
          onClose={close}
        >
          <div className="workspace-action-body">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                if (!enabled.current) return;
                setCopyError(false);
                void navigator.clipboard
                  .writeText(text)
                  .then(close)
                  .catch(() => {
                    if (enabled.current) setCopyError(true);
                  });
              }}
            >
              {T.copyMessage}
            </button>
            {onEditResend && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  if (!enabled.current) return;
                  close();
                  onEditResend();
                }}
              >
                {R.editMessage}
              </button>
            )}
            {onSendAgain && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  if (!enabled.current) return;
                  close();
                  onSendAgain();
                }}
              >
                {R.prepareAgain}
              </button>
            )}
            {onNewFromMessage && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  if (!enabled.current) return;
                  close();
                  onNewFromMessage();
                }}
              >
                {T.newFromHere}
              </button>
            )}
            {onForkFromMessage && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  if (!enabled.current) return;
                  close();
                  onForkFromMessage();
                }}
              >
                {F.pointTitle}
              </button>
            )}
            {copyError && <p role="alert">{T.copyFailed}</p>}
          </div>
        </WorkspaceActionMenu>
      )}
    </span>
  );
}
