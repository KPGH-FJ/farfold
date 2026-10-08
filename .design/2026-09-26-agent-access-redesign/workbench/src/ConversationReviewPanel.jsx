import React, { useState } from "react";
import { Button, Modal } from "./ui";
import ExecutionReviewControls from "./ExecutionReviewControls.jsx";
import { webpageEvent } from "./conversation-content-state.js";

export default function ConversationReviewPanel({
  task,
  onTaskChange,
  beforeScenario,
  onStopConfirmed,
  permissionCapability,
}) {
  const [open, setOpen] = useState(false);
  const scenario = (patch) => {
    beforeScenario();
    onTaskChange({
      reviewScenario: true,
      configurationChange: null,
      questionSubmission: null,
      questionPreviewResult: "success",
      permissionReconfirmRequired: false,
      permissionChange: null,
      stopPhase: null,
      ...patch,
    });
  };
  return (
    <>
      <Button
        kind="text"
        className="cr-demo-entry"
        onClick={() => setOpen(true)}
      >
        原型场景
      </Button>
      {open && (
        <Modal
          title="原型场景 · 仅本地演示"
          onClose={() => setOpen(false)}
          footer={
            <Button primary onClick={() => setOpen(false)}>
              返回对话体验
            </Button>
          }
        >
          <p>
            以下入口只改变这条示例对话，便于评审状态与下一步；不会连接
            Agent、读文件或访问网页。
          </p>
          <div className="cr-demo-grid">
            <Button
              onClick={() =>
                scenario({
                  status: "done",
                  terminalConfirmed: true,
                  configurationNotice: "",
                  queuePaused: true,
                })
              }
            >
              完成 · 可继续
            </Button>
            <Button
              onClick={() =>
                scenario({
                  status: "approval",
                  approvalAnswers: {},
                  queuePaused: true,
                })
              }
            >
              审批待处理
            </Button>
            <Button
              onClick={() =>
                scenario({
                  status: "question",
                  answerSubmitted: false,
                  interactionExpired: false,
                  questionPreviewResult: "unknown",
                  queuePaused: true,
                })
              }
            >
              问题提交将未知
            </Button>
            <Button
              onClick={() =>
                scenario({
                  status: "running",
                  stopPhase: "unknown",
                  queuePaused: true,
                })
              }
            >
              停止未确认
            </Button>
            <Button
              onClick={() =>
                scenario({
                  status: "done",
                  recoveryRead: {
                    phase: "complete",
                    receipt: true,
                    bodyComplete: true,
                    identityStatus: "matched",
                  },
                  permissionReconfirmRequired: true,
                  queuePaused: true,
                })
              }
            >
              恢复 · 重新确认权限
            </Button>
            <Button
              onClick={() =>
                onTaskChange({
                  webPreview: webpageEvent(task.webPreview, "disconnect"),
                })
              }
            >
              网页连接结束
            </Button>
          </div>
          <label className="cr-demo-select">
            模型设置返回结果
            <select
              aria-label="模型设置演示结果"
              value={task.configurationPreviewResult || "success"}
              onChange={(event) =>
                onTaskChange({ configurationPreviewResult: event.target.value })
              }
            >
              <option value="success">确认并保存成功</option>
              <option value="failed">明确失败 · 保留旧值</option>
              <option value="unknown">未确认 · 暂停发送</option>
            </select>
          </label>
          <label className="cr-demo-select">
            Markdown 导出演示
            <select
              aria-label="Markdown 导出演示结果"
              value={task.exportPreviewResult || "success"}
              onChange={(event) =>
                onTaskChange({ exportPreviewResult: event.target.value })
              }
            >
              <option value="success">准备成功，可下载示例文件</option>
              <option value="failed">首次失败，重试成功</option>
              <option value="waiting">持续准备，可随时取消</option>
            </select>
          </label>
          <ExecutionReviewControls
            task={task}
            onTaskChange={onTaskChange}
            beforeScenario={beforeScenario}
            onStopConfirmed={onStopConfirmed}
            permissionCapability={permissionCapability}
          />
        </Modal>
      )}
    </>
  );
}
