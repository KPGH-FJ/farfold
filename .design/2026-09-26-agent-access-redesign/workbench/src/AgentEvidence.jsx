import React from "react";
import { agentAccountIdentity } from "./agent-redesign-state.js";
import { agentServiceFormats } from "./service-access.js";

export function AgentIdentity({
  agent,
  source,
  model,
  folder,
  testValid = false,
}) {
  return (
    <section className="agent-current-overview" aria-label="当前使用信息">
      <div className="agent-section-heading">
        <h3>当前使用信息</h3>
        <span className="agent-demo-label">演示数据</span>
      </div>
      <dl className="agent-facts">
        <div>
          <dt>账号身份</dt>
          <dd>{agentAccountIdentity(agent, folder)}</dd>
        </div>
        <div>
          <dt>服务来源</dt>
          <dd>{source || "沿用已有设置 · 具体服务未提供"}</dd>
        </div>
        <div>
          <dt>模型</dt>
          <dd>{model || "由 Agent 配置决定 · 名称未提供"}</dd>
        </div>
        <div>
          <dt>模型请求</dt>
          <dd>{testValid ? "当前选择已通过演示测试" : "尚未验证"}</dd>
        </div>
      </dl>
      <p className="access-muted">
        程序可连接、账号身份和模型请求分别确认；未提供身份信息不等于未登录。
      </p>
    </section>
  );
}

export function AgentCapabilities({ agent }) {
  const formats = agentServiceFormats(agent);
  const rows = [
    ["程序", agent.installed ? "样例：已发现程序" : "尚未准备", "本页演示状态"],
    [
      "账号登录",
      agent.authMethods?.length
        ? `${agent.authMethods.length} 种登录交互样例`
        : "程序尚未提供登录选项",
      "能力样例；实际以程序返回为准",
    ],
    [
      "Farfold API 服务",
      formats.length ? `可演示 ${formats.join(" / ")}` : "共享服务能力未确认",
      "本页配置能力样例",
    ],
    [
      "模型与推理",
      agent.models?.length
        ? `${agent.models.length} 个模型样例${agent.efforts?.length ? "，含推理等级" : ""}`
        : "模型选项未提供",
      "读取选项不代表有请求权限",
    ],
    ["真实请求与恢复", "未验证", "原型不会连接真实账号或发送请求"],
  ];
  return (
    <section className="agent-capability-section">
      <div className="agent-section-heading">
        <h3>能力与依据</h3>
        <span className="agent-demo-label">
          {agent.fixtureProvided === false
            ? "目录身份 · 能力未提供"
            : "原型能力样例"}
        </span>
      </div>
      <table className="agent-capability-table">
        <thead>
          <tr>
            <th>能力</th>
            <th>当前信息</th>
            <th>依据与范围</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, value, evidence]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>{value}</td>
              <td>{evidence}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="agent-evidence-details">
        <summary>查看目录说明与依据</summary>
        <p>{agent.supportNote}</p>
        <p>{agent.capabilitiesEvidence || "目录信息不能代替本机能力检查。"}</p>
      </details>
    </section>
  );
}
