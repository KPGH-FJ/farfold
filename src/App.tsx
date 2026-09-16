import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { HostActivationNotice } from "./components/HostActivationNotice";
import { HostRecoveryScreen } from "./components/HostRecoveryScreen";
import { OpenCodeWorkspace } from "./components/OpenCodeWorkspace";
import { CodexWorkspace } from "./components/CodexWorkspace";
import { PiWorkspace } from "./components/PiWorkspace";
import type { RuntimeProduct } from "./components/RuntimeChooser";
import type { SidebarSessionItem } from "./components/Sidebar";
import { UpdateDialog } from "./components/UpdateDialog";
import {
  hostRestoreTransition,
  hostShadowQaEnabled,
} from "./runtime/host-shadow";
import {
  loadHostStorageBootstrap,
  type HostStorageBootstrap,
} from "./runtime/host-storage";
import { traceAfterPaint } from "./runtime/performance-trace";
import { useThemePreference } from "./runtime/theme";
import { useHostWorkspace } from "./runtime/use-host-workspace";
import { useLifeModelWorkspace } from "./runtime/use-lifemodel-workspace";
import type { RuntimeWorkspaceProps } from "./runtime/workspace-contract";

function WorkspaceApp() {
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

  const shared: Omit<RuntimeWorkspaceProps, "active"> = {
    initialProjectPath: projectPath,
    onProjectPath: setProjectPath,
    requestedHostSessionId,
    requestedHostSession:
      host.state?.navigation.sessionIndex.sessions.find(
        (session) => session.farfoldSessionId === requestedHostSessionId,
      ) ?? null,
    onRequestedHostSessionHandled: () => setRequestedHostSessionId(null),
    onSelectRuntime: setSelectedRuntime,
    onSelectHostSession: selectHostSession,
    themeMode,
    onThemeMode: setThemeMode,
    onOpenUpdate: () => setUpdateDialogOpen(true),
    lifeModel: lifeModel.controls,
    notice:
      error || lifeModel.error
        ? {
            message: error ?? lifeModel.error ?? "",
            onClose: () => {
              setError(null);
              lifeModel.clearError();
            },
          }
        : null,
  };
  // Keep native controllers mounted when hidden so their active work and event subscriptions continue.
  return (
    <>
      <PiWorkspace
        {...shared}
        active={selectedRuntime === "pi"}
        hostChannel={host}
      />
      <OpenCodeWorkspace {...shared} active={selectedRuntime === "opencode"} />
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

export default function App() {
  const [bootstrap, setBootstrap] = useState<HostStorageBootstrap>({
    phase: "checking",
  });

  useEffect(() => {
    if (bootstrap.phase === "ready") traceAfterPaint("shell_ready");
  }, [bootstrap.phase]);

  useEffect(() => {
    let cancelled = false;
    void loadHostStorageBootstrap().then((result) => {
      if (!cancelled) setBootstrap(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function retryStorageStatus() {
    setBootstrap({ phase: "checking" });
    void loadHostStorageBootstrap().then(setBootstrap);
  }

  if (bootstrap.phase !== "ready") {
    return (
      <HostRecoveryScreen
        bootstrap={bootstrap}
        onRetry={retryStorageStatus}
        onReveal={revealItemInDir}
      />
    );
  }

  return (
    <>
      <WorkspaceApp />
      <HostActivationNotice
        status={bootstrap.activation}
        onReveal={revealItemInDir}
      />
    </>
  );
}
