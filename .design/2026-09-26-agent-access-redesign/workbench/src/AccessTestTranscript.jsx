import React from "react";
import { Copy } from "@phosphor-icons/react";
import { AgentIcon, Badge, Button } from "./ui";

export default function AccessTestTranscript({ task, copy, onAction }) {
  const test = task.accessTest;
  const active = ["running", "approval", "unknown"].includes(task.status);
  const cancelling = test.phase === "cancelling";
  return (
    <>
      <div className="conv-user-message">
        <div className="conv-message-meta">
          <strong>你</strong>
          <Badge>连接测试 · 模拟</Badge>
          <Button
            kind="icon"
            aria-label="复制测试消息"
            onClick={() => copy(task.prompt)}
          >
            <Copy size={14} />
          </Button>
        </div>
        <p>{task.prompt}</p>
      </div>
      <div className="conv-agent-message">
        <div className="conv-message-meta">
          <AgentIcon name={task.agent} size={21} />
          <strong>{task.agent}</strong>
        </div>
        <p>{test.result === "passed" ? "已连接。（模拟回复）" : test.label}</p>
        <small>
          本条固定测试与准备页展示的是同一次操作；未向真实 Agent 发送请求。
        </small>
      </div>
      {task.status === "approval" && (
        <section className="conv-approval">
          <div className="conv-card-label">
            <Badge tone="amber">需要批准</Badge>
            <span>本次测试请求</span>
          </div>
          <h3>允许本次测试继续吗？</h3>
          <p>这是需要用户确认的模拟返回，仅作用于这条测试。</p>
          <div className="conv-card-actions">
            <Button primary onClick={() => onAction("approve", task.id)}>
              批准本次
            </Button>
            <Button onClick={() => onAction("reject", task.id)}>
              拒绝本次
            </Button>
          </div>
        </section>
      )}
      {active && task.status !== "unknown" && (
        <div className="conv-card-actions">
          <Button
            disabled={cancelling}
            onClick={() => onAction("stop", task.id)}
          >
            {cancelling ? "正在停止，等待确认…" : "停止测试"}
          </Button>
        </div>
      )}
      {task.status === "unknown" && (
        <section className="conv-recovery">
          <Badge tone="amber">结果未知</Badge>
          <h2>这次测试还没有明确结束</h2>
          <p>
            不会自动重试，也不会把未知结果标为可用。可返回准备页查看同一操作。
          </p>
          <details>
            <summary>模拟收到停止确认</summary>
            <p>只结束这次已存在的模拟测试，不再发送新请求。</p>
            <Button onClick={() => onAction("confirm-stopped", task.id)}>
              演示收到停止确认
            </Button>
          </details>
        </section>
      )}
    </>
  );
}
