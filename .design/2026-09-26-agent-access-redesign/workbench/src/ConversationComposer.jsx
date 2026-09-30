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
}) {
  const [menu, setMenu] = useState(null);
  const input = useRef(null);
  const queued = isRunning || pending || paused;
  const stopWaiting = task.stopPhase === "waiting" || (!task.stopPhase && stopping);
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
        <div className="conv-stop-notice" role="status" aria-label="停止确认状态">
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
                ? "尚未收到停止确认，请重试停止。发送已暂停，草稿与待发消息已保留。"
                : "正在等待 Agent 确认。发送已暂停，草稿与待发消息已保留。"}
          </p>
        </div>
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
            <div className="conv-popover-wrap conv-identity-wrap">
              <button
                className="conv-composer-identity"
                type="button"
                aria-label="查看 Agent 与模型设置"
                aria-expanded={menu === "identity"}
                onClick={() => toggle("identity")}
              >
                <AgentIcon name={task.agent} size={17} />
                <span>{task.agent}</span>
                <span className="conv-control-divider" />
                <span className="conv-model-name">{task.model}</span>
                <CaretDown size={12} />
              </button>
              {menu === "identity" && (
                <>
                  <button
                    className="conv-dismiss"
                    aria-label="关闭会话设置"
                    onClick={() => setMenu(null)}
                  />
                  <div className="conv-identity-panel conv-input-identity">
                    <strong>当前对话设置</strong>
                    <dl>
                      <dt>Agent</dt>
                      <dd>{task.agent}</dd>
                      <dt>模型来源</dt>
                      <dd>{task.source || "沿用 Agent 已有设置"}</dd>
                      <dt>模型</dt>
                      <dd>{task.model}</dd>
                      <dt>推理等级</dt>
                      <dd>{task.effort || "默认"}</dd>
                    </dl>
                    <p>
                      <LockKey size={14} />
                      这条对话保持创建时的设置。
                    </p>
                    <Button
                      onClick={() => {
                        setMenu(null);
                        onNew();
                      }}
                    >
                      选择其他设置新开对话
                      <ArrowUpRight size={14} />
                    </Button>
                  </div>
                </>
              )}
            </div>
            {task.effort && (
              <span
                className="composer-effort readonly"
                aria-label={`思考深度：${task.effort}，当前对话已固定`}
                title="这条对话保持创建时的思考深度"
              >
                <span>思考</span>
                {task.effort}
                <LockKey size={12} aria-hidden="true" />
              </span>
            )}
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
            {(isRunning || pending || task.stopPhase) && (
              <Button className={`conv-stop${retryStop ? " conv-stop-retry" : ""}`} disabled={stopWaiting} onClick={stop}>
                <Square size={11} weight="fill" />
                {stopWaiting ? "停止中" : retryStop ? "重试停止" : "停止"}
              </Button>
            )}
            <Button
              primary
              className="conv-send-button"
              aria-label={queued ? "加入待发" : "发送消息"}
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
              : isRunning
                ? "补充内容会排在当前工作之后"
                : "Enter 发送 · Shift Enter 换行"}
        </span>
      </div>
    </>
  );
}
