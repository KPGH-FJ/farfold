import React, { useEffect, useRef, useState } from "react";
import {
  Archive,
  Copy,
  DotsThree,
  FileArrowDown,
  PencilSimple,
} from "@phosphor-icons/react";
import { Button } from "./ui";
import { conversationState } from "./conversation-policy.js";
import { snapshotConversationExport } from "./conversation-export.js";
import ConversationExportDialog from "./ConversationExportDialog.jsx";

export default function ConversationActions({
  task,
  transcript,
  onTaskChange,
  onRename,
  onCopy,
  toast,
  active,
  renameOpen = false,
}) {
  const [menu, setMenu] = useState(false);
  const [exportState, setExportState] = useState(null);
  const trigger = useRef(null);
  const dialogWasOpen = useRef({ open: false, taskId: task.id });
  const dialogOpen = Boolean(exportState) || renameOpen;
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
    }
  }, [active]);
  useEffect(() => {
    setMenu(false);
    setExportState(null);
  }, [task.id]);
  return (
    <div className="conv-popover-wrap">
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
            {!task.archived && activity.archiveReason && (
              <small className="cr-menu-reason">{activity.archiveReason}</small>
            )}
          </div>
        </>
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
