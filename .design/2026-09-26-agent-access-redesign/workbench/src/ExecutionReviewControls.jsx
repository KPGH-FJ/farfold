import React from "react";
import { Button, Badge } from "./ui";
import {
  conversationState,
  requestPreviewEvent,
  recoveryPreviewEvent,
} from "./conversation-policy.js";
import "./execution-review.css";

export function MissingIdentity({ task, onTaskChange, onNew }) {
  if (!task.identityIncomplete) return null;
  const reported = task.reportedIdentity || {};
  const mismatch = ["model", "effort"].some(
    (key) => task[key] && reported[key] && task[key] !== reported[key],
  );
  const missing = ["model", "effort"].filter((key) => !task[key]);
  const canConfirm = !mismatch && missing.every((key) => reported[key]);
  return (
    <section className="conv-recovery" aria-label="确认旧记录缺失选择">
      <Badge tone="amber">旧记录缺少选择</Badge>
      <h2>请确认缺失的选择后继续</h2>
      <p>
        已经记录的值保持不变。以下只补充旧记录里缺少的项目，不代表核实了过去的实际使用情况。
      </p>
      <dl>
        <dt>已记录模型</dt>
        <dd>{task.model || "未记录"}</dd>
        <dt>已记录推理等级</dt>
        <dd>{task.effort || "未记录"}</dd>
        <dt>这次恢复返回</dt>
        <dd>
          {reported.model || "未提供模型"} ·{" "}
          {reported.effort || "未提供推理等级"}
        </dd>
      </dl>
      {mismatch && <p>返回值与已记录的选择不一致，这条对话保持只读。</p>}
      <div className="conv-card-actions">
        <Button
          primary
          disabled={!canConfirm}
          onClick={() =>
            onTaskChange({
              ...Object.fromEntries(missing.map((key) => [key, reported[key]])),
              confirmMissingIdentity: true,
              identityIncomplete: false,
              status: "done",
              queuePaused: true,
              currentModel: task.model || reported.model,
              currentEffort: task.effort || reported.effort,
            })
          }
        >
          确认缺失的选择
        </Button>
        <Button onClick={onNew}>新开对话</Button>
      </div>
    </section>
  );
}

export function HistoryReading({ task, onTaskChange, onNew }) {
  const read = task.recoveryRead;
  if (!read) return null;
  const labels = {
    loading: "正在读取原对话",
    complete: "原对话已完整恢复",
    failed: "历史读取中断",
    empty: "未取得可确认的历史正文",
    unsupported: "这个 Agent 无法读取这段历史",
  };
  return (
    <section className="conv-recovery" aria-label="历史恢复状态">
      <Badge tone={read.phase === "complete" ? "green" : "amber"}>
        {labels[read.phase]}
      </Badge>
      <h2>
        {read.phase === "complete"
          ? "可以按原来的设置继续"
          : "原内容与草稿保留，续发尚未开放"}
      </h2>
      <div className="reading-checks">
        <span className={read.receipt ? "ready" : ""}>
          {read.receipt ? "✓" : "○"} 读取请求已返回
        </span>
        <span className={read.bodyComplete ? "ready" : ""}>
          {read.bodyComplete ? "✓" : "○"} 正文已完整到达
        </span>
        <span className={read.identityStatus === "matched" ? "ready" : ""}>
          {read.identityStatus === "matched" ? "✓" : "○"} 原模型与推理选择已确认
        </span>
      </div>
      {read.identityStatus === "mismatch" && (
        <p>返回设置与原选择不同，发送保持暂停。请恢复原设置后重新检查。</p>
      )}
      <p>
        {read.phase === "complete"
          ? "模型和推理选择保持不变，待发消息仍需你点击继续。"
          : "不会把部分正文当成完整历史，也不会用现在的时间代替历史时间。"}
      </p>
      <details>
        <summary>演示恢复先后顺序</summary>
        <div className="execution-review-actions">
          <Button
            disabled={read.phase !== "loading" || read.receipt}
            onClick={() => onTaskChange(recoveryPreviewEvent(task, "receipt"))}
          >
            收到请求回执
          </Button>
          <Button
            disabled={read.phase !== "loading" || read.bodyComplete}
            onClick={() => onTaskChange(recoveryPreviewEvent(task, "partial"))}
          >
            到达一部分正文
          </Button>
          <Button
            disabled={read.phase !== "loading" || read.bodyComplete}
            onClick={() =>
              onTaskChange(recoveryPreviewEvent(task, "body-complete"))
            }
          >
            正文完整到达
          </Button>
          <Button
            disabled={read.phase !== "loading"}
            onClick={() =>
              onTaskChange(recoveryPreviewEvent(task, "identity-matched"))
            }
          >
            模拟返回原模型与推理选择
          </Button>
          <Button
            disabled={read.phase !== "loading"}
            onClick={() =>
              onTaskChange(recoveryPreviewEvent(task, "identity-mismatch"))
            }
          >
            模拟返回不同设置
          </Button>
          <Button
            disabled={read.phase !== "loading"}
            onClick={() => onTaskChange(recoveryPreviewEvent(task, "failed"))}
          >
            模拟读取失败
          </Button>
          <Button
            disabled={read.phase !== "loading"}
            onClick={() => onTaskChange(recoveryPreviewEvent(task, "empty"))}
          >
            模拟空正文
          </Button>
          <Button
            disabled={read.phase !== "loading"}
            onClick={() =>
              onTaskChange(recoveryPreviewEvent(task, "unsupported"))
            }
          >
            模拟不支持
          </Button>
        </div>
        <small>
          已收到 {read.received || 0}{" "}
          份示例内容；这是先后顺序预览，不读取真实历史。
        </small>
      </details>
      {read.phase !== "loading" && (
        <div className="conv-card-actions">
          <Button
            onClick={() =>
              onTaskChange({
                status: "recovery",
                recoveryRead: {
                  id: `read-${Date.now()}`,
                  phase: "loading",
                  receipt: false,
                  bodyComplete: false,
                  received: 0,
                },
                queuePaused: true,
              })
            }
          >
            重新读取
          </Button>
          <Button onClick={onNew}>新开对话</Button>
        </div>
      )}
    </section>
  );
}

export default function ExecutionReviewControls({
  task,
  onTaskChange,
  beforeScenario,
  permissionCapability,
  onStopConfirmed,
}) {
  if (task.accessTest || task.readOnly || task.status === "draft") return null;
  const state = conversationState(task);
  const scenario = (patch) => {
    beforeScenario?.();
    onTaskChange({
      ...patch,
      reviewScenario: true,
      terminalConfirmed: false,
      interactionExpired: false,
      eventNote: "",
      simulatePending: false,
      queuePaused: true,
    });
  };
  return (
    <details className="execution-review">
      <summary>
        流程边界演示 <Badge>本地原型</Badge>
      </summary>
      <p>
        当前统一状态：<strong>{state.label}</strong>
        。只改变这条示例对话，不调用真实 Agent。
      </p>
      {permissionCapability && (
        <label>
          权限变更演示结果
          <select
            aria-label="权限变更演示结果"
            value={task.permissionPreviewResult || "success"}
            disabled={task.permissionChange?.phase === "pending"}
            onChange={(event) =>
              onTaskChange({ permissionPreviewResult: event.target.value })
            }
          >
            <option value="success">收到确认</option>
            <option value="failed">明确失败</option>
            <option value="unknown">未收到结果</option>
          </select>
        </label>
      )}
      <div className="execution-review-actions">
        <Button
          onClick={() =>
            scenario({
              status: "running",
              stopPhase: null,
              recoveryRead: null,
              connectionState: "connected",
              previewRequestId: `request-${Date.now()}`,
            })
          }
        >
          模拟一次待确认请求
        </Button>
        <Button
          onClick={() =>
            scenario({
              status: "approval",
              stopPhase: null,
              recoveryRead: null,
              approvalAnswers: {},
              connectionState: "connected",
            })
          }
        >
          模拟等待审批
        </Button>
        <Button
          onClick={() =>
            scenario({
              status: "question",
              stopPhase: null,
              recoveryRead: null,
              connectionState: "connected",
            })
          }
        >
          模拟等待回答
        </Button>
        <Button
          onClick={() =>
            scenario({
              status: "recovery",
              stopPhase: null,
              recoveryRead: {
                id: `read-${Date.now()}`,
                phase: "loading",
                receipt: false,
                bodyComplete: false,
                received: 0,
              },
            })
          }
        >
          模拟冷打开历史
        </Button>
        <Button
          onClick={() =>
            scenario({
              status: "done",
              stopPhase: null,
              recoveryRead: null,
              connectionState: "released",
            })
          }
        >
          模拟空闲连接正常关闭
        </Button>
        <Button
          onClick={() =>
            scenario({
              status: "unknown",
              unknownReason: "connection",
              stopPhase: null,
              recoveryRead: null,
              connectionState: "lost",
            })
          }
        >
          模拟执行中连接丢失
        </Button>
      </div>
      {task.previewRequestId && (
        <div className="execution-review-events">
          <strong>当前请求的结果顺序</strong>
          <div className="execution-review-actions">
            {[
              ["completed", "收到明确完成"],
              ["accepted", "收到接纳回执"],
              ["unknown", "迟到未知回执"],
              ["transport-error", "迟到通信错误"],
            ].map(([type, label]) => (
              <Button
                key={type}
                onClick={() => onTaskChange(requestPreviewEvent(task, type))}
              >
                {label}
              </Button>
            ))}
            <Button
              onClick={() =>
                onTaskChange(
                  requestPreviewEvent(task, "unknown", "old-request"),
                )
              }
            >
              旧请求迟到回执
            </Button>
          </div>
        </div>
      )}
      <label className="execution-review-select">
        点击停止后模拟
        <select
          aria-label="模拟停止结果"
          value={task.stopDemo || "confirmed"}
          onChange={(event) => onTaskChange({ stopDemo: event.target.value })}
        >
          <option value="confirmed">收到停止确认</option>
          <option value="unknown">一直没有确认</option>
          <option value="failed">停止请求发送失败</option>
        </select>
      </label>
      {["unknown", "failed"].includes(task.stopPhase) && onStopConfirmed && (
        <Button onClick={onStopConfirmed}>演示收到停止确认</Button>
      )}
      {task.eventNote && <p role="status">{task.eventNote}</p>}
      <small>
        已接纳或结果未知的对话，原 Agent、来源、模型与推理选择保持固定。
      </small>
    </details>
  );
}
