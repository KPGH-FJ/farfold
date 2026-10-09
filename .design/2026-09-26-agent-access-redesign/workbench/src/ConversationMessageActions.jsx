import React, { useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowUpRight,
  Copy,
  DotsThree,
  PencilSimple,
} from "@phosphor-icons/react";
import { Button, Modal } from "./ui";
import {
  messageBranchSnapshot,
  prepareMessageResend,
} from "./conversation-menu-state.js";

export default function ConversationMessageActions({
  task,
  message,
  resolveMessage,
  copy,
  onTaskChange,
  onNewFromMessage,
}) {
  const [menu, setMenu] = useState(false);
  const [resend, setResend] = useState(null);
  const trigger = useRef(null);
  const userMessage = !message.role || message.role === "user";
  const hasContent = Boolean(
    resolveMessage || message.text?.trim() || message.attachments?.length,
  );
  const hasDraft = Boolean(
    task.draft?.trim() || task.attachments?.length || task.resendDraft,
  );
  const closeMenu = () => {
    setMenu(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    setMenu(false);
    setResend(null);
  }, [task.id]);
  return (
    <div
      className="conv-popover-wrap"
      onKeyDown={(event) => {
        if (event.key === "Escape" && menu) {
          event.stopPropagation();
          closeMenu();
        }
      }}
    >
      <Button
        ref={trigger}
        kind="icon"
        aria-label="消息操作"
        aria-expanded={menu}
        onClick={() => setMenu((value) => !value)}
      >
        <DotsThree size={16} />
      </Button>
      {menu && (
        <>
          <button
            className="conv-dismiss"
            aria-label="关闭消息菜单"
            onClick={closeMenu}
          />
          <span
            className="conv-menu"
            style={{
              textAlign: "left",
              fontWeight: 400,
              ...(userMessage ? {} : { left: 0, right: "auto" }),
            }}
          >
            <button
              disabled={!resolveMessage && !message.text}
              onClick={() => {
                copy((resolveMessage?.() || message).text);
                closeMenu();
              }}
            >
              <Copy size={16} />
              复制消息
            </button>
            {userMessage && (
              <>
                <button
                  disabled={!hasContent}
                  onClick={() => {
                    setResend("edit");
                    setMenu(false);
                  }}
                >
                  <PencilSimple size={16} />
                  编辑后追加为新消息
                </button>
                <button
                  disabled={!hasContent}
                  onClick={() => {
                    setResend("repeat");
                    setMenu(false);
                  }}
                >
                  <ArrowClockwise size={16} />
                  再发一次
                </button>
              </>
            )}
            <button
              disabled={!hasContent || !onNewFromMessage}
              onClick={() => {
                const snapshot = messageBranchSnapshot(
                  task,
                  resolveMessage?.() || message,
                );
                closeMenu();
                if (snapshot) onNewFromMessage(snapshot);
              }}
            >
              <ArrowUpRight size={16} />
              从这里开新对话
            </button>
          </span>
        </>
      )}
      {resend && (
        <Modal
          title={resend === "edit" ? "编辑后追加为新消息" : "再发一次"}
          onClose={() => {
            setResend(null);
            requestAnimationFrame(() => trigger.current?.focus());
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  setResend(null);
                  requestAnimationFrame(() => trigger.current?.focus());
                }}
              >
                取消
              </Button>
              <Button
                primary
                onClick={() => {
                  const patch = prepareMessageResend(task, message);
                  if (!patch) return;
                  onTaskChange(patch);
                  setResend(null);
                  requestAnimationFrame(() =>
                    trigger.current
                      ?.closest(".conv-page")
                      ?.querySelector('textarea[aria-label="消息内容"]')
                      ?.focus(),
                  );
                }}
              >
                {hasDraft ? "暂存草稿并放入输入框" : "放入输入框"}
              </Button>
            </>
          }
        >
          <p>
            继续使用本对话：{task.agent} · {task.source || "来源未提供"} ·{" "}
            {task.model || "模型未提供"} · {task.effort || "推理选项未提供"}
          </p>
          <p>
            原消息和已有回答会保留。先把这条消息放到输入框，检查文字、附件和当前设置后，由你发送；不会立即发送或加入待发。
          </p>
          {hasDraft && (
            <p>
              {task.resendDraft
                ? "正在编辑另一条重发消息。这次确认会替换该编辑内容；此前暂存的原草稿与附件仍保留。"
                : "当前草稿与附件会暂存。取消重发或发送这条新消息后，原草稿会恢复。"}
            </p>
          )}
          {(task.readOnly ||
            task.archived ||
            task.status === "unknown" ||
            task.stopPhase) && (
            <p className="sl-protected">
              当前对话仍有发送限制。准备草稿不会解除限制。
            </p>
          )}
          <blockquote
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: 180,
              overflow: "auto",
            }}
          >
            {message.text || "这是一条仅含附件的消息。"}
          </blockquote>
          {!!message.attachments?.length && (
            <p>
              同时带入 {message.attachments.length} 个附件：
              {message.attachments
                .map((attachment) =>
                  typeof attachment === "string"
                    ? attachment.split("/").pop()
                    : attachment.name || "文件",
                )
                .join("、")}
              。发送前请核对仍可读取。
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
