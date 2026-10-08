import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  CaretDown,
  Command,
  FileText,
  LockKey,
  Paperclip,
  Plus,
  Square,
  X,
} from "@phosphor-icons/react";
import { AgentIcon, Button } from "./ui";
import ComposerFolder from "./ComposerFolder.jsx";
import PermissionControl from "./PermissionControl.jsx";
import ConversationConfiguration from "./ConversationConfiguration.jsx";

const SHORTCUTS = [
  { label: "先给出计划", text: "先给出一个可讨论的计划，确认后再继续。" },
  { label: "整理为要点", text: "请把上面的内容整理成简洁要点。" },
  { label: "换一种表达", text: "保留原意，换一种更自然、简洁的表达。" },
];

export default function ConversationComposer({
  task,
  text,
  attachments,
  blocked,
  stopping,
  workEnabled,
  isRunning,
  pending,
  paused,
  active,
  onTaskChange,
  onNew,
  send,
  stop,
  addFile,
  openAttachments,
  files,
  permissionCapability,
  permissionGate,
  onPermissionChange,
  configurationCapability,
  onCheckStop,
}) {
  const [menu, setMenu] = useState(null);
  const input = useRef(null);
  const queued = isRunning || pending || paused;
  const stopWaiting =
    task.stopPhase === "waiting" || (!task.stopPhase && stopping);
  const retryStop = ["unknown", "failed"].includes(task.stopPhase);
  useEffect(() => {
    if (!active) setMenu(null);
  }, [active]);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = "0px";
    input.current.style.height = `${Math.min(144, Math.max(48, input.current.scrollHeight))}px`;
  }, [text]);
  const insert = (value) => {
    onTaskChange({
      draft: `${text.replace(/\/$/, "").trim()}${text.trim() ? "\n" : ""}${value}`,
    });
    setMenu(null);
    input.current?.focus();
  };
  const toggle = (next) => setMenu(menu === next ? null : next);
  return (
    <>
      {task.stopPhase && (
        <div
          className="conv-stop-notice"
          role="status"
          aria-label="停止确认状态"
        >
          <strong>
            {task.stopPhase === "failed"
              ? "停止请求未发送"
              : task.stopPhase === "unknown"
                ? "停止结果未知"
                : "等待停止确认"}
          </strong>
          <p>
            {task.stopPhase === "failed"
              ? "原工作仍待处理。可继续处理，或重试停止；草稿与待发消息已保留。"
              : task.stopPhase === "unknown"
                ? "尚未收到停止确认。请先检查结果；发送暂停，草稿与待发消息保留。"
                : "正在等待 Agent 确认。发送已暂停，草稿与待发消息已保留。"}
          </p>
          {task.stopPhase === "unknown" && (
            <Button onClick={onCheckStop}>检查停止结果（演示）</Button>
          )}
        </div>
      )}
      {task.resendDraft && (
        <div className="cr-resend-notice" role="status">
          <div>
            <strong>编辑后作为新消息追加</strong>
            <p>原消息与已有回答会保留。这次发送不会覆盖过去的内容。</p>
          </div>
          <Button
            kind="text"
            onClick={() =>
              onTaskChange({
                draft: task.resendDraft.previousDraft || "",
                attachments: task.resendDraft.previousAttachments || [],
                resendDraft: null,
              })
            }
          >
            取消重发
          </Button>
        </div>
      )}
      {task.webPreview?.url && (
        <button
          className="cr-page-chip"
          onClick={() =>
            onTaskChange({ webPreview: { ...task.webPreview, open: true } })
          }
        >
          当前网页 ·{" "}
          {task.webPreview.granted ? "允许读取本页" : "尚未分享给 Agent"}
        </button>
      )}
      <div
        className={`conv-composer ${blocked ? "readonly" : ""}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setMenu(null);
            input.current?.focus();
          }
        }}
      >
        {(attachments.length > 0 || task.folder) && (
          <div className="conv-chips">
            <ComposerFolder folder={task.folder} />
            {attachments.map((file) => (
              <span key={file}>
                <FileText size={14} />
                {file.split("/").pop()}
                <button
                  type="button"
                  aria-label={`移除附件 ${file}`}
                  onClick={() =>
                    onTaskChange({
                      attachments: attachments.filter((item) => item !== file),
                    })
                  }
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          aria-label="消息内容"
          rows={1}
          placeholder={
            blocked
              ? "写下想法，恢复后再发送…"
              : queued
                ? "补充下一步，加入待发…"
                : "继续对话…"
          }
          value={text}
          onChange={(event) => onTaskChange({ draft: event.target.value })}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              send();
            }
          }}
        />
        {/@[^\s]*$/.test(text) && (
          <div className="conv-mention">
            <span>添加文件到这条消息</span>
            {files
              .filter((file) =>
                file.path
                  .toLowerCase()
                  .includes(text.split("@").pop().toLowerCase()),
              )
              .map((file) => (
                <button
                  type="button"
                  key={file.path}
                  onClick={() => addFile(file.path)}
                >
                  <FileText size={15} />
                  {file.path}
                </button>
              ))}
          </div>
        )}
        <div className="conv-composer-toolbar">
          <div className="conv-composer-controls">
            <div className="conv-popover-wrap">
              <Button
                kind="icon"
                aria-label="添加附件与内容"
                aria-expanded={menu === "add"}
                onClick={() => toggle("add")}
              >
                <Plus size={19} />
              </Button>
              {menu === "add" && (
                <>
                  <button
                    className="conv-dismiss"
                    aria-label="关闭添加菜单"
                    onClick={() => setMenu(null)}
                  />
                  <div className="conv-menu conv-input-menu">
                    <span className="conv-menu-label">添加到消息</span>
                    <button
                      onClick={() => {
                        setMenu(null);
                        openAttachments();
                      }}
                    >
                      <Paperclip size={16} />
                      <span>
                        选择文件<small>从示例文件中选择</small>
                      </span>
                    </button>
                    <button
                      onClick={() => {
                        onTaskChange({ draft: `${text}${text ? " " : ""}@` });
                        setMenu(null);
                        input.current?.focus();
                      }}
                    >
                      <FileText size={16} />
                      <span>
                        查找项目文件<small>输入 @ 搜索文件名</small>
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>
            <ConversationConfiguration
              task={task}
              capability={configurationCapability}
              onTaskChange={onTaskChange}
              onNew={onNew}
              active={active}
            />
            <PermissionControl
              key={task.id}
              active={active}
              capability={permissionCapability}
              value={
                task.permissionChange?.phase === "unknown" ||
                task.permissionChange?.reading
                  ? undefined
                  : task.permissionValue
              }
              disabled={permissionGate?.disabled}
              disabledReason={permissionGate?.reason}
              onChange={onPermissionChange}
            />
            <div className="conv-popover-wrap">
              <Button
                kind="icon"
                aria-label="快捷指令"
                aria-expanded={menu === "commands"}
                onClick={() => toggle("commands")}
              >
                <Command size={17} />
              </Button>
              {menu === "commands" && (
                <>
                  <button
                    className="conv-dismiss"
                    aria-label="关闭快捷指令"
                    onClick={() => setMenu(null)}
                  />
                  <div className="conv-menu conv-input-menu">
                    <span className="conv-menu-label">
                      快捷指令 · 填入后可编辑
                    </span>
                    {SHORTCUTS.map((shortcut) => (
                      <button
                        key={shortcut.label}
                        onClick={() => insert(shortcut.text)}
                      >
                        <Command size={15} />
                        <span>{shortcut.label}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="conv-send-controls">
            {(isRunning || pending || task.stopPhase) &&
              task.stopPhase !== "unknown" && (
                <Button
                  className={`conv-stop${retryStop ? " conv-stop-retry" : ""}`}
                  disabled={stopWaiting}
                  onClick={stop}
                >
                  <Square size={11} weight="fill" />
                  {stopWaiting ? "停止中" : retryStop ? "重试停止" : "停止"}
                </Button>
              )}
            <Button
              primary
              className="conv-send-button"
              aria-label={
                queued
                  ? "加入待发"
                  : task.resendDraft
                    ? "追加为新消息"
                    : "发送消息"
              }
              title={
                blocked
                  ? "发送已暂停，草稿会保留"
                  : queued
                    ? "加入待发"
                    : "发送消息"
              }
              disabled={
                blocked ||
                stopping ||
                !workEnabled ||
                (!text.trim() && !attachments.length)
              }
              onClick={send}
            >
              {blocked ? <LockKey size={16} /> : <ArrowUp size={18} />}
              {queued && <span>待发</span>}
            </Button>
          </div>
        </div>
      </div>
      <div className="conv-composer-foot">
        <span>
          {blocked
            ? "发送已暂停 · 草稿已保留"
            : paused
              ? "待发已暂停，由你决定何时继续"
              : isRunning || pending
                ? "Enter 加入待发 · Shift Enter 换行"
                : task.resendDraft
                  ? "Enter 追加为新消息 · Shift Enter 换行"
                  : "Enter 发送 · Shift Enter 换行"}
        </span>
      </div>
    </>
  );
}
