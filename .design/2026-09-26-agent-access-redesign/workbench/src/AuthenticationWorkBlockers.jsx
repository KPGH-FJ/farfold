import React from "react";
import { Button } from "./ui.jsx";
import "./authentication-work.css";

const statusLabels = {
  running: "正在运行",
  submitting: "正在发送",
  approval: "审批待处理",
  question: "等待回答",
  stopping: "停止中",
  stopUnconfirmed: "停止结果未知",
  unknown: "结果未知",
};

export default function AuthenticationWorkBlockers({
  tasks = [],
  onOpenTask,
  actionLabel = "登录",
  heading,
}) {
  if (!tasks.length) return null;
  return (
    <section
      className="authentication-work"
      aria-label={`${actionLabel}前需要处理的工作`}
    >
      <div>
        <strong>{heading || `先处理这些工作，再继续${actionLabel}`}</strong>
        <p>这些工作尚未结束。打开对应对话处理后，可返回这里继续。</p>
      </div>
      <ul>
        {tasks.map((task) => (
          <li key={task.id}>
            <div>
              <strong>{task.title || "未命名对话"}</strong>
              <span>{statusLabels[task.status] || "需要确认工作状态"}</span>
            </div>
            {task.canOpen !== false && onOpenTask ? (
              <Button onClick={() => onOpenTask(task.id)}>查看此工作</Button>
            ) : (
              <span className="authentication-work-wait">
                {task.status === "submitting"
                  ? `等待发送结果后，再继续${actionLabel}`
                  : `请先回到原稿确认发送结果，再继续${actionLabel}`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
