import { useState } from "react";
import {
  CaretDown,
  CheckCircle,
  CircleNotch,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ToolActivity } from "../runtime/conversation";

interface PiActivityProps {
  tools: ToolActivity[];
  notice: string | null;
}

function toolLabel(name: string): string {
  const normalized = name.toLocaleLowerCase();
  if (normalized.includes("bash") || normalized.includes("shell"))
    return "运行命令";
  if (normalized.includes("read")) return "读取文件";
  if (normalized.includes("edit") || normalized.includes("write"))
    return "修改文件";
  if (normalized.includes("search") || normalized.includes("grep"))
    return "搜索内容";
  return name;
}

function compactSummary(summary: string): string {
  const firstLine = summary.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 88 ? `${firstLine.slice(0, 88)}…` : firstLine;
}

export function PiActivity({ tools, notice }: PiActivityProps) {
  const [open, setOpen] = useState(true);
  if (!tools.length && !notice) return null;
  const running = tools.some((tool) => tool.state === "running");

  return (
    <section className="pi-activity" aria-label="Pi 执行进度">
      <button
        className="activity-heading"
        onClick={() => setOpen((value) => !value)}
      >
        <CaretDown size={15} className={open ? "" : "collapsed"} />
        <span>Pi 执行{tools.length ? ` · ${tools.length} 个步骤` : ""}</span>
        <small>{running ? "进行中" : "已完成"}</small>
      </button>
      {open && (
        <div className="activity-steps">
          {tools.map((tool) => (
            <div className={`activity-step ${tool.state}`} key={tool.id}>
              {tool.state === "running" ? (
                <CircleNotch className="spin" size={16} />
              ) : tool.state === "failed" ? (
                <WarningCircle size={16} weight="fill" />
              ) : (
                <CheckCircle size={16} weight="fill" />
              )}
              <span>
                <strong>{toolLabel(tool.name)}</strong>
                {tool.summary.length > 100 || tool.summary.includes("\n") ? (
                  <details className="tool-details">
                    <summary>{compactSummary(tool.summary)}</summary>
                    <pre>{tool.summary}</pre>
                  </details>
                ) : (
                  <small>{tool.summary || "等待 Pi 返回结果"}</small>
                )}
              </span>
            </div>
          ))}
          {notice && <p className="pi-notice">{notice}</p>}
        </div>
      )}
    </section>
  );
}

interface QueueProps {
  steering: string[];
  followUp: string[];
}

export function QueueNotice({ steering, followUp }: QueueProps) {
  if (!steering.length && !followUp.length) return null;
  return (
    <div className="queue-notice">
      {steering.map((item, index) => (
        <div key={`steer-${index}`}>
          <p>已接收转向 · 将在当前工具完成后应用</p>
          <span>{item}</span>
        </div>
      ))}
      {followUp.map((item, index) => (
        <div key={`follow-${index}`}>
          <p>已加入跟进 · 将在当前任务完成后执行</p>
          <span>{item}</span>
        </div>
      ))}
    </div>
  );
}
