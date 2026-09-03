import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  CaretRight,
  ChatTeardropText,
  FolderSimple,
  GearSix,
  MagnifyingGlass,
  NotePencil,
  PushPin,
  WarningCircle,
} from "@phosphor-icons/react";
import appIconUrl from "../../assets/app-icon.svg";
import {
  groupSidebarSessionsByProject,
  matchesSidebarSession,
  orderSidebarSessions,
  projectNameFromPath,
  type SidebarSessionItem,
} from "./sidebar-sessions";

export type { SidebarSessionItem } from "./sidebar-sessions";

interface SidebarProps {
  sessions: SidebarSessionItem[];
  activeSessionKey: string | null;
  search: string;
  disabled: boolean;
  connectedProviderCount: number;
  attentionCount: number;
  settingsTitle?: string;
  settingsSubtitle?: string;
  onSearch: (value: string) => void;
  onNew: () => void;
  onSelect: (session: SidebarSessionItem) => void;
  onTogglePinned: (session: SidebarSessionItem) => void;
  onArchive: (session: SidebarSessionItem) => void;
  onOpenConnections: () => void;
}

interface SessionRowProps {
  session: SidebarSessionItem;
  active: boolean;
  disabled: boolean;
  compact?: boolean;
  onSelect: (session: SidebarSessionItem) => void;
  onTogglePinned: (session: SidebarSessionItem) => void;
  onArchive: (session: SidebarSessionItem) => void;
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

function SessionRow({
  session,
  active,
  disabled,
  compact = false,
  onSelect,
  onTogglePinned,
  onArchive,
}: SessionRowProps) {
  return (
    <div
      className={`session-row${active ? " active" : ""}${compact ? " compact" : ""}`}
    >
      <button
        className="session-row-main"
        onClick={() => onSelect(session)}
        disabled={disabled && !active}
        aria-current={active ? "page" : undefined}
      >
        {session.attention ? (
          <WarningCircle
            className="session-attention-icon"
            size={16}
            weight="fill"
            aria-label="需要处理"
          />
        ) : (
          <ChatTeardropText
            size={16}
            weight={active ? "fill" : "regular"}
            aria-hidden="true"
          />
        )}
        <span className="session-copy">
          <strong>{session.title}</strong>
          <small>
            {compact
              ? `${session.runtimeLabel} · ${relativeTime(session.updatedAt)}`
              : `${session.runtimeLabel} · ${projectNameFromPath(session.projectPath)} · ${relativeTime(session.updatedAt)}`}
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
          <PushPin size={13} weight={session.pinned ? "fill" : "regular"} />
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
}

export function Sidebar({
  sessions,
  activeSessionKey,
  search,
  disabled,
  connectedProviderCount,
  attentionCount,
  settingsTitle = "模型与 Provider",
  settingsSubtitle,
  onSearch,
  onNew,
  onSelect,
  onTogglePinned,
  onArchive,
  onOpenConnections,
}: SidebarProps) {
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => {
    const activeProject = sessions.find(
      (session) => session.key === activeSessionKey,
    )?.projectPath;
    return new Set(activeProject ? [activeProject] : []);
  });
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

  useEffect(() => {
    const activeProject = sessions.find(
      (session) => session.key === activeSessionKey,
    )?.projectPath;
    if (!activeProject) return;
    setExpandedProjects((current) => {
      if (current.has(activeProject)) return current;
      return new Set([...current, activeProject]);
    });
  }, [activeSessionKey, sessions]);

  const query = search.trim();
  const ordered = useMemo(() => orderSidebarSessions(sessions), [sessions]);
  const results = useMemo(
    () =>
      ordered.filter(
        (session) =>
          matchesSidebarSession(session, query) &&
          (!attentionOnly || session.attention),
      ),
    [attentionOnly, ordered, query],
  );
  const projectGroups = useMemo(
    () => groupSidebarSessionsByProject(sessions),
    [sessions],
  );
  const pinned = ordered.filter((session) => session.pinned);
  const recent = ordered.filter((session) => !session.pinned).slice(0, 5);
  const resultsMode = Boolean(query) || attentionOnly;
  const resultLabel = query ? "搜索结果" : "需要处理";

  const rows = (items: SidebarSessionItem[], compact = false) =>
    items.map((session) => (
      <SessionRow
        key={session.key}
        session={session}
        active={session.key === activeSessionKey}
        disabled={disabled}
        compact={compact}
        onSelect={onSelect}
        onTogglePinned={onTogglePinned}
        onArchive={onArchive}
      />
    ));

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

      <button
        className={`attention-filter${attentionOnly ? " selected" : ""}`}
        type="button"
        aria-pressed={attentionOnly}
        onClick={() => setAttentionOnly((current) => !current)}
      >
        <WarningCircle
          size={16}
          weight={attentionCount ? "fill" : "regular"}
          aria-hidden="true"
        />
        <span>需要处理</span>
        <strong>{attentionCount}</strong>
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
          placeholder="搜索对话、项目或 Runtime"
          aria-label="搜索对话、项目或 Runtime"
        />
        <kbd>⌘K</kbd>
      </label>

      <nav
        className={`session-nav${resultsMode ? " results" : ""}`}
        aria-label="对话导航"
      >
        {resultsMode ? (
          <section aria-labelledby="sidebar-results-label">
            <p className="nav-label" id="sidebar-results-label">
              {resultLabel}
            </p>
            <div className="session-list">
              {results.length ? (
                rows(results)
              ) : (
                <p className="sidebar-empty">
                  {attentionOnly ? "没有已定位的待处理对话" : "没有匹配的对话"}
                </p>
              )}
            </div>
          </section>
        ) : (
          <>
            {pinned.length > 0 && (
              <section aria-labelledby="sidebar-pinned-label">
                <p className="nav-label" id="sidebar-pinned-label">
                  置顶
                </p>
                <div className="session-list">{rows(pinned)}</div>
              </section>
            )}
            <section aria-labelledby="sidebar-recent-label">
              <p className="nav-label" id="sidebar-recent-label">
                最近
              </p>
              <div className="session-list">
                {recent.length ? (
                  rows(recent)
                ) : (
                  <p className="sidebar-empty">
                    {sessions.length ? "所有对话均已置顶" : "还没有对话"}
                  </p>
                )}
              </div>
            </section>
          </>
        )}
      </nav>

      {!resultsMode && (
        <nav className="project-nav" aria-label="项目与对话">
          <p className="nav-label">项目</p>
          <div className="project-list">
            {projectGroups.map((group) => (
              <details
                className="project-group"
                key={group.path}
                open={expandedProjects.has(group.path)}
                onToggle={(event) => {
                  const expanded = event.currentTarget.open;
                  setExpandedProjects((current) => {
                    const next = new Set(current);
                    if (expanded) next.add(group.path);
                    else next.delete(group.path);
                    return next;
                  });
                }}
              >
                <summary title={group.path}>
                  <CaretRight
                    className="project-disclosure"
                    size={13}
                    aria-hidden="true"
                  />
                  <FolderSimple size={16} aria-hidden="true" />
                  <strong>{group.name}</strong>
                  <span>{group.sessions.length}</span>
                </summary>
                <div className="project-session-list">
                  {rows(group.sessions, true)}
                </div>
              </details>
            ))}
            {!projectGroups.length && (
              <p className="sidebar-empty">还没有项目</p>
            )}
          </div>
        </nav>
      )}

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
