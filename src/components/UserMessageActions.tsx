import { useRef, useState } from "react";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { WorkspaceActionMenu } from "./WorkspaceActionMenu";
import { THREAD_VIEW_STRINGS as T } from "../runtime/thread_view_strings";

/**
 * W3-6 用户消息操作菜单：复制、编辑后重发、再发一次、从这里开新对话。
 * 复制在组件内完成；其余语义由宿主接线，草稿归属与发送保护留在原处。
 */
export function UserMessageActions({
  text,
  disabled = false,
  onEditResend,
  onSendAgain,
  onNewFromMessage,
}: {
  text: string;
  disabled?: boolean;
  /** Put this message back into the composer draft for editing. */
  onEditResend?: () => void;
  /** Send the same content again through the normal send path. */
  onSendAgain?: () => void;
  /** Seed the new-conversation draft with this message and open it. */
  onNewFromMessage?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!onEditResend && !onSendAgain && !onNewFromMessage) return null;
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
        onClick={() => setOpen((value) => !value)}
      >
        <DotsThreeIcon size={15} aria-hidden="true" />
      </button>
      {open && (
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
                void navigator.clipboard.writeText(text).catch(() => undefined);
                close();
              }}
            >
              {T.copyMessage}
            </button>
            {onEditResend && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  close();
                  onEditResend();
                }}
              >
                {T.editResend}
              </button>
            )}
            {onSendAgain && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  close();
                  onSendAgain();
                }}
              >
                {T.sendAgain}
              </button>
            )}
            {onNewFromMessage && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  close();
                  onNewFromMessage();
                }}
              >
                {T.newFromHere}
              </button>
            )}
          </div>
        </WorkspaceActionMenu>
      )}
    </span>
  );
}
