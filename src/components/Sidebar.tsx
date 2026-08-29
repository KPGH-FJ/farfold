import { useEffect, useRef } from "react";
import {
  ChatTeardropText,
  FolderSimple,
  GearSix,
  MagnifyingGlass,
  NotePencil,
} from "@phosphor-icons/react";
import type { SessionSummary } from "../runtime/pi";
import appIconUrl from "../../assets/app-icon.svg";

interface SidebarProps {
  sessions: SessionSummary[];
  activeSessionFile: string | null;
  search: string;
  projectFilter: string;
  disabled: boolean;
  configuredProviderCount: number;
  onSearch: (value: string) => void;
  onProjectFilter: (value: string) => void;
  onNew: () => void;
  onSelect: (session: SessionSummary) => void;
  onOpenProviderSettings: () => void;
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
  activeSessionFile,
  search,
  projectFilter,
  disabled,
  configuredProviderCount,
  onSearch,
  onProjectFilter,
  onNew,
  onSelect,
  onOpenProviderSettings,
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
              const active = session.sessionFile === activeSessionFile;
              return (
                <button
                  className={`session-row${active ? " active" : ""}`}
                  key={session.sessionId}
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
                      {projectName(session.projectPath)} ·{" "}
                      {relativeTime(session.updatedAt)}
                    </small>
                  </span>
                  {active && <i className="active-dot" aria-label="当前对话" />}
                </button>
              );
            })
          ) : (
            <p className="sidebar-empty">没有匹配的对话</p>
          )}
        </div>
      </nav>

      <nav className="project-nav" aria-label="Project 筛选">
        <p className="nav-label">项目</p>
        <button
          className={projectFilter === "all" ? "selected" : ""}
          onClick={() => onProjectFilter("all")}
        >
          <FolderSimple size={16} />
          全部
          <span>{sessions.length}</span>
        </button>
        {projects.map((path) => (
          <button
            className={projectFilter === path ? "selected" : ""}
            key={path}
            onClick={() => onProjectFilter(path)}
          >
            <FolderSimple size={16} />
            {projectName(path)}
            <span>
              {
                sessions.filter((session) => session.projectPath === path)
                  .length
              }
            </span>
          </button>
        ))}
      </nav>

      <button
        className="sidebar-settings"
        onClick={onOpenProviderSettings}
        disabled={disabled}
      >
        <GearSix size={16} />
        <span>
          <strong>Provider</strong>
          <small>
            {configuredProviderCount
              ? `${configuredProviderCount} 个已配置 · 待验证`
              : "添加 API Key"}
          </small>
        </span>
      </button>
    </aside>
  );
}
