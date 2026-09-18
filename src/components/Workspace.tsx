import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PanelShellActions,
  PanelShellMeta,
} from "../runtime/workspace-contract";
import {
  hostRestoreSession,
  hostRestoreTransition,
  hostShadowQaEnabled,
} from "../runtime/host-shadow";
import { updateHostSessionMetadata } from "../runtime/host-session-metadata";
import { useThemePreference } from "../runtime/theme";
import { useHostWorkspace } from "../runtime/use-host-workspace";
import { useLifeModelWorkspace } from "../runtime/use-lifemodel-workspace";
import type { RuntimeProduct } from "./RuntimeChooser";
import { RUNTIME_PANELS } from "./runtime-panel-registry";
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

const SUPPORTED_PRODUCTS: readonly RuntimeProduct[] = RUNTIME_PANELS.map(
  (entry) => entry.product,
);

function samePanelMeta(a: PanelShellMeta, b: PanelShellMeta): boolean {
  return (
    a.activeSessionKey === b.activeSessionKey &&
    a.openingSessionKey === b.openingSessionKey &&
    a.busy === b.busy &&
    a.working === b.working &&
    a.providerCount === b.providerCount &&
    a.settingsTitle === b.settingsTitle &&
    a.settingsSubtitle === b.settingsSubtitle &&
    a.contextOpen === b.contextOpen
  );
}

// The single Farfold workbench shell. It owns the app-shell grid, the shared
// Sidebar and Host session navigation; RUNTIME_PANELS is the only extension
// point for Runtime bodies. OpenCode is the completed ACP template; Pi and
// Codex show the migration placeholder until their ACP stages land.
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
  const [panelMeta, setPanelMeta] = useState<
    Partial<Record<RuntimeProduct, PanelShellMeta>>
  >({});
  const [sessionDeletionTarget, setSessionDeletionTarget] =
    useState<SidebarSessionItem | null>(null);
  // Every mounted panel owns one stable actions slot and one stable meta
  // callback keyed by its product, so inactive panels can never overwrite the
  // chrome state another Runtime is displaying.
  const panelActions = useRef(
    new Map<RuntimeProduct, { current: PanelShellActions }>(),
  );
  const metaCallbacks = useRef(
    new Map<RuntimeProduct, (meta: PanelShellMeta) => void>(),
  );
  const lastRestoreSession = useRef<string | null | undefined>(undefined);
  const host = useHostWorkspace();
  const lifeModel = useLifeModelWorkspace();

  const onShellMeta = useCallback(
    (product: RuntimeProduct, meta: PanelShellMeta) => {
      setPanelMeta((previous) => {
        const current = previous[product];
        if (current && samePanelMeta(current, meta)) return previous;
        return { ...previous, [product]: meta };
      });
    },
    [],
  );

  function actionsFor(product: RuntimeProduct | string): PanelShellActions {
    return panelActions.current.get(product as RuntimeProduct)?.current ?? {};
  }

  function actionsSlotFor(product: RuntimeProduct) {
    let slot = panelActions.current.get(product);
    if (!slot) {
      slot = { current: {} };
      panelActions.current.set(product, slot);
    }
    return slot;
  }

  function shellMetaFor(product: RuntimeProduct) {
    let callback = metaCallbacks.current.get(product);
    if (!callback) {
      callback = (meta) => onShellMeta(product, meta);
      metaCallbacks.current.set(product, callback);
    }
    return callback;
  }

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
      SUPPORTED_PRODUCTS.includes(transition.runtimeProductId as RuntimeProduct)
    ) {
      setSelectedRuntime(transition.runtimeProductId as RuntimeProduct);
    } else if (transition.runtimeProductId) {
      setError(
        `最近 Session 绑定的 Runtime ${transition.runtimeProductId} 不受当前版本支持。`,
      );
    }
  }, [host.state]);

  // A session request is delivered only to the panel owning that Session's
  // Runtime; if the binding disappears before any panel consumes it, drop the
  // request instead of leaving it pending forever.
  useEffect(() => {
    if (!requestedHostSessionId || !host.state) return;
    const exists = host.state.navigation.sessionIndex.sessions.some(
      (session) => session.farfoldSessionId === requestedHostSessionId,
    );
    if (!exists) setRequestedHostSessionId(null);
  }, [requestedHostSessionId, host.state]);

  const handleRequestedHostSessionHandled = useCallback(
    (sessionId: string) => {
      setRequestedHostSessionId((current) =>
        current === sessionId ? null : current,
      );
    },
    [],
  );

  function selectHostSession(session: SidebarSessionItem) {
    if (
      !SUPPORTED_PRODUCTS.includes(session.runtimeProductId as RuntimeProduct)
    ) {
      setError(`当前版本不支持 Runtime ${session.runtimeProductId}。`);
      return;
    }
    setRequestedHostSessionId(session.key);
    setSelectedRuntime(session.runtimeProductId as RuntimeProduct);
  }

  async function archiveSession(session: SidebarSessionItem) {
    try {
      const action = actionsFor(session.runtimeProductId).archive;
      if (action) await action(session);
      else
        await updateHostSessionMetadata({
          farfoldSessionId: session.key,
          archived: true,
        });
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function restoreSession(session: SidebarSessionItem) {
    try {
      const action = actionsFor(session.runtimeProductId).restore;
      if (action) await action(session);
      else
        await updateHostSessionMetadata({
          farfoldSessionId: session.key,
          archived: false,
        });
    } catch (reason) {
      setError(String(reason));
    }
  }

  function toggleSessionPinned(session: SidebarSessionItem) {
    const action = actionsFor(session.runtimeProductId).togglePinned;
    if (action) return void action(session);
    void updateHostSessionMetadata({
      farfoldSessionId: session.key,
      pinned: !session.pinned,
    }).catch((reason) => setError(String(reason)));
  }

  const hostSessions = host.state?.navigation.sessionIndex.sessions ?? [];
  const hostPendingInteractions = host.state?.pendingInteractions ?? [];
  const requestedHostSession =
    hostSessions.find(
      (session) => session.farfoldSessionId === requestedHostSessionId,
    ) ?? null;
  const restoredHostSession = host.state
    ? hostRestoreSession(host.state.navigation)
    : null;
  const sidebarSessions = sidebarSessionsFromHost(
    hostSessions,
    hostPendingInteractions,
  );
  const activeMeta = panelMeta[selectedRuntime] ?? EMPTY_PANEL_META;
  const activeActions = actionsFor(selectedRuntime);
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
    onRequestedHostSessionHandled: handleRequestedHostSessionHandled,
    restoredHostSession,
    onSelectRuntime: setSelectedRuntime,
    themeMode,
    onThemeMode: setThemeMode,
    onOpenUpdate: () => setUpdateDialogOpen(true),
    lifeModel: lifeModel.controls,
    notice,
  };

  // Keep every Runtime panel mounted so in-flight native work and event
  // subscriptions survive runtime switches; inactive panels render nothing.
  return (
    <>
      <div
        className={`app-shell${activeMeta.contextOpen ? " context-open" : ""}`}
      >
        <Sidebar
          sessions={sidebarSessions}
          activeSessionKey={activeMeta.activeSessionKey}
          search={search}
          disabled={activeMeta.busy}
          isSessionSelectionDisabled={(session) =>
            sessionNavigationDisabled(
              selectedRuntime,
              session.runtimeProductId,
              activeMeta.working,
              activeMeta.busy,
            )
          }
          configuredProviderCount={activeMeta.providerCount}
          attentionCount={hostPendingInteractions.length}
          settingsTitle={activeMeta.settingsTitle}
          settingsSubtitle={activeMeta.settingsSubtitle}
          settingsDisabled={!activeActions.openConnections}
          onSearch={setSearch}
          onNew={() => activeActions.newSession?.()}
          newDisabled={!activeActions.newSession}
          onSelect={selectHostSession}
          onTogglePinned={toggleSessionPinned}
          onArchive={archiveSession}
          onRestore={restoreSession}
          onDelete={setSessionDeletionTarget}
          onOpenConnections={() => activeActions.openConnections?.()}
        />
        <main className="workspace">
          {RUNTIME_PANELS.map((entry) => {
            // Only the panel owning the requested Session's Runtime sees the
            // request; other mounted panels must neither consume nor display it.
            const ownsRequest =
              requestedHostSession?.runtimeProductId === entry.product;
            return (
              <entry.Panel
                key={entry.product}
                {...shared}
                product={entry.product}
                active={selectedRuntime === entry.product}
                requestedHostSessionId={
                  ownsRequest ? requestedHostSessionId : null
                }
                requestedHostSession={ownsRequest ? requestedHostSession : null}
                shellActions={actionsSlotFor(entry.product)}
                onShellMeta={shellMetaFor(entry.product)}
              />
            );
          })}
        </main>
        {sessionDeletionTarget && (
          <SessionDeletionDialog
            sessionId={sessionDeletionTarget.key}
            sessionTitle={sessionDeletionTarget.title}
            onClose={() => setSessionDeletionTarget(null)}
          />
        )}
      </div>
      {updateDialogOpen && (
        <UpdateDialog onClose={() => setUpdateDialogOpen(false)} />
      )}
    </>
  );
}
