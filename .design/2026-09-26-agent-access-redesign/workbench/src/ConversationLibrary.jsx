import React, { useEffect, useState } from "react";
import {
  MagnifyingGlass,
  Star,
  DotsThree,
  Plus,
  X,
} from "@phosphor-icons/react";
import { Button, AgentIcon, Empty } from "./ui";
import { statusLabel } from "./data-v2";
import { archiveEligibility, filterConversations } from "./history-policy.js";
import { conversationState } from "./conversation-policy.js";
import "./history-settings.css";
export default function ConversationLibrary({
  tasks,
  groups,
  filters,
  setFilters,
  onOpen,
  onPatch,
  onMove,
  onRename,
  onNew,
  onImport,
  starred = false,
  compact = false,
}) {
  const [manage, setManage] = useState(false),
    [selected, setSelected] = useState([]),
    [menu, setMenu] = useState(null);
  const query = filters.query || "";
  useEffect(() => {
    setSelected([]);
    setMenu(null);
  }, [filters.agent, filters.group, filters.state, query, starred]);
  const shown = filterConversations(tasks, { ...filters, starred });
  const safeArchive = (task) =>
    task.archived || archiveEligibility(task).allowed;
  const selectedTasks = tasks.filter((task) => selected.includes(task.id));
  const blocked =
    filters.state === "archived"
      ? []
      : selectedTasks.filter((task) => !archiveEligibility(task).allowed);
  const title =
    [starred ? "收藏" : "", filters.agent, filters.group]
      .filter(Boolean)
      .join(" · ") || "所有对话";
  const clearFilters = () =>
    setFilters((previous) => ({
      ...previous,
      agent: "",
      group: "",
      query: "",
      state: "all",
    }));
  const toggle = (id) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s, id],
    );
  return (
    <div className={"v2-library " + (compact ? "compact" : "")}>
      {!compact && (
        <>
          <div className="v2-page-title">
            <div>
              <h1>{title}</h1>
              <p>
                {shown.length} 段对话
                {filters.group ? " · 分组只帮助整理，不改变文件访问范围。" : ""}
              </p>
            </div>
            <div className="v2-library-actions">
              {onImport && <Button onClick={onImport}>带入已有对话</Button>}
              <Button onClick={onNew}>
                <Plus size={15} />
                新对话
              </Button>
            </div>
          </div>
          <div className="v2-library-tools">
            <div className="v2-field-search">
              <MagnifyingGlass size={16} />
              <input
                aria-label="筛选对话"
                placeholder="搜索标题、Agent、分组或位置"
                value={query}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, query: e.target.value }))
                }
              />
            </div>
            <select
              aria-label="按 Agent 筛选"
              value={filters.agent || ""}
              onChange={(e) =>
                setFilters((f) => ({ ...f, agent: e.target.value }))
              }
            >
              <option value="">所有 Agent</option>
              {[...new Set(tasks.map((t) => t.agent))].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
            <select
              aria-label="按分组筛选"
              value={filters.group || ""}
              onChange={(e) =>
                setFilters((f) => ({ ...f, group: e.target.value }))
              }
            >
              <option value="">所有分组</option>
              {groups.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
            <Button
              kind="ghost"
              onClick={() => {
                setManage(!manage);
                setSelected([]);
              }}
            >
              {manage ? "完成整理" : "整理"}
            </Button>
          </div>
          {(filters.agent || filters.group || query) && (
            <div className="history-active-filters" aria-label="当前筛选">
              <span>当前范围</span>
              {[
                ["agent", filters.agent],
                ["group", filters.group],
                ["query", query && `搜索：${query}`],
              ]
                .filter(([, value]) => value)
                .map(([key, value]) => (
                  <button
                    key={key}
                    onClick={() => setFilters((f) => ({ ...f, [key]: "" }))}
                    aria-label={`清除${key === "agent" ? " Agent" : key === "group" ? "分组" : "搜索"}筛选`}
                  >
                    {value}
                    <X size={12} />
                  </button>
                ))}
              <Button kind="ghost" onClick={clearFilters}>
                清除筛选
              </Button>
            </div>
          )}
          <div className="v2-library-tabs" role="tablist">
            {[
              ["all", "全部"],
              ["needs", "等你回应"],
              ["running", "进行中"],
              ["unread", "新回复"],
              ["archived", "已归档"],
            ].map(([id, label]) => (
              <button
                role="tab"
                aria-selected={filters.state === id}
                className={filters.state === id ? "selected" : ""}
                key={id}
                onClick={() => {
                  setFilters((f) => ({ ...f, state: id }));
                  setSelected([]);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      {manage && (
        <div className="v2-bulk">
          <label>
            <input
              type="checkbox"
              aria-label="选择当前列表"
              checked={
                shown.length > 0 && shown.every((t) => selected.includes(t.id))
              }
              onChange={(e) =>
                setSelected(e.target.checked ? shown.map((t) => t.id) : [])
              }
            />
            已选 {selected.length} 项
          </label>
          <Button disabled={!selected.length} onClick={() => onMove(selected)}>
            移到分组
          </Button>
          <Button
            disabled={!selected.length || blocked.length > 0}
            onClick={() => {
              selected.forEach((id) =>
                onPatch(id, { archived: filters.state !== "archived" }),
              );
              setSelected([]);
            }}
          >
            {filters.state === "archived" ? "移回对话" : "归档"}
          </Button>
          <small role="status">
            {blocked.length
              ? `已选项中有 ${blocked.length} 段还有工作或待发内容，暂不能归档。`
              : "归档只整理列表，可随时移回。"}
          </small>
        </div>
      )}
      <div className="v2-chat-list">
        {(compact ? shown.slice(0, 4) : shown).map((t) => (
          <div key={t.id} className="v2-chat-row">
            {manage && (
              <input
                type="checkbox"
                aria-label={"选择 " + t.title}
                checked={selected.includes(t.id)}
                onChange={() => toggle(t.id)}
              />
            )}
            <AgentIcon name={t.agent} size={21} />
            <button className="v2-chat-open" onClick={() => onOpen(t)}>
              <strong>{t.title}</strong>
              <span>
                {t.agent}
                {t.group ? " · " + t.group : ""}
                {t.draft ? " · 有草稿" : ""}
                {t.archived && t.archiveSource === "automatic"
                  ? " · 自动归档"
                  : ""}
              </span>
            </button>
            <span
              className={"v2-state " + t.status + (t.unread ? " unread" : "")}
            >
              {conversationState(t).attention
                ? "需要你"
                : t.imported && !t.extraMessages?.length
                  ? t.readOnly
                    ? "仅可查看"
                    : "已带入"
                  : conversationState(t).running
                    ? "在跑"
                    : statusLabel(t)}
            </span>
            <small className="v2-row-time">{t.time}</small>
            {!compact && (
              <>
                <button
                  className={"v2-row-star " + (t.pinned ? "saved" : "")}
                  aria-label={(t.pinned ? "取消收藏 " : "收藏 ") + t.title}
                  onClick={() => onPatch(t.id, { pinned: !t.pinned })}
                >
                  <Star size={16} weight={t.pinned ? "fill" : "regular"} />
                </button>
                <div className="v2-row-menu">
                  <Button
                    kind="icon"
                    aria-label={"整理 " + t.title}
                    onClick={() => setMenu(menu === t.id ? null : t.id)}
                  >
                    <DotsThree size={19} />
                  </Button>
                  {menu === t.id && (
                    <>
                      <button
                        className="v2-menu-scrim"
                        aria-label="关闭对话菜单"
                        onClick={() => setMenu(null)}
                      />
                      <div className="v2-context-menu">
                        <button
                          onClick={() => {
                            setMenu(null);
                            onRename(t);
                          }}
                        >
                          重命名
                        </button>
                        <button
                          onClick={() => {
                            setMenu(null);
                            onMove([t.id]);
                          }}
                        >
                          移到分组
                        </button>
                        <button
                          disabled={!safeArchive(t)}
                          title={
                            !safeArchive(t)
                              ? archiveEligibility(t).reason
                              : undefined
                          }
                          onClick={() => {
                            onPatch(t.id, { archived: !t.archived });
                            setMenu(null);
                          }}
                        >
                          {t.archived ? "移回对话" : "归档"}
                        </button>
                        {!safeArchive(t) && (
                          <p className="history-menu-reason">
                            {archiveEligibility(t).reason}
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      {!shown.length && (
        <Empty
          icon={MagnifyingGlass}
          title={compact ? "你的对话会留在这里" : "这里还没有对话"}
        >
          {compact ? (
            "从一个问题或一点灵感开始。"
          ) : (
            <>
              {filters.state === "archived"
                ? "归档会保留对话；移回后仍是原来的对话。"
                : "换个筛选条件，或开始聊点新的。"}
              {(filters.agent ||
                filters.group ||
                query ||
                filters.state !== "all") && (
                <Button onClick={clearFilters}>清除筛选</Button>
              )}
            </>
          )}
        </Empty>
      )}
    </div>
  );
}
