import React, { useEffect, useState } from "react";
import { Modal, Button, AgentIcon } from "./ui";
import { metadataSearch } from "./settings-library-state.js";
import { hasUnsentContent } from "./history-policy.js";
import "./settings-redesign.css";

export default function LibraryDialogs({
  modal,
  setModal,
  search,
  setSearch,
  tasks,
  open,
  name,
  setName,
  groups,
  setGroups,
  renameId,
  patch,
  toast,
  moveIds = [],
}) {
  const selectedTasks = tasks.filter((t) => moveIds.includes(t.id));
  const currentGroups = [...new Set(selectedTasks.map((t) => t.group || ""))];
  const [destination, setDestination] = useState("");
  useEffect(() => {
    if (modal === "move")
      setDestination(currentGroups.length === 1 ? currentGroups[0] : "");
  }, [modal, moveIds.join("|")]);
  const results = metadataSearch(tasks, search);
  const unchanged =
    selectedTasks.length > 0 &&
    selectedTasks.every((t) => (t.group || "") === destination);
  return (
    <div className="library-dialogs-redesign">
      {modal === "search" && (
        <Modal title="找回一段对话" onClose={() => setModal(null)}>
          <input
            autoFocus
            className="v2-picker-search"
            aria-label="搜索所有对话"
            placeholder="搜索标题、Agent、分组或工作位置"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <p className="sl-search-scope">
            包含已归档对话 · 搜索目录信息，不搜索正文
          </p>
          <div className="v2-search-results">
            {results.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setModal(null);
                  open(t);
                }}
              >
                <AgentIcon name={t.agent} size={19} />
                <span>
                  <strong>{t.title}</strong>
                  <small>
                    {t.agent} · {t.group || "未分组"}
                    {t.archived ? " · 已归档" : ""}
                    {hasUnsentContent(t) ? " · 有未发内容" : ""}
                    {t.queue?.length ? ` · ${t.queue.length} 条待发` : ""}
                  </small>
                  <small>
                    {t.folder || "未指定工作位置"} · {t.time || "时间未知"}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {!results.length && (
            <div className="sl-empty">
              <strong>没有匹配的对话</strong>
              <p>试试标题中的词、Agent 名称或工作位置。</p>
              <Button onClick={() => setSearch("")}>清除搜索</Button>
            </div>
          )}
        </Modal>
      )}
      {(modal === "group" || modal === "rename") && (
        <Modal
          title={modal === "group" ? "创建分组" : "重命名对话"}
          onClose={() => setModal(null)}
          footer={
            <>
              <Button onClick={() => setModal(null)}>取消</Button>
              <Button
                primary
                disabled={!name.trim()}
                onClick={() => {
                  if (modal === "group") {
                    if (groups.includes(name.trim())) {
                      toast("已经有同名分组了。");
                      return;
                    }
                    setGroups((g) => [...g, name.trim()]);
                  } else patch(renameId, { title: name.trim() });
                  setModal(null);
                }}
              >
                保存
              </Button>
            </>
          }
        >
          <label className="field">
            <span>名称</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          {modal === "group" && (
            <p className="v2-help">分组只整理对话，不改变工作位置或 Agent。</p>
          )}
        </Modal>
      )}
      {modal === "move" && (
        <Modal
          title={`移动 ${selectedTasks.length} 段对话`}
          onClose={() => setModal(null)}
          footer={
            <>
              <Button onClick={() => setModal(null)}>取消</Button>
              <Button
                primary
                disabled={!selectedTasks.length || unchanged}
                onClick={() => {
                  moveIds.forEach((id) => patch(id, { group: destination }));
                  setModal(null);
                  toast(
                    destination ? `已移到「${destination}」` : "已移出分组",
                  );
                }}
              >
                确认移动
              </Button>
            </>
          }
        >
          <ul className="sl-scope-list">
            {selectedTasks.map((t) => (
              <li key={t.id}>
                <strong>{t.title}</strong>
                <span>当前分组：{t.group || "未分组"}</span>
              </li>
            ))}
          </ul>
          <fieldset className="sl-move-options">
            <legend>移到哪个分组？</legend>
            {["", ...groups].map((g) => (
              <label key={g}>
                <input
                  type="radio"
                  name="move-destination"
                  value={g}
                  checked={destination === g}
                  onChange={() => setDestination(g)}
                />
                <span>{g || "未分组"}</span>
                {currentGroups.length === 1 && currentGroups[0] === g && (
                  <small>当前分组</small>
                )}
              </label>
            ))}
          </fieldset>
          <p className="sl-search-scope">
            只改变列表中的分组。原 Agent、工作位置、正文与未发内容都保留。
          </p>
        </Modal>
      )}
    </div>
  );
}
