import React, { useState } from "react";
import {
  Plus,
  MagnifyingGlass,
  ChatsCircle,
  Star,
  Compass,
  Gear,
  FolderSimple,
  CaretDown,
  CaretRight,
  SidebarSimple,
} from "@phosphor-icons/react";
import { AgentIcon, Button } from "./ui";
import { visibleInActive } from "./history-policy.js";
export default function SidebarV2({
  view,
  tasks,
  agents,
  groups,
  filters,
  go,
  onNew,
  onSearch,
  onAddGroup,
  onAgent,
  onGroup,
  onSettings,
  onCollapse,
  needsCount = 0,
  runningCount = 0,
  hasDraft = false,
  onStatus,
}) {
  const [agentsOpen, setAgentsOpen] = useState(true),
    [groupsOpen, setGroupsOpen] = useState(true);
  const count = (fn) => tasks.filter((t) => visibleInActive(t) && fn(t)).length;
  const nav = (id, label, Icon, n, action) => (
    <button
      className={
        "v2-nav " +
        (view === id &&
        (id !== "conversations" || (!filters.agent && !filters.group))
          ? "selected"
          : "")
      }
      onClick={action || (() => go(id))}
    >
      <Icon size={18} />
      <span>{label}</span>
      {n > 0 && <small>{n}</small>}
    </button>
  );
  return (
    <aside className="v2-sidebar" aria-label="主导航">
      <div className="v2-brand">
        <div>
          <img className="v2-mark" src="/assets/brand/mark.svg" alt="" />
          <img
            className="v2-wordmark"
            src="/assets/brand/wordmark.svg"
            alt="Farfold"
          />
        </div>
        <Button kind="icon" aria-label="收起侧栏" onClick={onCollapse}>
          <SidebarSimple size={17} />
        </Button>
      </div>
      <button
        className={"v2-new " + (view === "new" ? "selected" : "")}
        aria-current={view === "new" ? "page" : undefined}
        onClick={onNew}
      >
        <Plus size={18} />
        <span>新对话</span>
        {hasDraft && <small className="v4-draft-tag">草稿</small>}
        <kbd>⌘ N</kbd>
      </button>
      <button className="v2-search-trigger" onClick={onSearch}>
        <MagnifyingGlass size={16} />
        <span>搜索对话</span>
        <kbd>⌘ K</kbd>
      </button>
      <nav>
        {nav(
          "conversations",
          "所有对话",
          ChatsCircle,
          count(() => true),
          () => go("conversations"),
        )}
        {nav(
          "starred",
          "收藏",
          Star,
          count((t) => t.pinned),
        )}
        {nav("agents", "探索 Agent", Compass)}
      </nav>
      <div className="v2-sidebar-scroll">
        <div className="v2-section-label">
          <button onClick={() => setAgentsOpen(!agentsOpen)}>
            {agentsOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
            我的 Agent
          </button>
          <button aria-label="添加 Agent" onClick={() => go("agents")}>
            <Plus size={14} />
          </button>
        </div>
        {agentsOpen &&
          agents
            .filter(
              (a) => a.added || a.connected || a.demoReady || a.setupComplete,
            )
            .map((a) => (
              <button
                key={a.id}
                className={
                  "v2-nav v2-sub " +
                  (["conversations", "starred"].includes(view) &&
                  filters.agent === a.name
                    ? "selected"
                    : "")
                }
                onClick={() => onAgent(a.name)}
              >
                <AgentIcon name={a.name} size={18} />
                <span>{a.name}</span>
                <small>{count((t) => t.agent === a.name) || ""}</small>
              </button>
            ))}
        <div className="v2-section-label">
          <button onClick={() => setGroupsOpen(!groupsOpen)}>
            {groupsOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
            分组
          </button>
          <button aria-label="创建分组" onClick={onAddGroup}>
            <Plus size={14} />
          </button>
        </div>
        {groupsOpen &&
          groups.map((g) => (
            <button
              key={g}
              className={
                "v2-nav v2-sub " +
                (["conversations", "starred"].includes(view) &&
                filters.group === g
                  ? "selected"
                  : "")
              }
              onClick={() => onGroup(g)}
            >
              <FolderSimple size={17} />
              <span>{g}</span>
              <small>{count((t) => t.group === g) || ""}</small>
            </button>
          ))}
      </div>
      <div className="v2-sidebar-foot">
        {(needsCount > 0 || runningCount > 0) && (
          <div className="v4-sidebar-activity" aria-label="对话动态">
            {needsCount > 0 && (
              <button onClick={() => onStatus?.("needs")}>
                <i className="attention" />
                {needsCount} 等你回应
              </button>
            )}
            {runningCount > 0 && (
              <button onClick={() => onStatus?.("running")}>
                <i />
                {runningCount} 进行中
              </button>
            )}
          </div>
        )}
        <button className="v2-nav" onClick={onSettings}>
          <Gear size={18} />
          <span>设置</span>
        </button>
        <small>属于你的 Agent，在一处相遇。</small>
      </div>
    </aside>
  );
}
