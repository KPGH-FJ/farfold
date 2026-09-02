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
  runtimeLabel?: string;
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

export function activityStatus(
  tools: ToolActivity[],
  notice: string | null = null,
): string {
  const active = [...tools].reverse().find((tool) => tool.state === "running");
  if (active) return `正在${toolLabel(active.name)}`;
  if (tools.some((tool) => tool.state === "failed")) return "有步骤失败";
  if (notice) return compactSummary(notice);
  return tools.length ? "已完成" : "";
}

export function PiActivity({
  tools,
  notice,
  runtimeLabel = "Pi",
}: PiActivityProps) {
  const [open, setOpen] = useState(false);
  if (!tools.length && !notice) return null;

  return (
    <section className="pi-activity" aria-label={`${runtimeLabel} 执行进度`}>
      <button
        className="activity-heading"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <CaretDown size={15} className={open ? "" : "collapsed"} />
        <span>
          {runtimeLabel} 执行{tools.length ? ` · ${tools.length} 个步骤` : ""}
        </span>
        <small>{activityStatus(tools, notice)}</small>
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
                <strong title={tool.name}>{toolLabel(tool.name)}</strong>
                {tool.summary.length > 100 || tool.summary.includes("\n") ? (
                  <details className="tool-details">
                    <summary>{compactSummary(tool.summary)}</summary>
                    <pre>{tool.summary}</pre>
                  </details>
                ) : (
                  <small>
                    {tool.summary || `等待 ${runtimeLabel} 返回结果`}
                  </small>
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
    <div className="queue-notice" role="status" aria-label="Pi 消息队列">
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
