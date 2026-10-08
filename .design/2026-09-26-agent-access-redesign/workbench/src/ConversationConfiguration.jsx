import React, { useEffect, useRef, useState } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";
import { AgentIcon, Button, Modal } from "./ui";
import {
  configurationGate,
  configurationModels,
  startConfigurationChange,
  finishConfigurationChange,
} from "./conversation-configuration.js";

export default function ConversationConfiguration({
  task,
  capability,
  onTaskChange,
  onNew,
  active = true,
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState({
    model: task.model,
    effort: task.effort,
  });
  const latest = useRef({ task, onTaskChange });
  latest.current = { task, onTaskChange };
  const timer = useRef(null);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      const current = latest.current;
      if (current.task.configurationChange?.phase === "pending")
        current.onTaskChange(
          finishConfigurationChange(
            current.task,
            current.task.configurationChange.id,
            "unknown",
          ),
        );
    },
    [],
  );
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  useEffect(() => {
    setChoice({ model: task.model, effort: task.effort });
    setOpen(false);
  }, [task.id]);
  const models = configurationModels(capability, task);
  const selected = models.find((model) => model.id === choice.model);
  const efforts = selected?.efforts || capability?.efforts || [];
  const gate = configurationGate(task);
  const changed = choice.model !== task.model || choice.effort !== task.effort;
  const pending = task.configurationChange?.phase === "pending";
  const source = task.source || "沿用 Agent 已有设置";
  const identity =
    task.serviceSnapshot?.identity ||
    task.serviceSnapshot?.account ||
    task.account ||
    "账号信息未提供";
  const endpoint = task.serviceSnapshot?.endpoint;
  const settle = (id, outcome) => {
    timer.current = setTimeout(() => {
      const current = latest.current;
      const patch = finishConfigurationChange(current.task, id, outcome);
      if (patch) current.onTaskChange(patch);
    }, 800);
  };
  const save = () => {
    const id = crypto.randomUUID();
    const patch = startConfigurationChange(task, capability, choice, id);
    if (!patch) return;
    onTaskChange(patch);
    settle(id, task.configurationPreviewResult || "success");
  };
  return (
    <>
      <button
        className="conv-composer-identity"
        type="button"
        aria-label="查看和更改对话设置"
        title={`${task.agent} · ${task.source || "沿用 Agent 已有设置"} · ${task.model || "模型未提供"} · ${task.effort || "由 Agent 决定推理"}`}
        aria-expanded={open}
        onClick={() => {
          setChoice({ model: task.model, effort: task.effort });
          setOpen(true);
        }}
      >
        <AgentIcon name={task.agent} size={17} />
        <span>{task.agent}</span>
        <span className="conv-control-divider" />
        <span className="conv-model-name">{task.model || "模型未提供"}</span>
        {task.effort && <span className="cr-effort">{task.effort}</span>}
        <CaretDown size={12} />
      </button>
      {open && active && (
        <Modal
          title="对话设置"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button onClick={() => setOpen(false)}>关闭</Button>
              <Button
                primary
                disabled={Boolean(gate) || !changed}
                onClick={save}
              >
                {pending ? "正在确认并保存…" : "确认并保存"}
              </Button>
            </>
          }
        >
          <p className="cr-demo-caption">
            可点击演示 · 不连接 Agent，不更改真实设置
          </p>
          <section className="cr-source-summary" aria-label="当前服务与身份">
            <strong>
              {task.agent} · {source}
            </strong>
            <span>{identity}</span>
            {endpoint && <code>{endpoint}</code>}
            <small>Agent 与服务来源属于这条对话。切换它们需要新开对话。</small>
            <Button
              kind="text"
              onClick={() => {
                setOpen(false);
                onNew?.();
              }}
            >
              使用其他 Agent 或来源新开对话
            </Button>
          </section>
          <div className="cr-configuration-fields">
            <label>
              下一条消息的模型
              <select
                aria-label="下一条消息的模型"
                disabled={
                  Boolean(gate) ||
                  !capability?.supportsModelChange ||
                  models.length < 2
                }
                value={choice.model || ""}
                onChange={(event) => {
                  const model = models.find(
                    (item) => item.id === event.target.value,
                  );
                  const options = model?.efforts || capability?.efforts || [];
                  setChoice({
                    model: event.target.value,
                    effort: options.includes(choice.effort)
                      ? choice.effort
                      : options[0] || task.effort,
                  });
                }}
              >
                {!models.some((model) => model.id === task.model) && (
                  <option value={task.model}>{task.model}（原选择）</option>
                )}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              下一条消息的推理
              <select
                aria-label="下一条消息的推理"
                disabled={
                  Boolean(gate) ||
                  !capability?.supportsEffortChange ||
                  !efforts.length
                }
                value={choice.effort || ""}
                onChange={(event) =>
                  setChoice({ ...choice, effort: event.target.value })
                }
              >
                {!efforts.includes(choice.effort) && (
                  <option value={choice.effort || ""}>
                    {choice.effort || "由 Agent 决定"}
                  </option>
                )}
                {efforts.map((effort) => (
                  <option key={effort}>{effort}</option>
                ))}
              </select>
            </label>
          </div>
          {(!capability?.models?.length ||
            !capability?.supportsModelChange) && (
            <p className="cr-context">
              此来源未提供可切换的模型列表，保留当前值。
            </p>
          )}
          <table className="cr-comparison" aria-label="对话设置更改比较">
            <thead>
              <tr>
                <th>设置</th>
                <th>当前已保存</th>
                <th>本次选择</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>来源</th>
                <td>{source}</td>
                <td>{source} · 保持</td>
              </tr>
              <tr>
                <th>身份</th>
                <td>{identity}</td>
                <td>{identity} · 保持</td>
              </tr>
              <tr>
                <th>模型</th>
                <td>{task.model || "未提供"}</td>
                <td>{choice.model || "未提供"}</td>
              </tr>
              <tr>
                <th>推理</th>
                <td>{task.effort || "由 Agent 决定"}</td>
                <td>{choice.effort || "由 Agent 决定"}</td>
              </tr>
            </tbody>
          </table>
          {gate && (
            <p className="cr-state-note" role="status">
              {gate}。草稿和待发消息保留。
            </p>
          )}
          {task.configurationNotice && (
            <p className="cr-state-note" role="status">
              {task.configurationNotice.startsWith("设置已确认") && (
                <Check size={16} />
              )}{" "}
              {task.configurationNotice}
            </p>
          )}
          {task.configurationChange?.phase === "unknown" && (
            <Button
              onClick={() => settle(task.configurationChange.id, "success")}
            >
              核对本次设置结果（演示）
            </Button>
          )}
          <p className="cr-context">
            确认后才更新下一次发送的基准；已有消息不会改写。待发消息仍需单独继续发送。
          </p>
        </Modal>
      )}
    </>
  );
}
