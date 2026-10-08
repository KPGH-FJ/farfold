import React, { useEffect, useState } from "react";
import {
  MagnifyingGlass,
  Star,
  DotsThree,
  Plus,
  X,
} from "@phosphor-icons/react";
import { Button, AgentIcon, Empty, Modal, Badge } from "./ui";
import { statusLabel } from "./data-v2";
import { archiveEligibility, hasUnsentContent } from "./history-policy.js";
import {
  libraryProtection,
  libraryResults,
  deletionScope,
} from "./settings-library-state.js";
import "./settings-redesign.css";
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
  onDelete,
  starred = false,
  compact = false,
}) {
  const [manage, setManage] = useState(false),
    [selected, setSelected] = useState([]),
    [menu, setMenu] = useState(null);
  const [deleteIds, setDeleteIds] = useState(null);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [deleteResult, setDeleteResult] = useState("");
  const scope = deletionScope(tasks, deleteIds || []);
  const askDelete = (ids) => {
    setDeleteIds(ids);
    setDeleteConfirmed(false);
  };
  const query = filters.query || "";
  useEffect(() => {
    setSelected([]);
    setMenu(null);
  }, [filters.agent, filters.group, filters.state, query, starred]);
  const shown = libraryResults(tasks, { ...filters, starred });
  const safeArchive = (task) => task.archived || !libraryProtection(task);
  const selectedTasks = tasks.filter((task) => selected.includes(task.id));
  const blocked =
    filters.state === "archived"
      ? []
      : selectedTasks.filter((task) => !!libraryProtection(task));
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
    <div
      className={"v2-library library-redesign " + (compact ? "compact" : "")}
    >
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
          <p className="sl-search-scope">
            搜索标题、Agent、分组与工作位置 · 不搜索对话正文
          </p>
          <div className="v2-library-tabs" role="tablist" aria-label="对话状态">
            {[
              ["all", "活动对话"],
              ["drafts", "有未发内容"],
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
                {label}{" "}
                <span className="sl-tab-count">
                  {
                    libraryResults(tasks, { ...filters, state: id, starred })
                      .length
                  }
                </span>
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
          <Button
            disabled={!selected.length || !onDelete}
            className="set-danger-text"
            onClick={() => askDelete(selected)}
          >
            删除所选
          </Button>
          <small role="status">
            {blocked.length
              ? `已选项中有 ${blocked.length} 段还有工作或待发内容，暂不能归档。`
              : "归档只整理列表，可随时移回。"}
          </small>
        </div>
      )}
      {deleteResult && (
        <p role="status" className="sl-result">
          {deleteResult}
        </p>
      )}
      {!compact && filters.state === "archived" && shown.length > 0 && (
        <div className="sl-archive-summary">
          <span>已归档仍可打开和恢复，删除需另行确认。</span>
          <Button
            className="set-danger-text"
            disabled={!onDelete}
            onClick={() => askDelete(shown.map((t) => t.id))}
          >
            清空当前已归档范围
          </Button>
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
                {hasUnsentContent(t) ? " · 有未发内容" : ""}
                {t.queue?.length ? ` · ${t.queue.length} 条待发` : ""}
                {t.archived && t.archiveSource === "automatic"
                  ? " · 自动归档"
                  : ""}
              </span>
              <span className="sl-row-location">
                {t.folder || "未指定工作位置"}
                {t.archived ? " · 已归档" : ""}
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
                    ? "进行中"
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
                            !safeArchive(t) ? libraryProtection(t) : undefined
                          }
                          onClick={() => {
                            onPatch(t.id, { archived: !t.archived });
                            setMenu(null);
                          }}
                        >
                          {t.archived ? "移回对话" : "归档"}
                        </button>
                        <button
                          className="set-danger-text"
                          disabled={!onDelete || !!libraryProtection(t)}
                          onClick={() => {
                            setMenu(null);
                            askDelete([t.id]);
                          }}
                        >
                          删除对话…
                        </button>
                        {!safeArchive(t) && (
                          <p className="history-menu-reason">
                            {libraryProtection(t)}
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
          title={
            compact
              ? "你的对话会留在这里"
              : starred && !tasks.some((t) => t.pinned)
                ? "把常用对话收藏在这里"
                : query || filters.agent || filters.group
                  ? "没有匹配的对话"
                  : filters.state === "drafts"
                    ? "没有未发内容"
                    : "这里还没有对话"
          }
        >
          {compact ? (
            "从一个问题或一点灵感开始。"
          ) : (
            <>
              {starred && !tasks.some((t) => t.pinned)
                ? "在任意对话右侧点击星标，即可加入收藏；收藏不会改变工作位置。"
                : filters.state === "archived"
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
      {deleteIds && (
        <Modal
          title={`删除 ${scope.selected.length} 段对话？`}
          onClose={() => setDeleteIds(null)}
          footer={
            <>
              <Button onClick={() => setDeleteIds(null)}>取消</Button>
              <Button
                className="set-danger"
                disabled={
                  !deleteConfirmed ||
                  scope.protected.length > 0 ||
                  !scope.allowed.length ||
                  !onDelete
                }
                onClick={() => {
                  const ids = scope.allowed.map((t) => t.id);
                  onDelete(ids);
                  setDeleteIds(null);
                  setSelected([]);
                  setDeleteResult(
                    `已移除 ${ids.length} 段演示对话。Agent 自己的历史和项目文件没有改变。`,
                  );
                }}
              >
                删除所选演示对话
              </Button>
            </>
          }
        >
          <p className="sl-dialog-lead">
            请核对本次范围。这项操作不会归档，删除后不能从列表恢复。
          </p>
          <ul className="sl-scope-list">
            {scope.selected.map((t) => (
              <li key={t.id}>
                <strong>{t.title}</strong>
                <span>
                  {t.agent} · {t.group || "未分组"} · {t.folder || "未指定位置"}
                </span>
                {libraryProtection(t) && (
                  <p className="sl-protected">{libraryProtection(t)}</p>
                )}
              </li>
            ))}
          </ul>
          <div className="sl-scope-grid">
            <section>
              <h3>移除</h3>
              <p>所选对话在 Farfold 中的目录、收藏、分组与界面记录。</p>
            </section>
            <section>
              <h3>保留</h3>
              <p>
                项目文件、Agent 账号与程序。这个示例不提供 Agent
                侧历史删除，原历史仍保留。
              </p>
            </section>
          </div>
          {scope.protected.length > 0 ? (
            <p role="alert" className="sl-protected">
              有 {scope.protected.length}{" "}
              段受保护对话，请回到对话处理未完成工作或未发内容；本次不会部分删除。
            </p>
          ) : (
            <label className="sl-confirm-check">
              <input
                type="checkbox"
                checked={deleteConfirmed}
                onChange={(e) => setDeleteConfirmed(e.target.checked)}
              />
              我已核对所选范围，理解 Agent 侧历史仍保留
            </label>
          )}
        </Modal>
      )}
    </div>
  );
}
