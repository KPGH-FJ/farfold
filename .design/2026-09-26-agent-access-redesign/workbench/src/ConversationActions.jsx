import React, { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowUpRight,
  FolderOpen,
  Folders,
  Trash,
  Copy,
  DotsThree,
  FileArrowDown,
  PencilSimple,
} from "@phosphor-icons/react";
import { Button } from "./ui";
import { conversationState } from "./conversation-policy.js";
import { snapshotConversationExport } from "./conversation-export.js";
import ConversationExportDialog from "./ConversationExportDialog.jsx";
import ConversationManagementDialogs from "./ConversationManagementDialogs.jsx";

export default function ConversationActions({
  task,
  transcript,
  onTaskChange,
  onRename,
  onCopy,
  toast,
  active,
  renameOpen = false,
  groups = [],
  onMoveToGroup,
  onDeleteConversation,
  onNew,
  copy,
}) {
  const [menu, setMenu] = useState(false);
  const [exportState, setExportState] = useState(null);
  const [management, setManagement] = useState(null);
  const trigger = useRef(null);
  const dialogWasOpen = useRef({ open: false, taskId: task.id });
  const dialogOpen = Boolean(exportState) || Boolean(management) || renameOpen;
  const activity = conversationState(task);
  useEffect(() => {
    const previous = dialogWasOpen.current;
    dialogWasOpen.current = { open: dialogOpen, taskId: task.id };
    if (!active || previous.taskId !== task.id || !previous.open || dialogOpen)
      return;
    // The menu item has unmounted. Restore focus after the dialog's cleanup.
    const frame = requestAnimationFrame(() => {
      const button = trigger.current;
      if (button?.isConnected && button.getClientRects().length) button.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [dialogOpen, active, task.id]);
  useEffect(() => {
    if (!active) {
      setMenu(false);
      setExportState(null);
      setManagement(null);
    }
  }, [active]);
  useEffect(() => {
    setMenu(false);
    setExportState(null);
    setManagement(null);
  }, [task.id]);
  return (
    <div
      className="conv-popover-wrap"
      onKeyDown={(event) => {
        if (event.key === "Escape" && menu) {
          event.stopPropagation();
          setMenu(false);
          trigger.current?.focus();
        }
      }}
    >
      <Button
        ref={trigger}
        kind="icon"
        aria-label="对话操作"
        aria-expanded={menu}
        onClick={() => setMenu((value) => !value)}
      >
        <DotsThree size={23} />
      </Button>
      {menu && (
        <>
          <button
            className="conv-dismiss"
            aria-label="关闭菜单"
            onClick={() => setMenu(false)}
          />
          <div className="conv-menu">
            <button
              onClick={() => {
                onNew?.();
                setMenu(false);
              }}
              disabled={!onNew}
            >
              <ArrowUpRight size={16} />
              相同设置再开一段
            </button>
            <button
              onClick={() => {
                setManagement("move");
                setMenu(false);
              }}
            >
              <Folders size={16} />
              移到分组
            </button>
            <button
              onClick={() => {
                setManagement("finder");
                setMenu(false);
              }}
            >
              <FolderOpen size={16} />
              在访达中显示工作位置
            </button>
            <button
              onClick={() => {
                onRename();
                setMenu(false);
              }}
            >
              <PencilSimple size={16} />
              重命名
            </button>
            <button
              onClick={() => {
                onCopy();
                setMenu(false);
              }}
            >
              <Copy size={16} />
              复制对话内容
            </button>
            <button
              onClick={() => {
                setExportState({
                  snapshot: snapshotConversationExport(
                    transcript.current,
                    task,
                  ),
                  mode: task.exportPreviewResult || "success",
                });
                setMenu(false);
              }}
            >
              <FileArrowDown size={16} />
              导出 Markdown
            </button>
            <button
              disabled={!task.archived && !activity.canArchive}
              title={
                !task.archived
                  ? activity.archiveReason || "归档后仍可找回"
                  : "移回最近对话"
              }
              onClick={() => {
                onTaskChange({ archived: !task.archived });
                toast?.(
                  task.archived ? "已移回最近对话" : "已归档，仍可在归档中找到",
                );
                setMenu(false);
              }}
            >
              <Archive size={16} />
              {task.archived ? "移回最近对话" : "归档对话"}
            </button>
            <button
              disabled={!onDeleteConversation}
              onClick={() => {
                setManagement("delete");
                setMenu(false);
              }}
            >
              <Trash size={16} />
              删除对话
            </button>
            {!task.archived && activity.archiveReason && (
              <small className="cr-menu-reason">{activity.archiveReason}</small>
            )}
          </div>
        </>
      )}
      {management && (
        <ConversationManagementDialogs
          key={`${task.id}-${management}`}
          kind={management}
          task={task}
          groups={groups}
          onClose={() => setManagement(null)}
          onTaskChange={onTaskChange}
          onMoveToGroup={onMoveToGroup}
          onDeleteConversation={onDeleteConversation}
          copy={copy}
          toast={toast}
        />
      )}
      {exportState && (
        <ConversationExportDialog
          snapshot={exportState.snapshot}
          mode={exportState.mode}
          onClose={() => setExportState(null)}
        />
      )}
    </div>
  );
}
