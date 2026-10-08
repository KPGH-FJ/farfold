import React, { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowSquareOut,
  CheckCircle,
  MagnifyingGlass,
  Plus,
  SlidersHorizontal,
  X,
} from "@phosphor-icons/react";
import { Badge, Button, Empty, Modal, Tabs } from "./ui.jsx";
import AgentSetup, { HubIcon } from "./AgentSetup.jsx";
import {
  AGENT_CATALOG,
  AGENT_CATEGORIES,
  catalogState,
} from "./agent-catalog.js";
import {
  agentCanStartConversation,
  agentNeedsInitialPreparation,
  busyAgentTasks,
  normalizeAgent,
  reconcileAgentServices,
} from "./agent-setup-state.js";
import { agentHubStatus } from "./agent-hub-status.js";
import {
  hasPendingOnboarding,
  pendingOnboardingForEntry,
} from "./setup-entry.js";
import "./agent-hub.css";
import "./access-ui.css";
import "./agent-redesign.css";
import { AgentCapabilities, AgentIdentity } from "./AgentEvidence.jsx";

export default function AgentHub({
  agents = [],
  setAgents,
  services = [],
  setServices,
  onUse,
  toast = () => {},
  initialAgent,
  initialRequest,
  initialSelection,
  initialContext,
  onOpenTest,
  onImportExisting,
  tasks = [],
  onManageServices,
  onReturnToTask,
  onPreparationIntent,
  onOpenBlockingTask,
  returnLabel,
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [view, setView] = useState("discover");
  const [detail, setDetail] = useState(null);
  const [setup, setSetup] = useState(null);
  const [setupIntent, setSetupIntent] = useState(null);
  const [custom, setCustom] = useState(null);
  const [customExit, setCustomExit] = useState(false);
  const [customDraft, setCustomDraft] = useState(null);
  const closeCustom = () => {
    if (custom && Object.values(custom).some((value) => String(value).trim()))
      setCustomExit(true);
    else setCustom(null);
  };
  const [customError, setCustomError] = useState("");
  const [scanResult, setScanResult] = useState("");
  const seenInitial = useRef(null);
  const known = new Set(AGENT_CATALOG.map((item) => item.id));
  const entries = reconcileAgentServices(
    [
      ...AGENT_CATALOG.map((item) => catalogState(item, agents)),
      ...agents.filter((item) => !known.has(item.id)),
    ].map(normalizeAgent),
    services,
  );
  useEffect(() => {
    setAgents?.((previous) => reconcileAgentServices(previous, services));
  }, [services, setAgents]);
  useEffect(() => {
    if (initialContext?.directoryView) setView(initialContext.directoryView);
    if (!initialAgent) {
      seenInitial.current = null;
      return;
    }
    const request = `${initialAgent}:${initialRequest ?? "initial"}`;
    if (seenInitial.current === request) return;
    const item =
      entries.find((entry) => entry.id === initialAgent) ||
      entries.find((entry) => entry.name === initialAgent);
    if (item) {
      seenInitial.current = request;
      setSetup(item.id);
      setSetupIntent(initialContext?.intent || null);
      setDetail(null);
    }
  }, [initialAgent, initialRequest]);
  const mutate = (item, changes) =>
    setAgents?.((previous) => {
      const exact = previous.findIndex((entry) => entry.id === item.id);
      const index =
        exact >= 0
          ? exact
          : previous.findIndex(
              (entry) => !entry.id && entry.name === item.name,
            );
      const row = {
        ...item,
        ...(index >= 0 ? previous[index] : {}),
        ...changes,
      };
      return index < 0
        ? [...previous, row]
        : previous.map((entry, i) => (i === index ? row : entry));
    });
  const prepare = (item, intent = "use") => {
    if (
      intent !== "manage" &&
      (agentNeedsInitialPreparation(item) ||
        pendingOnboardingForEntry(item, initialSelection, {
          ...initialContext,
          intent,
        }))
    )
      intent = "use";
    setDetail(null);
    setSetup(item.id);
    setSetupIntent(intent);
    onPreparationIntent?.(intent);
  };
  const use = (item) => {
    if (agentCanStartConversation(item) && !hasPendingOnboarding(item)) {
      setDetail(null);
      setSetup(null);
      onUse?.(item.name, item, { intent: "new" });
    } else prepare(item);
  };
  const status = (item) => agentHubStatus(item, services);
  const visible = entries.filter(
    (item) =>
      (view !== "added" || item.added || item.accessJob) &&
      (category === "全部" || item.categories?.includes(category)) &&
      `${item.name} ${item.directoryName || ""} ${item.directoryId || ""} ${item.publisher} ${item.description}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const selected = entries.find((item) => item.id === detail);
  const preparing = entries.find((item) => item.id === setup);
  const addCustom = () => {
    if (
      !custom.name.trim() ||
      !custom.command.trim() ||
      /[\n\r]/.test(custom.command)
    ) {
      setCustomError("填写名称和单个程序路径或命令；参数请逐行填写。");
      return;
    }
    const id = `custom-${Date.now()}`;
    const item = {
      id,
      name: custom.name.trim(),
      publisher: "自定义接入",
      description: "由你指定的程序，通过同一套界面检查和使用。",
      categories: ["自定义"],
      command: custom.command.trim(),
      args: custom.args
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      env: {},
      source: "沿用已有设置",
      accessMode: "existing",
      sourceKind: "custom",
      added: true,
      registered: true,
      installed: true,
      available: true,
      connected: false,
      connectionState: "idle",
      installSupported: false,
      installations: [
        {
          id: `${id}-program`,
          path: custom.command.trim(),
          version: "未读取",
          managed: false,
        },
      ],
      selectedInstallationId: `${id}-program`,
      models: [],
      efforts: [],
      configOptions: [],
      authMethods: [],
      apiFormats: [],
      serviceCapabilities: { status: "unknown", formats: [] },
      capabilitiesEvidence: "自定义接入能力未知；此处只模拟连接检查",
      supportNote: "命令与参数仅保留在本页演示内存中，不执行程序。",
    };
    setAgents?.((previous) => [...previous, item]);
    setCustom(null);
    setCustomDraft(null);
    setSetup(id);
    setSetupIntent("use");
    onPreparationIntent?.("use");
    setView("added");
  };
  const scan = () => {
    setScanResult("本机发现结果已刷新（模拟）。已移除的接入不会自动重新添加。");
    setAgents?.((previous) =>
      previous.map((item) =>
        item.removed
          ? item
          : { ...item, discovered: item.discovered || !!item.installed },
      ),
    );
  };
  return (
    <section
      className={`hub-shell access-hub agent-redesign ${view === "added" ? "agent-management" : "agent-discovery"}`}
    >
      <header className="hub-heading">
        <div>
          <div className="hub-eyebrow">
            {view === "added" ? "Agent 与账号" : "探索 Agent"}
          </div>
          <h1>
            {view === "added"
              ? "管理已添加的 Agent"
              : "找到适合这项工作的 Agent"}
          </h1>
          <p>
            {view === "added"
              ? "按需管理程序、账号与服务、模型。已有对话保留各自设置。"
              : "选一个 Agent 开始工作，也可以在这里安装和管理。"}
          </p>
        </div>
        <Button
          onClick={() => {
            setCustom(customDraft || { name: "", command: "", args: "" });
            setCustomError("");
          }}
        >
          <Plus size={16} />
          {customDraft ? "继续自定义接入" : "自定义接入"}
        </Button>
      </header>
      <div className="hub-toolbar">
        <Tabs
          value={view}
          onChange={setView}
          items={[
            { id: "discover", label: "探索 Agent" },
            {
              id: "added",
              label: "我的 Agent",
              count: entries.filter((item) => item.added).length,
            },
          ]}
        />
        <label className="hub-search">
          <MagnifyingGlass size={17} />
          <input
            aria-label="搜索 Agent"
            placeholder="搜索名称、提供方或用途"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              aria-label="清除搜索"
              onClick={() => setQuery("")}
            >
              <X size={14} />
            </button>
          )}
        </label>
        <Button onClick={scan}>重新发现</Button>
      </div>
      <div className="hub-filters">
        <div>
          {AGENT_CATEGORIES.map((item) => (
            <button
              type="button"
              key={item}
              className={category === item ? "active" : ""}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <small>安装、认证与请求均为模拟</small>
      </div>
      {scanResult && (
        <p role="status" className="access-muted">
          {scanResult}
        </p>
      )}
      {visible.length ? (
        <div className="hub-grid">
          {visible.map((item) => (
            <article key={item.id} className="hub-card">
              <div className="hub-card-top">
                <button
                  className="hub-card-brand"
                  onClick={() => setDetail(item.id)}
                  aria-label={`查看 ${item.name} 说明`}
                >
                  <HubIcon agent={item} size={35} />
                  <span>
                    <strong>{item.directoryName || item.name}</strong>
                    <small>{item.directoryId || item.publisher}</small>
                  </span>
                </button>
                <Badge>
                  {item.sourceKind === "custom" ? "自定义" : "目录条目"}
                </Badge>
              </div>
              <button
                className="hub-card-description"
                onClick={() => setDetail(item.id)}
              >
                {item.description}
              </button>
              <div className="hub-card-tags">
                {item.categories?.map((value) => (
                  <span key={value}>{value}</span>
                ))}
              </div>
              <div className="hub-card-status">
                <span className={status(item).ready ? "ready" : ""}>
                  {status(item).ready ? (
                    <CheckCircle size={13} />
                  ) : (
                    <span className="hub-status-dot" />
                  )}
                  {status(item).label}
                </span>
                <small>演示状态</small>
              </div>
              <div className="hub-card-actions">
                <Button
                  primary={
                    view !== "added" &&
                    agentCanStartConversation(item) &&
                    !hasPendingOnboarding(item)
                  }
                  onClick={() => use(item)}
                >
                  {hasPendingOnboarding(item) ||
                  (item.added && agentNeedsInitialPreparation(item))
                    ? "继续准备"
                    : agentCanStartConversation(item)
                      ? "开始新对话"
                      : item.accessJob
                        ? "查看进度"
                        : "准备使用"}
                  <ArrowRight size={14} />
                </Button>
                <Button
                  primary={view === "added"}
                  aria-label={`管理 ${item.name}`}
                  onClick={() => prepare(item, "manage")}
                >
                  <SlidersHorizontal size={17} />
                  管理设置
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          icon={MagnifyingGlass}
          title="没有符合条件的 Agent"
          action={
            <Button
              onClick={() => {
                setQuery("");
                setCategory("全部");
                setView("discover");
              }}
            >
              查看全部 Agent
            </Button>
          }
        >
          换一个筛选条件，或添加自定义接入。
        </Empty>
      )}
      <footer className="hub-footer">
        <span>找不到想用的 Agent？可以添加自定义接入。</span>
        <small>能力样例不代表真实接通或安装验收</small>
      </footer>
      {selected && (
        <Modal
          wide
          className="agent-redesign-modal"
          title={`${selected.name} · 接入说明`}
          onClose={() => setDetail(null)}
          footer={
            <>
              <Button onClick={() => setDetail(null)}>返回目录</Button>
              <Button primary onClick={() => prepare(selected)}>
                准备使用
              </Button>
            </>
          }
        >
          <div className="access-detail">
            <div className="access-identity">
              <HubIcon agent={selected} size={42} />
              <div>
                <strong>{selected.directoryName || selected.name}</strong>
                <p>{selected.directoryId || selected.publisher}</p>
              </div>
              <Badge>{status(selected).label}</Badge>
            </div>
            <p>{selected.description}</p>
            <AgentCapabilities agent={selected} />
            {selected.added && (
              <AgentIdentity
                agent={selected}
                source={
                  selected.accessMode === "api"
                    ? services.find(
                        (service) => service.id === selected.serviceId,
                      )?.name
                    : undefined
                }
                model={selected.model}
              />
            )}
            {selected.sourceUrl && (
              <a href={selected.sourceUrl} target="_blank" rel="noreferrer">
                {selected.sourceLabel}
                <ArrowSquareOut size={14} />
              </a>
            )}
          </div>
        </Modal>
      )}
      {preparing && (
        <AgentSetup
          key={`${preparing.id}:${initialRequest ?? "browse"}`}
          agent={preparing}
          services={services}
          setServices={setServices}
          initialSelection={initialSelection}
          initialContext={{
            ...initialContext,
            ...(initialAgent !== preparing.name && initialAgent !== preparing.id
              ? { repair: undefined, panel: undefined, reason: undefined }
              : {}),
            intent: setupIntent,
          }}
          allAgents={entries}
          onOpenTest={onOpenTest}
          busyCount={busyAgentTasks(preparing, tasks).length}
          blockingTasks={busyAgentTasks(preparing, tasks)}
          onOpenBlockingTask={(id) => {
            onOpenBlockingTask?.(id, preparing);
            setSetup(null);
          }}
          onImportExisting={onImportExisting}
          onManageServices={onManageServices}
          returnLabel={returnLabel}
          onChange={(changes) => mutate(preparing, changes)}
          onClose={(destination) => {
            setSetup(null);
            if (destination === "return") onReturnToTask?.();
          }}
          onUse={(name, item, completion) => {
            setSetup(null);
            setDetail(null);
            onUse?.(name, item, {
              intent: completion?.intent || setupIntent || "complete",
            });
          }}
          toast={toast}
        />
      )}
      {custom && !customExit && (
        <Modal
          className="agent-redesign-modal agent-custom-modal"
          title="自定义 Agent 接入"
          onClose={closeCustom}
          footer={
            <>
              <Button onClick={closeCustom}>取消</Button>
              <Button
                primary
                disabled={!custom.name.trim() || !custom.command.trim()}
                onClick={addCustom}
              >
                添加并检查
              </Button>
            </>
          }
        >
          <div className="access-setup">
            <p>
              指定你选择的程序和参数。添加不代表连接成功，能力由之后的检查结果决定。
            </p>
            <label className="access-field">
              <span>显示名称</span>
              <input
                value={custom.name}
                onChange={(event) =>
                  setCustom({ ...custom, name: event.target.value })
                }
              />
            </label>
            <label className="access-field">
              <span>程序路径或命令</span>
              <input
                value={custom.command}
                onChange={(event) =>
                  setCustom({ ...custom, command: event.target.value })
                }
                placeholder="/path/to/agent"
              />
            </label>
            <label className="access-field">
              <span>参数（每行一个）</span>
              <textarea
                rows={3}
                value={custom.args}
                onChange={(event) =>
                  setCustom({ ...custom, args: event.target.value })
                }
              />
            </label>
            {customError && (
              <p role="alert" className="access-error">
                {customError}
              </p>
            )}
            <p className="access-muted">
              这里只记录模拟配置，不会运行命令或读取任何秘密。
            </p>
          </div>
        </Modal>
      )}
      {customExit && (
        <Modal
          className="agent-redesign-modal"
          title="保留自定义接入草稿？"
          onClose={() => setCustomExit(false)}
          footer={
            <>
              <Button onClick={() => setCustomExit(false)}>继续填写</Button>
              <Button
                onClick={() => {
                  setCustom(null);
                  setCustomDraft(null);
                  setCustomExit(false);
                }}
              >
                放弃草稿
              </Button>
              <Button
                primary
                onClick={() => {
                  setCustomDraft(custom);
                  setCustom(null);
                  setCustomExit(false);
                }}
              >
                保留并返回
              </Button>
            </>
          }
        >
          <p>
            已填写的名称、程序与参数尚未添加。保留后可从“继续自定义接入”恢复；不会运行命令。
          </p>
        </Modal>
      )}
    </section>
  );
}
