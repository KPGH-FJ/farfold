import React, { useEffect, useRef, useState } from "react";
import { Button } from "./ui.jsx";
import {
  beginModelRead,
  finishModelRead,
  modelReadScope,
} from "./model-read-state.js";
export default function AgentModelRead({
  agent,
  selection,
  onChange,
  disabled,
}) {
  const [outcome, setOutcome] = useState("choices");
  const latest = useRef({ agent, selection });
  latest.current = { agent, selection };
  const scope = modelReadScope(agent, selection);
  const read = agent.modelCatalog?.scope === scope ? agent.modelCatalog : null;
  useEffect(() => {
    if (read?.status !== "loading") return;
    if (disabled || !agent.connected) {
      onChange({ ...agent, modelCatalog: { ...read, status: "idle" } });
      return;
    }
    const timer = setTimeout(() => {
      const current = latest.current;
      const next = finishModelRead(current.agent, current.selection, scope);
      if (next !== current.agent) onChange(next);
    }, 450);
    return () => clearTimeout(timer);
  }, [read?.status, scope, disabled, agent.connected]);
  const text =
    read?.status === "failed"
      ? "模型选项读取失败，原选择已保留。"
      : read?.status === "not-provided"
        ? "Agent 未提供可选模型，将使用它自己的配置。"
        : read?.status === "ready"
          ? "已读取可选模型 · 演示"
          : read?.status === "loading"
            ? "正在读取模型选项…"
            : "尚未读取模型选项；当前模型来源与已保存选择保持不变。";
  return (
    <div className="model-read-control">
      {text && (
        <p
          role="status"
          className={
            read?.status === "failed" ? "access-warning" : "access-muted"
          }
        >
          {text}
          {read?.status === "not-provided" && (
            <span>
              {" "}
              这不代表模型列表为空或账号不可用；可沿用 Agent 配置继续。
            </span>
          )}
        </p>
      )}
      <Button
        disabled={disabled || read?.status === "loading"}
        onClick={() => onChange(beginModelRead(agent, selection, outcome))}
      >
        {read?.status === "failed"
          ? "重新读取模型"
          : read?.status === "loading"
            ? "读取中…"
            : "读取模型选项"}
      </Button>
      <details className="access-review">
        <summary>评审：模型读取结果</summary>
        <label className="access-field">
          <span>读取结果（能力样例）</span>
          <select
            value={outcome}
            disabled={read?.status === "loading"}
            onChange={(event) => setOutcome(event.target.value)}
          >
            <option value="choices">提供可选模型</option>
            <option value="none">未提供模型选项</option>
            <option value="failure">读取失败</option>
          </select>
        </label>
      </details>
    </div>
  );
}
