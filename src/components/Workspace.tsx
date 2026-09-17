import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PanelShellActions,
  PanelShellMeta,
} from "../runtime/workspace-contract";
import {
  hostRestoreTransition,
  hostShadowQaEnabled,
} from "../runtime/host-shadow";
import { updateHostSessionMetadata } from "../runtime/host-session-metadata";
import { useThemePreference } from "../runtime/theme";
import { useHostWorkspace } from "../runtime/use-host-workspace";
import { useLifeModelWorkspace } from "../runtime/use-lifemodel-workspace";
import { CodexWorkspace } from "./CodexWorkspace";
import { OpenCodePanel } from "./OpenCodePanel";
import { PiWorkspace } from "./PiWorkspace";
import type { RuntimeProduct } from "./RuntimeChooser";
import { SessionDeletionDialog } from "./SessionDeletionDialog";
import { Sidebar, type SidebarSessionItem } from "./Sidebar";
import {
  sessionNavigationDisabled,
  sidebarSessionsFromHost,
} from "./sidebar-sessions";
import { UpdateDialog } from "./UpdateDialog";

const EMPTY_PANEL_META: PanelShellMeta = {
  activeSessionKey: null,
  busy: false,
  working: false,
  providerCount: 0,
  contextOpen: false,
};

// The single Farfold workbench shell. It owns the app-shell grid, the shared
// Sidebar and Host session navigation; the RuntimePanel registry is the only
// extension point for Runtime bodies. OpenCode is the completed ACP template;
// Pi and Codex keep their existing workspace panels until their ACP stages.
export function Workspace() {
  const [themeMode, setThemeMode] = useThemePreference();
  const [selectedRuntime, setSelectedRuntime] = useState<RuntimeProduct>("pi");
  const [projectPath, setProjectPath] = useState<string | null>(
    hostShadowQaEnabled
      ? import.meta.env.VITE_FARFOLD_QA_PROJECT_PATH?.trim() || null
      : null,
  );
  const [requestedHostSessionId, setRequestedHostSessionId] = useState<
    string | null
  >(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [panelMeta, setPanelMeta] = useState<PanelShellMeta>(EMPTY_PANEL_META);
  const [sessionDeletionTarget, setSessionDeletionTarget] =
    useState<SidebarSessionItem | null>(null);
  const panelActions = useRef<PanelShellActions>({});
  const lastRestoreSession = useRef<string | null | undefined>(undefined);
  const host = useHostWorkspace();
  const lifeModel = useLifeModelWorkspace();

  useEffect(() => {
    if (!host.state) return;
    const transition = hostRestoreTransition(
      lastRestoreSession.current,
      host.state.navigation,
    );
    lastRestoreSession.current =
      host.state.navigation.restoreState?.lastSessionId ?? null;
    if (!transition) return;
    setProjectPath(transition.projectPath);
    if (
      transition.runtimeProductId === "pi" ||
      transition.runtimeProductId === "opencode" ||
      transition.runtimeProductId === "codex"
    ) {
      setSelectedRuntime(transition.runtimeProductId);
    } else if (transition.runtimeProductId) {
      setError(
        `最近 Session 绑定的 Runtime ${transition.runtimeProductId} 不受当前版本支持。`,
      );
    }
  }, [host.state]);

  const onShellMeta = useCallback((meta: PanelShellMeta) => {
    setPanelMeta((previous) =>
      previous.activeSessionKey === meta.activeSessionKey &&
      previous.openingSessionKey === meta.openingSessionKey &&
      previous.busy === meta.busy &&
      previous.working === meta.working &&
      previous.providerCount === meta.providerCount &&
      previous.settingsTitle === meta.settingsTitle &&
      previous.settingsSubtitle === meta.settingsSubtitle &&
      previous.contextOpen === meta.contextOpen
        ? previous
        : meta,
    );
  }, []);

  // When a non-OpenCode runtime is selected the OpenCode panel stays mounted
  // but reports nothing; the legacy panels own their own shell chrome, so the
  // shared Sidebar state resets to neutral.
  useEffect(() => {
    if (selectedRuntime !== "opencode") setPanelMeta(EMPTY_PANEL_META);
  }, [selectedRuntime]);

  function selectHostSession(session: SidebarSessionItem) {
    if (
      session.runtimeProductId !== "pi" &&
      session.runtimeProductId !== "opencode" &&
      session.runtimeProductId !== "codex"
    ) {
      setError(`当前版本不支持 Runtime ${session.runtimeProductId}。`);
      return;
    }
    setRequestedHostSessionId(session.key);
    setSelectedRuntime(session.runtimeProductId);
  }

  async function archiveSession(session: SidebarSessionItem) {
    if (panelActions.current.archive)
      return panelActions.current.archive(session);
    await updateHostSessionMetadata({
      farfoldSessionId: session.key,
      archived: true,
    });
  }

  async function restoreSession(session: SidebarSessionItem) {
    if (panelActions.current.restore)
      return panelActions.current.restore(session);
    await updateHostSessionMetadata({
      farfoldSessionId: session.key,
      archived: false,
    });
  }

  const hostSessions = host.state?.navigation.sessionIndex.sessions ?? [];
  const hostPendingInteractions = host.state?.pendingInteractions ?? [];
  const sidebarSessions = sidebarSessionsFromHost(
    hostSessions,
    hostPendingInteractions,
  );
  const notice =
    error || lifeModel.error
      ? {
          message: error ?? lifeModel.error ?? "",
          onClose: () => {
            setError(null);
            lifeModel.clearError();
          },
        }
      : null;

  const shared = {
    initialProjectPath: projectPath,
    onProjectPath: setProjectPath,
    requestedHostSessionId,
    requestedHostSession:
      hostSessions.find(
        (session) => session.farfoldSessionId === requestedHostSessionId,
      ) ?? null,
    onRequestedHostSessionHandled: () => setRequestedHostSessionId(null),
    onSelectRuntime: setSelectedRuntime,
    onSelectHostSession: selectHostSession,
    themeMode,
    onThemeMode: setThemeMode,
    onOpenUpdate: () => setUpdateDialogOpen(true),
    lifeModel: lifeModel.controls,
    notice,
  };

  const openCodeActive = selectedRuntime === "opencode";

  // Keep every Runtime panel mounted so in-flight native work and event
  // subscriptions survive runtime switches; inactive shells hide via CSS.
  return (
    <>
      <div
        className={`app-shell${panelMeta.contextOpen ? " context-open" : ""}${openCodeActive ? "" : " shell-inactive"}`}
        aria-hidden={!openCodeActive}
      >
        <Sidebar
          sessions={sidebarSessions}
          activeSessionKey={panelMeta.activeSessionKey}
          search={search}
          disabled={panelMeta.busy}
          isSessionSelectionDisabled={(session) =>
            sessionNavigationDisabled(
              "opencode",
              session.runtimeProductId,
              panelMeta.working,
              panelMeta.busy,
            )
          }
          configuredProviderCount={panelMeta.providerCount}
          attentionCount={hostPendingInteractions.length}
          settingsTitle={panelMeta.settingsTitle}
          settingsSubtitle={panelMeta.settingsSubtitle}
          onSearch={setSearch}
          onNew={() => panelActions.current.newSession?.()}
          newDisabled={!panelActions.current.newSession}
          onSelect={(item) => {
            if (item.runtimeProductId !== "opencode") {
              selectHostSession(item);
              return;
            }
            setRequestedHostSessionId(item.key);
          }}
          onTogglePinned={(item) => panelActions.current.togglePinned?.(item)}
          onArchive={archiveSession}
          onRestore={restoreSession}
          onDelete={setSessionDeletionTarget}
          onOpenConnections={() => panelActions.current.openConnections?.()}
        />
        <main className="workspace">
          <OpenCodePanel
            {...shared}
            active={openCodeActive}
            shellActions={panelActions}
            onShellMeta={onShellMeta}
          />
        </main>
        {sessionDeletionTarget && openCodeActive && (
          <SessionDeletionDialog
            sessionId={sessionDeletionTarget.key}
            sessionTitle={sessionDeletionTarget.title}
            onClose={() => setSessionDeletionTarget(null)}
          />
        )}
      </div>
      <PiWorkspace
        {...shared}
        active={selectedRuntime === "pi"}
        hostChannel={host}
      />
      <CodexWorkspace
        {...shared}
        active={selectedRuntime === "codex"}
        hostChannel={host}
      />
      {updateDialogOpen && (
        <UpdateDialog onClose={() => setUpdateDialogOpen(false)} />
      )}
    </>
  );
}
