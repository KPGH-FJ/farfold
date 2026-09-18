import {
  Clock,
  GearSix,
  MagnifyingGlass,
  NotePencil,
  Tray,
} from "@phosphor-icons/react";
import { STRINGS } from "../runtime/strings";

interface SidebarProps {
  settingsActive: boolean;
  onOpenSettings: () => void;
}

export function Sidebar({ settingsActive, onOpenSettings }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">{STRINGS.app.name}</div>

      <div className="nav-row disabled" aria-disabled="true">
        <span className="nav-item">
          <NotePencil size={14} />
          {STRINGS.sidebar.newChat}
        </span>
        <span className="kbd-hint">⌘N</span>
      </div>
      <div className="nav-row disabled" aria-disabled="true">
        <span className="nav-item">
          <Clock size={14} />
          {STRINGS.sidebar.attention}
        </span>
        <span className="nav-count">0</span>
      </div>
      <div className="nav-row disabled" aria-disabled="true">
        <span className="nav-item">
          <Tray size={14} />
          {STRINGS.sidebar.archived}
        </span>
        <span className="nav-count">0</span>
      </div>

      <div className="side-search disabled" aria-disabled="true">
        <MagnifyingGlass size={13} />
        <span className="side-search-text">
          {STRINGS.sidebar.searchPlaceholder}
        </span>
        <span className="kbd-hint">{STRINGS.sidebar.searchShortcut}</span>
      </div>

      <div className="sec">
        <div className="sec-label">{STRINGS.sidebar.recent}</div>
        <div className="side-empty">{STRINGS.sidebar.noSessions}</div>
      </div>
      <div className="sec">
        <div className="sec-label">{STRINGS.sidebar.projects}</div>
        <div className="side-empty">{STRINGS.sidebar.noProjects}</div>
      </div>

      <div className="side-foot">
        <div
          className={`settings-row ${settingsActive ? "active" : ""}`}
          role="button"
          tabIndex={0}
          onClick={onOpenSettings}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpenSettings();
            }
          }}
        >
          <GearSix size={14} />
          <span>{STRINGS.sidebar.settings}</span>
        </div>
      </div>
    </aside>
  );
}
