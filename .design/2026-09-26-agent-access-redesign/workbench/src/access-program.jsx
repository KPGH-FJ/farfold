import React, { useEffect, useRef, useState } from "react";
import { ArrowClockwise, DownloadSimple, Plus } from "@phosphor-icons/react";
import { Button, Badge, Notice } from "./ui.jsx";
import {
  installationReferenceIssue,
  programAction,
  startAgentJob,
} from "./access-jobs.js";
import {
  startProgramChange,
  removableInstallations,
  removeAgentAccess,
  uninstallUnusedProgram,
} from "./agent-redesign-state.js";
import AuthenticationWorkBlockers from "./AuthenticationWorkBlockers.jsx";

export default function AccessProgram({
  agent,
  allAgents = [],
  onChange,
  busyCount,
  blockingTasks = [],
  onOpenBlockingTask,
  outcome,
  cancelOutcome,
}) {
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const [uninstallIds, setUninstallIds] = useState([]);
  const confirmationRef = useRef(null);
  useEffect(() => {
    if (confirmation) {
      confirmationRef.current?.focus();
      confirmationRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [confirmation]);
  const [programId, setProgramId] = useState("");
  const locked =
    !!busyCount || !!agent.accessJob || agent.connectionState === "unknown";
  const selected = agent.installations.find(
    (item) => item.id === agent.selectedInstallationId,
  );
  const discovered =
    agent.installations.find((item) => item.id === programId) ||
    (agent.installations.length === 1 ? agent.installations[0] : null);
  const removable = removableInstallations(agent, allAgents);
  const start = (type, options = {}) =>
    onChange(
      startProgramChange(agent, type, {
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
    setConfirmation({ action: "select", item, label: value });
    setError("");
  };
  const apply = () => {
    if (locked) return;
    if (confirmation.action === "remove") {
      onChange(
        removeAgentAccess(agent, { busyCount, allAgents, uninstallIds }),
      );
    } else if (confirmation.action === "uninstall") {
      onChange(
        uninstallUnusedProgram(agent, confirmation.item.id, {
          busyCount,
          allAgents,
        }),
      );
    } else if (confirmation.action === "select") {
      const item = confirmation.item;
      const next = agent.installations.some((entry) => entry.id === item.id)
        ? agent
        : { ...agent, installations: [...agent.installations, item] };
      onChange(
        startProgramChange(next, "select", {
          candidateId: item.id,
          outcome,
          cancelOutcome,
          busyCount,
        }),
      );
      setPath("");
    } else start("install");
    setConfirmation(null);
  };
  return (
    <section className="access-program">
      <div className="access-program-summary">
        <div>
          <h3>程序</h3>
          <p>
            {agent.removed
              ? "已移除接入"
              : agent.connected
                ? "程序检查通过 · 演示"
                : agent.accessJob
                  ? "正在检查程序…"
                  : agent.registered
                    ? "已添加，等待自动检查"
                    : agent.installations.length
                      ? "发现本机程序"
                      : "尚未安装"}
          </p>
        </div>
        {!agent.registered && agent.installations.length > 0 ? (
          <div className="agent-program-add">
            {agent.installations.length > 1 && (
              <label className="access-field">
                <span>选择本机程序</span>
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
                      {item.version || "版本未读取"} · {item.path}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button
              primary
              disabled={locked || !discovered}
              onClick={() =>
                onChange(
                  programAction(agent, "register", discovered.id, busyCount),
                )
              }
            >
              <Plus size={15} />
              添加本机程序
            </Button>
          </div>
        ) : agent.dependenciesMissing ? (
          <Button primary disabled={locked} onClick={() => start("dependency")}>
            补齐必要程序
          </Button>
        ) : !agent.installed ? (
          <Button
            primary
            disabled={locked || agent.installSupported === false}
            onClick={() => start("install")}
          >
            <DownloadSimple size={15} />
            安装程序
          </Button>
        ) : !agent.connected &&
          !agent.accessJob &&
          (agent.connectionState === "failed" ||
            agent.lastAccessResult?.type === "connect") ? (
          <Button
            disabled={locked}
            onClick={() =>
              onChange(
                startAgentJob(agent, "connect", {
                  outcome,
                  cancelOutcome,
                  busyCount,
                }),
              )
            }
          >
            <ArrowClockwise size={15} />
            重新检查程序
          </Button>
        ) : null}
      </div>
      {selected && (
        <dl className="agent-program-facts agent-facts">
          <div>
            <dt>程序版本</dt>
            <dd>{selected.version || "未读取"}</dd>
          </div>
          <div>
            <dt>安装来源</dt>
            <dd>{selected.managed ? "Farfold 管理" : "已有本机程序"}</dd>
          </div>
          <div>
            <dt>接入组件版本</dt>
            <dd>
              {selected.componentVersion ||
                agent.componentVersion ||
                "未单独提供"}
            </dd>
          </div>
        </dl>
      )}
      <p className="access-muted">
        打开设置时自动检查程序。这里的安装与检查均为演示，不运行本机命令。
      </p>
      {agent.dependenciesMissing && (
        <p className="access-warning">缺少运行所需程序，请先补齐。</p>
      )}
      {!!busyCount && (
        <Notice title={`这个 Agent 有 ${busyCount} 项工作待处理`}>
          完成待处理工作后可以更换程序或移除接入。
        </Notice>
      )}
      <AuthenticationWorkBlockers
        actionLabel="程序管理"
        tasks={blockingTasks}
        onOpenTask={onOpenBlockingTask}
      />
      {agent.connectionState === "unknown" && (
        <Notice title="程序检查结果尚未确认">
          请先确认上一次检查已结束，再更换程序。
        </Notice>
      )}
      {confirmation ? (
        <div
          className="access-confirm agent-action-confirm"
          ref={confirmationRef}
          tabIndex={-1}
          role="group"
          aria-label="确认程序操作"
        >
          <h3>
            {confirmation.action === "remove"
              ? "移除此 Agent？"
              : confirmation.action === "uninstall"
                ? "卸载这份旧版本？"
                : confirmation.action === "select"
                  ? "更换所选程序？"
                  : "检查并更新程序？"}
          </h3>
          {confirmation.action === "remove" ? (
            <>
              <p>
                从 Farfold 移除接入，并撤回此 Agent 对已保存 API
                服务的使用授权。
              </p>
              <ul>
                <li>保留程序、账号配置和全部历史。</li>
                <li>已有对话可在对话库查看；重新使用需再次添加。</li>
              </ul>
              {removable.length > 0 && (
                <fieldset className="agent-remove-options">
                  <legend>可选清理 · 默认保留</legend>
                  {removable.map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={uninstallIds.includes(item.id)}
                        onChange={(event) =>
                          setUninstallIds(
                            event.target.checked
                              ? [...uninstallIds, item.id]
                              : uninstallIds.filter((id) => id !== item.id),
                          )
                        }
                      />
                      <span>
                        同时卸载 Farfold 管理的程序{" "}
                        <small>
                          {item.version} · {item.path}
                        </small>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              <p className="access-muted">
                外部安装不会卸载。此样例未提供退出账号能力。
              </p>
            </>
          ) : confirmation.action === "uninstall" ? (
            <>
              <dl className="agent-facts">
                <div>
                  <dt>待卸载版本</dt>
                  <dd>{confirmation.item.version || "版本未读取"}</dd>
                </div>
                <div>
                  <dt>受管理路径</dt>
                  <dd>{confirmation.item.path}</dd>
                </div>
              </dl>
              <p>
                仅删除这份未选用、未被其他 Agent 使用的 Farfold
                受管理程序。当前程序、接入、账号配置、已保存服务与全部对话历史均保留。
              </p>
              <p className="access-muted">演示清理，不删除本机文件。</p>
            </>
          ) : (
            <>
              <dl className="agent-facts">
                <div>
                  <dt>当前程序</dt>
                  <dd>
                    {selected?.version || "未选择"}
                    <small>{selected?.path || ""}</small>
                  </dd>
                </div>
                <div>
                  <dt>候选程序</dt>
                  <dd>
                    {confirmation.action === "select"
                      ? confirmation.item.version
                      : "检查可安装版本 · 演示"}
                    <small>{confirmation.label}</small>
                  </dd>
                </div>
              </dl>
              <p>
                闲置连接自动结束。候选检查成功且确认结束后才替换当前选择；失败、取消或结果未知时保留原程序、配置与历史。
              </p>
            </>
          )}
          <div className="access-inline">
            <Button onClick={() => setConfirmation(null)}>取消</Button>
            <Button primary disabled={locked} onClick={apply}>
              {confirmation.action === "remove"
                ? "确认移除接入"
                : confirmation.action === "uninstall"
                  ? "确认卸载旧版本"
                  : "开始检查"}
            </Button>
          </div>
        </div>
      ) : null}
      <details className="access-program-details">
        <summary>
          程序路径与高级管理
          {agent.installations.length
            ? ` · ${agent.installations.length} 份程序`
            : ""}
        </summary>
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
                {item.componentVersion && (
                  <small>接入组件 {item.componentVersion}</small>
                )}
                {installationReferenceIssue(agent, item, allAgents) && (
                  <small className="access-warning">
                    {installationReferenceIssue(agent, item, allAgents)}
                  </small>
                )}
              </div>
              {item.id !== agent.selectedInstallationId && (
                <div className="access-inline">
                  <Button
                    disabled={locked}
                    onClick={() =>
                      setConfirmation({
                        action: "select",
                        item,
                        label: item.path,
                      })
                    }
                  >
                    检查并选用
                  </Button>
                  {item.managed && (
                    <Button
                      disabled={
                        locked ||
                        !removable.some((entry) => entry.id === item.id)
                      }
                      title={
                        installationReferenceIssue(agent, item, allAgents) ||
                        (item.inUse ? "这份程序仍在使用" : undefined)
                      }
                      onClick={() =>
                        setConfirmation({ action: "uninstall", item })
                      }
                    >
                      卸载旧版本
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <label className="access-field">
          <span>选择其他本机程序</span>
          <input
            value={path}
            disabled={locked}
            placeholder="/完整路径/agent"
            onChange={(event) => setPath(event.target.value)}
          />
        </label>
        <Button disabled={locked || !path.trim()} onClick={addPath}>
          检查并使用此路径
        </Button>
        {error && (
          <p role="alert" className="access-error">
            {error}
          </p>
        )}
      </details>
      <div className="agent-program-actions">
        <Button
          disabled={locked || agent.installSupported === false}
          onClick={() => setConfirmation({ action: "update" })}
        >
          <DownloadSimple size={15} />
          检查更新 / 安装另一份
        </Button>
        {agent.registered && (
          <Button
            disabled={locked}
            onClick={() => {
              setUninstallIds([]);
              setConfirmation({ action: "remove" });
            }}
          >
            移除 Agent
          </Button>
        )}
      </div>
    </section>
  );
}
