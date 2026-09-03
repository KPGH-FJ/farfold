import { useEffect, useRef } from "react";
import {
  Archive,
  ChatTeardropText,
  FolderSimple,
  GearSix,
  MagnifyingGlass,
  NotePencil,
  PushPin,
} from "@phosphor-icons/react";
import appIconUrl from "../../assets/app-icon.svg";

export interface SidebarSessionItem {
  key: string;
  nativeSessionId: string;
  projectPath: string;
  title: string;
  updatedAt: number;
  runtimeLabel: string;
  pinned: boolean;
}

interface SidebarProps {
  sessions: SidebarSessionItem[];
  activeSessionKey: string | null;
  search: string;
  projectFilter: string;
  disabled: boolean;
  connectedProviderCount: number;
  settingsTitle?: string;
  settingsSubtitle?: string;
  onSearch: (value: string) => void;
  onProjectFilter: (value: string) => void;
  onNew: () => void;
  onSelect: (session: SidebarSessionItem) => void;
  onTogglePinned: (session: SidebarSessionItem) => void;
  onArchive: (session: SidebarSessionItem) => void;
  onOpenConnections: () => void;
}

function projectName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function relativeTime(timestamp: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}

export function Sidebar({
  sessions,
  activeSessionKey,
  search,
  projectFilter,
  disabled,
  connectedProviderCount,
  settingsTitle = "模型与 Provider",
  settingsSubtitle,
  onSearch,
  onProjectFilter,
  onNew,
  onSelect,
  onTogglePinned,
  onArchive,
  onOpenConnections,
}: SidebarProps) {
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if (event.metaKey && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  const projects = Array.from(
    new Set(sessions.map((session) => session.projectPath)),
  );
  const query = search.trim().toLocaleLowerCase();
  const visible = sessions.filter((session) => {
    const matchesProject =
      projectFilter === "all" || session.projectPath === projectFilter;
    const matchesSearch =
      !query ||
      session.title.toLocaleLowerCase().includes(query) ||
      projectName(session.projectPath).toLocaleLowerCase().includes(query);
    return matchesProject && matchesSearch;
  });

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src={appIconUrl} alt="" />
        <span>Farfold</span>
      </div>

      <button className="new-chat" onClick={onNew} disabled={disabled}>
        <NotePencil size={17} weight="regular" />
        新对话
      </button>

      <label className="session-search">
        <MagnifyingGlass size={16} aria-hidden="true" />
        <input
          ref={searchInput}
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            if (search) onSearch("");
            else event.currentTarget.blur();
          }}
          placeholder="搜索对话"
          aria-label="搜索对话"
        />
        <kbd>⌘K</kbd>
      </label>

      <nav className="session-nav" aria-label="最近对话">
        <p className="nav-label">最近</p>
        <div className="session-list">
          {visible.length ? (
            visible.map((session) => {
              const active = session.key === activeSessionKey;
              return (
                <div
                  className={`session-row${active ? " active" : ""}`}
                  key={session.key}
                >
                  <button
                    className="session-row-main"
                    onClick={() => onSelect(session)}
                    disabled={disabled && !active}
                    aria-current={active ? "page" : undefined}
                  >
                    <ChatTeardropText
                      size={16}
                      weight={active ? "fill" : "regular"}
                    />
                    <span className="session-copy">
                      <strong>{session.title}</strong>
                      <small>
                        {session.runtimeLabel} ·{" "}
                        {projectName(session.projectPath)} ·{" "}
                        {relativeTime(session.updatedAt)}
                      </small>
                    </span>
                  </button>
                  <span className="session-row-actions">
                    <button
                      className={session.pinned ? "pinned" : ""}
                      type="button"
                      title={session.pinned ? "取消置顶" : "置顶"}
                      aria-label={`${session.pinned ? "取消置顶" : "置顶"}：${session.title}`}
                      onClick={() => onTogglePinned(session)}
                      disabled={disabled}
                    >
                      <PushPin
                        size={13}
                        weight={session.pinned ? "fill" : "regular"}
                      />
                    </button>
                    <button
                      type="button"
                      title="归档"
                      aria-label={`归档：${session.title}`}
                      onClick={() => onArchive(session)}
                      disabled={disabled}
                    >
                      <Archive size={13} />
                    </button>
                  </span>
                  {active && <i className="active-dot" aria-label="当前对话" />}
                </div>
              );
            })
          ) : (
            <p className="sidebar-empty">没有匹配的对话</p>
          )}
        </div>
      </nav>

      <nav className="project-nav" aria-label="Project 筛选">
        <p className="nav-label">项目</p>
        <div className="project-list">
          <button
            className={projectFilter === "all" ? "selected" : ""}
            onClick={() => onProjectFilter("all")}
          >
            <FolderSimple size={16} />
            <strong>全部</strong>
            <span>{sessions.length}</span>
          </button>
          {projects.map((path) => (
            <button
              className={projectFilter === path ? "selected" : ""}
              key={path}
              onClick={() => onProjectFilter(path)}
              title={path}
            >
              <FolderSimple size={16} />
              <strong>{projectName(path)}</strong>
              <span>
                {
                  sessions.filter((session) => session.projectPath === path)
                    .length
                }
              </span>
            </button>
          ))}
        </div>
      </nav>

      <button
        className="sidebar-settings"
        onClick={onOpenConnections}
        data-provider-settings-trigger
      >
        <GearSix size={16} />
        <span>
          <strong>{settingsTitle}</strong>
          <small>
            {settingsSubtitle ??
              (connectedProviderCount
                ? `${connectedProviderCount} 个已连接`
                : "连接模型服务")}
          </small>
        </span>
      </button>
    </aside>
  );
}
