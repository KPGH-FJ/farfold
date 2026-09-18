/**
 * 侧栏：新对话 / 需要处理 / 已归档 / 搜索 / 最近（按项目分组的会话流）
 * + ⋯菜单（重命名/置顶/归档/删除）。
 */
import { useMemo, useState } from "react";
import type { AgentCardModel } from "../runtime/agents";
import { agentIdentity } from "../runtime/agents";
import {
  basename,
  groupSidebarRows,
  relativeTime,
  threads,
  type SidebarRow,
  useThreadsSnapshot,
} from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";

type SidebarMode = "recent" | "attention" | "archived";

function RowMenu({
  row,
  onRename,
  onClose,
}: {
  row: SidebarRow;
  onRename: () => void;
  onClose: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="ctx-menu" onClick={(e) => e.stopPropagation()}>
      <div
        className="pm"
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        {STRINGS.sessions.rename}
      </div>
      <div
        className="pm"
        onClick={() => {
          onClose();
          void threads.setPinned(row.key, !row.pinned);
        }}
      >
        {row.pinned ? STRINGS.sessions.unpin : STRINGS.sessions.pin}
      </div>
      <div
        className="pm"
        onClick={() => {
          onClose();
          void threads.setArchived(row.key, !row.archived);
        }}
      >
        {row.archived ? STRINGS.sessions.unarchive : STRINGS.sessions.archive}
      </div>
      <div
        className="pm danger"
        onClick={() => {
          if (!confirmDelete) {
            setConfirmDelete(true);
            return;
          }
          onClose();
          void threads.delete(row.key);
        }}
      >
        {confirmDelete
          ? STRINGS.sessions.deleteConfirm
          : STRINGS.sessions.delete}
      </div>
    </div>
  );
}

function SessionRow({
  row,
  agentName,
  letter,
  tone,
  active,
  renaming,
  onSelect,
  onRenameStart,
  onRenameDone,
}: {
  row: SidebarRow;
  agentName: string;
  letter: string;
  tone: string;
  active: boolean;
  renaming: boolean;
  onSelect: () => void;
  onRenameStart: () => void;
  onRenameDone: (title: string | null) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState(row.title);
  return (
    <div className={`sess${active ? " active" : ""}`} onClick={onSelect}>
      <span className={`id ${tone}`}>{letter}</span>
      <div className="s-body">
        {renaming ? (
          <input
            className="rename-input"
            autoFocus
            value={draft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameDone(draft.trim() || null);
              if (e.key === "Escape") onRenameDone(null);
            }}
            onBlur={() => onRenameDone(draft.trim() || null)}
          />
        ) : (
          <>
            <div className="t">{row.title}</div>
            <div className="s-meta">
              {agentName} · {relativeTime(row.updatedAt)}
            </div>
          </>
        )}
      </div>
      {row.status === "need" && (
        <span className="st need">{STRINGS.sessions.needYou} ⚠</span>
      )}
      {row.status === "run" && (
        <span className="st run">{STRINGS.sessions.running} ●</span>
      )}
      <button
        type="button"
        className="dots"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
      >
        ⋯
      </button>
      {menuOpen && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 60 }}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(false);
            }}
          />
          <RowMenu
            row={row}
            onClose={() => setMenuOpen(false)}
            onRename={onRenameStart}
          />
        </>
      )}
    </div>
  );
}

export function Sidebar({
  agents,
  activeKey,
  onNew,
  onSelect,
  onSearch,
  onSettings,
}: {
  agents: AgentCardModel[];
  activeKey: string | null;
  onNew: () => void;
  onSelect: (row: SidebarRow) => void;
  onSearch: () => void;
  onSettings: () => void;
}) {
  const snapshot = useThreadsSnapshot();
  const [mode, setMode] = useState<SidebarMode>("recent");
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const agentById = useMemo(() => {
    const map = new Map<string, AgentCardModel>();
    for (const card of agents) map.set(card.id, card);
    return map;
  }, [agents]);

  const groups = useMemo(
    () =>
      groupSidebarRows(snapshot.index, snapshot.threads, {
        archived: mode === "archived",
        attentionOnly: mode === "attention",
      }),
    [snapshot, mode],
  );
  const visibleGroups = projectFilter
    ? groups.filter((g) => g.cwd === projectFilter)
    : groups;

  const needCount = useMemo(
    () =>
      [...snapshot.threads.values()].filter((t) => threads.needsAttention(t))
        .length,
    [snapshot],
  );
  const archivedCount = snapshot.index.filter((r) => r.archived).length;

  return (
    <aside className="sidebar">
      <div className="brand">Farfold</div>
      <div className="nav-row" onClick={onNew}>
        <span>{STRINGS.sidebar.newChat}</span>
        <span className="kbd-hint">⌘N</span>
      </div>
      <div
        className={`nav-row${mode === "attention" ? " active" : ""}`}
        onClick={() =>
          setMode((m) => (m === "attention" ? "recent" : "attention"))
        }
      >
        <span>{STRINGS.sidebar.attention}</span>
        <span className={`nav-count${needCount ? " warn" : ""}`}>
          {needCount}
        </span>
      </div>
      <div
        className={`nav-row${mode === "archived" ? " active" : ""}`}
        onClick={() =>
          setMode((m) => (m === "archived" ? "recent" : "archived"))
        }
      >
        <span>{STRINGS.sidebar.archived}</span>
        <span className="nav-count">{archivedCount}</span>
      </div>
      <div className="side-search" onClick={onSearch}>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <span className="side-search-text">
          {STRINGS.sidebar.searchPlaceholder}
        </span>
        <span className="kbd-hint">⌘K</span>
      </div>

      <div className="sec">
        <div className="sec-label">
          {mode === "archived"
            ? STRINGS.sidebar.archived
            : mode === "attention"
              ? STRINGS.sidebar.attention
              : STRINGS.sidebar.recent}
        </div>
        {visibleGroups.map((group) => (
          <div key={group.cwd}>
            <div className="proj" title={group.cwd}>
              <span>{basename(group.cwd)}</span>
              <span className="p-count">{group.rows.length}</span>
            </div>
            {group.rows.map((row) => {
              const card = agentById.get(row.agentId);
              const ident = card
                ? agentIdentity(card.id, card.name)
                : { letter: "?", cls: "other" };
              return (
                <SessionRow
                  key={row.key}
                  row={row}
                  agentName={card?.name ?? row.agentId}
                  letter={ident.letter}
                  tone={ident.cls}
                  active={row.key === activeKey}
                  renaming={renaming === row.key}
                  onSelect={() => onSelect(row)}
                  onRenameStart={() => setRenaming(row.key)}
                  onRenameDone={(title) => {
                    setRenaming(null);
                    if (title) void threads.rename(row.key, title);
                  }}
                />
              );
            })}
          </div>
        ))}
        {visibleGroups.length === 0 && (
          <div className="side-empty">
            {mode === "archived"
              ? STRINGS.sessions.archivedEmpty
              : mode === "attention"
                ? STRINGS.sessions.attentionEmpty
                : ""}
          </div>
        )}
      </div>

      {groups.length > 0 && mode === "recent" && (
        <div className="sec">
          <div className="sec-label">{STRINGS.sidebar.projects}</div>
          {groups.map((group) => (
            <div
              key={group.cwd}
              className={`sess${projectFilter === group.cwd ? " active" : ""}`}
              onClick={() =>
                setProjectFilter((p) => (p === group.cwd ? null : group.cwd))
              }
              title={group.cwd}
            >
              <div className="s-body">
                <div className="t">{group.project}</div>
                <div className="s-meta">{group.cwd}</div>
              </div>
              <span className="st">{group.rows.length}</span>
            </div>
          ))}
        </div>
      )}

      <div className="side-foot">
        <div className="settings-row" onClick={onSettings}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          {STRINGS.sidebar.settings}
        </div>
      </div>
    </aside>
  );
}
