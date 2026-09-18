import { useEffect, useState } from "react";
import { EmptyState } from "./components/EmptyState";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TopBar } from "./components/TopBar";
import { useAgents } from "./runtime/agents";
import { traceAfterPaint } from "./runtime/performance-trace";
import { STRINGS } from "./runtime/strings";
import { useThemePreference } from "./runtime/theme";

export default function App() {
  const [themeMode, setThemeMode] = useThemePreference();
  const agents = useAgents();
  const [view, setView] = useState<"home" | "settings">(() =>
    window.location.hash === "#settings" ? "settings" : "home",
  );

  useEffect(() => {
    if (!agents.loading) traceAfterPaint("shell_ready");
  }, [agents.loading]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && view === "settings") setView("home");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  const openSettings = () => setView("settings");

  return (
    <div className="app">
      <div className="body-row">
        <Sidebar
          settingsActive={view === "settings"}
          onOpenSettings={openSettings}
        />
        {view === "settings" ? (
          <SettingsPage
            agents={agents}
            themeMode={themeMode}
            onThemeMode={setThemeMode}
          />
        ) : (
          <main className="main">
            <TopBar connected={agents.connectedCards} />
            {agents.loading ? (
              <div className="empty-wrap">
                <div className="empty-col">
                  <div className="empty-sub">{STRINGS.common.loading}</div>
                </div>
              </div>
            ) : agents.loadError ? (
              <div className="empty-wrap">
                <div className="empty-col">
                  <div className="empty-h">{STRINGS.common.error}</div>
                  <div className="empty-sub">{agents.loadError}</div>
                  <div className="empty-actions">
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => void agents.refresh()}
                    >
                      {STRINGS.common.retry}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <EmptyState
                hasConnectedAgent={agents.connectedCards.length > 0}
                onGoSettings={openSettings}
              />
            )}
          </main>
        )}
      </div>
      <StatusBar connectedCount={agents.connectedCards.length} />
    </div>
  );
}
