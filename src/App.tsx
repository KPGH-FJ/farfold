import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useMemo, useState } from "react";
import { AgentSwitcher } from "./components/AgentSwitcher";
import { CommandPalette } from "./components/CommandPalette";
import { EmptyState } from "./components/EmptyState";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { ThreadView } from "./components/ThreadView";
import { useAgents } from "./runtime/agents";
import { traceAfterPaint } from "./runtime/performance-trace";
import {
  threads,
  useThread,
  useThreadsSnapshot,
  type IndexRow,
  type SidebarRow,
} from "./runtime/sessions";
import { STRINGS } from "./runtime/strings";
import { useThemePreference } from "./runtime/theme";

type View =
  { kind: "start" } | { kind: "thread"; key: string } | { kind: "settings" };

function ThreadPage({
  viewKey,
  agents,
  onGoSettings,
}: {
  viewKey: string;
  agents: ReturnType<typeof useAgents>;
  onGoSettings: () => void;
}) {
  const thread = useThread(viewKey);
  const snapshot = useThreadsSnapshot();
  const row = snapshot.index.find((r) => r.id === viewKey);
  const title = thread?.title || row?.title || STRINGS.sessions.newSession;
  return (
    <main className="main">
      <div className="topbar">
        <div className="title">{title}</div>
        {thread && !thread.openError && (
          <AgentSwitcher
            thread={thread}
            cards={agents.cards}
            onGoSettings={onGoSettings}
          />
        )}
      </div>
      {thread ? (
        <ThreadView
          thread={thread}
          agents={agents.cards}
          onGoSettings={onGoSettings}
        />
      ) : (
        <div className="empty-wrap">
          <div className="empty-col">
            <div className="empty-sub">{STRINGS.common.loading}</div>
          </div>
        </div>
      )}
    </main>
  );
}

export default function App() {
  const [themeMode, setThemeMode] = useThemePreference();
  const agents = useAgents();
  const snapshot = useThreadsSnapshot();
  const [view, setView] = useState<View>(() =>
    window.location.hash === "#settings"
      ? { kind: "settings" }
      : { kind: "start" },
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [version, setVersion] = useState("");

  useEffect(() => {
    void threads.refreshIndex();
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  // Agent 连接状态变化 → 合并 agent 侧 session/list 到侧栏。
  const connectedKey = agents.cards
    .filter((card) => card.status === "connected")
    .map((card) => card.id)
    .sort()
    .join(",");
  useEffect(() => {
    void threads.refreshIndex();
  }, [connectedKey]);

  // 周期性合并，接住 agent 侧新产生的历史。
  useEffect(() => {
    const timer = setInterval(() => void threads.refreshIndex(), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!agents.loading) traceAfterPaint("shell_ready");
  }, [agents.loading]);

  const activeKey = view.kind === "thread" ? view.key : null;
  const activeThread = useThread(activeKey);

  const openSettings = () => setView({ kind: "settings" });
  const goNew = () => setView({ kind: "start" });

  /** Sidebar/palette pick: focus a live thread or resume it from disk. */
  const openRow = (row: IndexRow | SidebarRow) => {
    setPaletteOpen(false);
    const key = "key" in row ? row.key : row.id;
    setView({ kind: "thread", key });
    if (!row.nativeSessionId) {
      threads.markOpenFailed(
        key,
        row.agentId,
        row.cwd,
        "",
        STRINGS.thread.notResumable,
        true,
      );
      return;
    }
    const existing = threads.thread(key);
    if (existing && !existing.connectionLost && !existing.openError) return;
    threads
      .open({
        agentId: row.agentId,
        cwd: row.cwd,
        nativeSessionId: row.nativeSessionId ?? undefined,
      })
      .catch((error) => {
        threads.markOpenFailed(
          key,
          row.agentId,
          row.cwd,
          row.nativeSessionId ?? "",
          String(error),
          true,
        );
      });
  };

  const defaultCwd = useMemo(() => {
    const latest = snapshot.index
      .filter((r) => !r.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return latest?.cwd ?? null;
  }, [snapshot.index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (meta && event.shiftKey && key === "p") {
        event.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (meta && key === "k") {
        event.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (meta && key === "n") {
        event.preventDefault();
        setView({ kind: "start" });
        return;
      }
      if (event.key === "Escape") {
        if (paletteOpen) setPaletteOpen(false);
        else if (view.kind === "settings") setView({ kind: "start" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, view.kind]);

  return (
    <div className="app">
      <div className="body-row">
        <Sidebar
          agents={agents.cards}
          activeKey={activeKey}
          onNew={goNew}
          onSelect={openRow}
          onSearch={() => setPaletteOpen(true)}
          onSettings={openSettings}
        />
        {view.kind === "settings" ? (
          <SettingsPage
            agents={agents}
            themeMode={themeMode}
            onThemeMode={setThemeMode}
          />
        ) : view.kind === "thread" ? (
          <ThreadPage
            viewKey={view.key}
            agents={agents}
            onGoSettings={openSettings}
          />
        ) : agents.loading ? (
          <main className="main">
            <div className="empty-wrap">
              <div className="empty-col">
                <div className="empty-sub">{STRINGS.common.loading}</div>
              </div>
            </div>
          </main>
        ) : agents.loadError ? (
          <main className="main">
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
          </main>
        ) : (
          <EmptyState
            agents={agents.cards}
            defaultCwd={defaultCwd}
            onGoSettings={openSettings}
            onStarted={(key) => setView({ kind: "thread", key })}
          />
        )}
      </div>
      <StatusBar
        thread={activeThread}
        agents={agents.cards}
        version={version}
      />
      {paletteOpen && (
        <CommandPalette
          agents={agents.cards}
          activeKey={activeKey}
          onClose={() => setPaletteOpen(false)}
          onNew={() => {
            setPaletteOpen(false);
            goNew();
          }}
          onSelect={openRow}
          onSettings={() => {
            setPaletteOpen(false);
            openSettings();
          }}
          onArchive={(rowId, archived) =>
            void threads.setArchived(rowId, archived)
          }
        />
      )}
    </div>
  );
}
