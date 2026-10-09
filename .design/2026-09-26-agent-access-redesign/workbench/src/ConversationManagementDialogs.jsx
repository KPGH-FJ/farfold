import React, { useEffect, useState } from "react";
import { Button, Modal } from "./ui";
import LibraryDialogs from "./LibraryDialogs.jsx";
import {
  conversationDeleteProtection,
  attemptConversationDeletion,
  startFinderPreview,
  finishFinderPreview,
} from "./conversation-menu-state.js";

export default function ConversationManagementDialogs({
  kind,
  task,
  groups,
  onClose,
  onTaskChange,
  onMoveToGroup,
  onDeleteConversation,
  copy,
  toast,
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState("");
  const [finder, setFinder] = useState(null);
  const [outcome, setOutcome] = useState("success");
  const protection = conversationDeleteProtection(task);
  useEffect(() => {
    if (finder?.phase !== "pending") return;
    const timer = setTimeout(
      () =>
        setFinder((current) =>
          finishFinderPreview(current, finder.id, task.folder, outcome),
        ),
      650,
    );
    return () => clearTimeout(timer);
  }, [finder?.id, finder?.phase, task.folder, outcome]);
  if (kind === "move")
    return (
      <LibraryDialogs
        modal="move"
        setModal={onClose}
        search=""
        tasks={[task]}
        groups={groups}
        moveIds={[task.id]}
        toast={toast}
        patch={(id, patch) =>
          onMoveToGroup ? onMoveToGroup(id, patch.group) : onTaskChange(patch)
        }
      />
    );
  if (kind === "delete")
    return (
      <Modal
        title="删除这段对话？"
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>取消</Button>
            <Button
              className="set-danger"
              disabled={!confirmed || !!protection || !onDeleteConversation}
              onClick={() => {
                const result = attemptConversationDeletion(
                  task,
                  confirmed,
                  onDeleteConversation,
                );
                if (result.phase === "deleted") onClose();
                else setDeleteFailure(result.message);
              }}
            >
              {deleteFailure ? "重试删除演示对话" : "删除这段演示对话"}
            </Button>
          </>
        }
      >
        <p className="sl-dialog-lead">请核对本次范围。删除后不能从列表恢复。</p>
        <ul className="sl-scope-list">
          <li>
            <strong>{task.title}</strong>
            <span>
              {task.agent} · {task.group || "未分组"} ·{" "}
              {task.folder || "未指定位置"}
            </span>
          </li>
        </ul>
        <div className="sl-scope-grid">
          <section>
            <h3>移除</h3>
            <p>这段对话在演示中的目录、收藏、分组与界面记录。</p>
          </section>
          <section>
            <h3>保留</h3>
            <p>
              项目文件、Agent 账号与程序。这个示例不提供 Agent
              侧历史删除，原历史仍保留。
            </p>
          </section>
        </div>
        {deleteFailure && (
          <p role="alert" className="sl-protected">
            {deleteFailure}
          </p>
        )}
        {protection ? (
          <p role="alert" className="sl-protected">
            {protection} 本次不会删除任何内容。
          </p>
        ) : (
          <label className="sl-confirm-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已核对范围，理解 Agent 侧历史仍保留
          </label>
        )}
      </Modal>
    );
  if (kind !== "finder") return null;
  return (
    <Modal
      title="在访达中显示工作位置"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button disabled={!task.folder} onClick={() => copy(task.folder)}>
            复制路径
          </Button>
          <Button
            primary
            disabled={!task.folder || finder?.phase === "pending"}
            onClick={() =>
              setFinder(startFinderPreview(task, `finder-${Date.now()}`))
            }
          >
            {finder?.phase === "pending"
              ? "正在请求…"
              : finder?.phase === "failed"
                ? "重试显示（演示）"
                : "显示工作位置（演示）"}
          </Button>
        </>
      }
    >
      <p>
        工作位置：
        <strong style={{ overflowWrap: "anywhere" }}>
          {task.folder || "未指定工作位置"}
        </strong>
      </p>
      <p className="v2-help">
        这里只演示请求与结果，不会打开系统访达或读取这个文件夹。
      </p>
      {!task.folder && (
        <p className="sl-protected" role="alert">
          这段对话未记录工作位置，无法定位。原对话保留。
        </p>
      )}
      {finder && (
        <div className="cr-action-state" role="status">
          <div>
            <strong>
              {finder.phase === "pending"
                ? "正在等待打开结果（演示）"
                : finder.phase === "success"
                  ? "工作位置已显示（演示结果）"
                  : "未能显示工作位置"}
            </strong>
            <p>
              {finder.phase === "success"
                ? "真实产品将在访达定位上述文件夹；本原型没有调用系统。"
                : finder.error || "等待期间仍可关闭此窗口。"}
            </p>
          </div>
        </div>
      )}
      <details className="v2-help">
        <summary>原型结果场景</summary>
        <label className="field">
          <span>下一次显示结果</span>
          <select
            aria-label="访达显示结果场景"
            value={outcome}
            disabled={finder?.phase === "pending"}
            onChange={(event) => setOutcome(event.target.value)}
          >
            <option value="success">显示成功</option>
            <option value="failed">路径不可用</option>
          </select>
        </label>
      </details>
    </Modal>
  );
}
