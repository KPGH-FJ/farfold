import React, { useState } from "react";
import {
  ArrowClockwise,
  DownloadSimple,
  LinkBreak,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { Button, Badge, Notice } from "./ui.jsx";
import {
  installationReferenceIssue,
  programAction,
  startAgentJob,
} from "./access-jobs.js";

export default function AccessProgram({
  agent,
  allAgents = [],
  onChange,
  busyCount,
  outcome,
  cancelOutcome,
}) {
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const [programId, setProgramId] = useState("");
  const locked = !!busyCount || !!agent.accessJob;
  const mutationLocked = locked || agent.connected;
  const selected = agent.installations.find(
    (item) => item.id === agent.selectedInstallationId,
  );
  const discovered =
    agent.installations.find((item) => item.id === programId) ||
    (agent.installations.length === 1 ? agent.installations[0] : null);
  const start = (type, options = {}) =>
    onChange(
      startAgentJob(agent, type, {
        outcome,
        cancelOutcome,
        busyCount,
        ...options,
      }),
    );
  const addPath = () => {
    const value = path.trim();
    if (!value.startsWith("/") || value.includes("\n")) {
      setError("填写以 / 开头的完整程序路径。这里只模拟选择，不运行程序。");
      return;
    }
    if (agent.installations.some((item) => item.path === value)) {
      setError("这份程序已在列表中。");
      return;
    }
    const item = {
      id: `external-${Date.now()}`,
      path: value,
      version: "未读取",
      managed: false,
    };
    const next = { ...agent, installations: [...agent.installations, item] };
    onChange(
      startAgentJob(next, "select", {
        candidateId: item.id,
        outcome,
        cancelOutcome,
        busyCount,
      }),
    );
    setPath("");
    setError("");
  };
  const apply = () => {
    onChange(
      programAction(agent, confirmation.action, confirmation.id, busyCount, {
        allAgents,
      }),
    );
    setConfirmation(null);
  };
  return (
    <section className="access-program">
      <div className="access-program-summary">
        <div>
          <h3>程序</h3>
          <p>
            {agent.removed
              ? "接入已移除，程序与历史保留"
              : agent.connected
                ? "已连接"
                : agent.registered
                  ? "已添加，尚未连接"
                  : agent.installations.length
                    ? "本机发现，尚未添加"
                    : "尚未发现程序"}
            {selected ? ` · ${selected.version}` : ""}
          </p>
          {!agent.registered && agent.installations.length > 1 && (
            <label className="access-field">
              <span>选择要接入的本机程序</span>
              <select
                value={discovered?.id || ""}
                disabled={locked}
                onChange={(event) => setProgramId(event.target.value)}
              >
                <option value="" disabled>
                  请选择一份程序
                </option>
                {agent.installations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {`${item.version || "未读取版本"} · ${item.path}`}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {agent.connected ? (
          <Button
            disabled={locked}
            onClick={() =>
              onChange(programAction(agent, "disconnect", null, busyCount))
            }
          >
            <LinkBreak size={15} />
            断开
          </Button>
        ) : !agent.registered && agent.installations.length ? (
          <Button
            primary
            disabled={locked || !discovered}
            onClick={() =>
              discovered &&
              onChange(
                startAgentJob(
                  programAction(agent, "register", discovered.id, busyCount),
                  "connect",
                  { outcome, cancelOutcome, busyCount },
                ),
              )
            }
          >
            <Plus size={15} />
            {agent.dependenciesMissing ? "添加本机程序" : "添加并连接"}
          </Button>
        ) : agent.dependenciesMissing ? (
          <Button primary disabled={locked} onClick={() => start("dependency")}>
            补齐必要程序
          </Button>
        ) : agent.installed && agent.registered ? (
          <Button primary disabled={locked} onClick={() => start("connect")}>
            <ArrowClockwise size={15} />
            {agent.connectionState === "failed" ? "重新连接" : "连接"}
          </Button>
        ) : (
          <Button
            primary
            disabled={locked || agent.installSupported === false}
            onClick={() => start("install")}
          >
            <DownloadSimple size={15} />
            安装程序
          </Button>
        )}
      </div>
      {agent.dependenciesMissing && (
        <p className="access-warning">
          接入组件已存在，但缺少运行所需程序。补齐后才能连接。
        </p>
      )}
      {!!busyCount && (
        <Notice title={`这个 Agent 有 ${busyCount} 项工作待处理`}>
          先处理进行中的任务、待回应或未确认结果，再断开或更换程序。其他 Agent
          可以继续工作。
        </Notice>
      )}
      <details className="access-program-details">
        <summary>
          管理程序与接入
          {agent.installations.length
            ? ` · ${agent.installations.length} 份程序`
            : ""}
        </summary>
        <p>更换程序前先断开。候选检查及结束确认都成功后才替换当前选择。</p>
        <div className="access-installations">
          {agent.installations.map((item) => (
            <div className="access-installation" key={item.id}>
              <div>
                <strong>{item.version || "未读取版本"}</strong>{" "}
                <Badge>
                  {item.id === agent.selectedInstallationId
                    ? "正在选用"
                    : item.managed
                      ? "Farfold 管理"
                      : "外部安装"}
                </Badge>
                <code>{item.path}</code>
                {installationReferenceIssue(agent, item, allAgents) && (
                  <small className="access-warning">
                    {installationReferenceIssue(agent, item, allAgents)}
                  </small>
                )}
                {item.componentVersion && (
                  <small>
                    接入组件 {item.componentVersion} · 与程序版本分别记录
                  </small>
                )}
              </div>
              <div className="access-inline">
                {item.id !== agent.selectedInstallationId && (
                  <Button
                    disabled={mutationLocked}
                    onClick={() => start("select", { candidateId: item.id })}
                  >
                    检查并选用
                  </Button>
                )}
                {item.managed && (
                  <Button
                    disabled={
                      mutationLocked ||
                      item.id === agent.selectedInstallationId ||
                      item.inUse ||
                      !!installationReferenceIssue(agent, item, allAgents)
                    }
                    title={
                      installationReferenceIssue(agent, item, allAgents) ||
                      "卸载这份程序"
                    }
                    aria-label={`卸载 ${item.version} ${item.path}`}
                    onClick={() =>
                      setConfirmation({
                        action: "uninstall",
                        id: item.id,
                        label: item.path,
                      })
                    }
                  >
                    <Trash size={15} />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
        {agent.connected && (
          <p className="access-muted">
            当前仍连接着这份程序；先点击上方“断开”。
          </p>
        )}
        <div className="access-inline">
          <Button
            disabled={mutationLocked || agent.installSupported === false}
            onClick={() => start("install")}
          >
            <DownloadSimple size={15} />
            安装另一份 / 更新
          </Button>
          {agent.registered && (
            <Button
              disabled={mutationLocked}
              onClick={() =>
                setConfirmation({ action: "remove", label: agent.name })
              }
            >
              移除接入
            </Button>
          )}
        </div>
        <label className="access-field">
          <span>选择其他本机程序</span>
          <input
            value={path}
            disabled={mutationLocked}
            placeholder="/完整路径/agent"
            onChange={(event) => setPath(event.target.value)}
          />
        </label>
        <Button disabled={mutationLocked || !path.trim()} onClick={addPath}>
          检查并使用此路径
        </Button>
        {error && (
          <p role="alert" className="access-error">
            {error}
          </p>
        )}
        <small>
          断开只结束连接；移除撤销 Farfold
          中的接入许可，程序、账号设置和历史保留。外部安装不由 Farfold 卸载。
        </small>
        {confirmation && (
          <div
            className="access-confirm"
            role="group"
            aria-label="确认程序操作"
          >
            <strong>
              {confirmation.action === "remove"
                ? "移除此接入？"
                : "卸载这份受管理程序？"}
            </strong>
            <p>{confirmation.label}</p>
            <p>
              {confirmation.action === "remove"
                ? "不会删除程序、账号配置或任何历史。再次使用需要明确添加。"
                : "仅删除这份未选用且没有工作使用的程序；不会删除历史。"}
            </p>
            <div className="access-inline">
              <Button onClick={() => setConfirmation(null)}>取消</Button>
              <Button disabled={mutationLocked} onClick={apply}>
                确认{confirmation.action === "remove" ? "移除" : "卸载"}
              </Button>
            </div>
          </div>
        )}
      </details>
    </section>
  );
}
