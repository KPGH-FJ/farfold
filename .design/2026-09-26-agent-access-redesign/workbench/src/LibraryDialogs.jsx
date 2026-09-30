import React from "react";
import { Modal, Button, AgentIcon } from "./ui";
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
  moveIds,
}) {
  return (
    <>
      {modal === "search" && (
        <Modal title="找回一段对话" onClose={() => setModal(null)}>
          <input
            autoFocus
            className="v2-picker-search"
            aria-label="搜索所有对话"
            placeholder="标题、Agent 或分组"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="v2-search-results">
            {tasks
              .filter((t) =>
                [t.title, t.agent, t.group]
                  .join(" ")
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((t) => (
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
                    </small>
                  </span>
                </button>
              ))}
          </div>
          <p className="v2-help">包含已归档对话，搜索标题、Agent 和分组。</p>
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
            <p className="v2-help">
              把相关对话放在一起。分组不关联电脑文件夹，也不限制使用哪个 Agent。
            </p>
          )}
        </Modal>
      )}
      {modal === "move" && (
        <Modal
          title={"整理 " + moveIds.length + " 段对话"}
          onClose={() => setModal(null)}
        >
          <div className="v2-action-list">
            {["", ...groups].map((g) => (
              <button
                key={g}
                onClick={() => {
                  moveIds.forEach((id) => patch(id, { group: g }));
                  setModal(null);
                  toast(g ? "已移到「" + g + "」" : "已移出分组");
                }}
              >
                {g || "不放入分组"}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
