import { useState } from "react";
import type { AgentsState } from "../runtime/agents";
import { STRINGS } from "../runtime/strings";
import type { ThemeMode } from "../runtime/theme";
import { AgentAccessSettings } from "./AgentAccessSettings";
import { GeneralSettings } from "./GeneralSettings";
import { LifeModelSettings } from "./LifeModelSettings";

type SettingsTab = "agents" | "lifemodel" | "general";

const TABS: { key: SettingsTab; label: string }[] = [
  { key: "agents", label: STRINGS.settings.tabs.agents },
  { key: "lifemodel", label: STRINGS.settings.tabs.lifemodel },
  { key: "general", label: STRINGS.settings.tabs.general },
];

interface SettingsPageProps {
  agents: AgentsState;
  initialCwd: string | null;
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
}

export function SettingsPage({
  agents,
  initialCwd,
  themeMode,
  onThemeMode,
}: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTab>("agents");

  return (
    <main className="main">
      <div className="topbar">
        <div className="title">{STRINGS.settings.title}</div>
        <span className="esc">{STRINGS.topbar.escBack}</span>
      </div>
      <div className="settings-body">
        <nav className="s-nav">
          {TABS.map((item) => (
            <div
              key={item.key}
              className={`sn ${tab === item.key ? "active" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => setTab(item.key)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setTab(item.key);
                }
              }}
            >
              {item.label}
            </div>
          ))}
        </nav>
        <div className="s-content">
          <div className="s-col">
            {tab === "agents" && (
              <AgentAccessSettings agents={agents} initialCwd={initialCwd} />
            )}
            {tab === "lifemodel" && <LifeModelSettings />}
            {tab === "general" && (
              <GeneralSettings
                themeMode={themeMode}
                onThemeMode={onThemeMode}
              />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
