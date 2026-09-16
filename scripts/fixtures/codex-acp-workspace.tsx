import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { CodexWorkspace } from "../../src/components/CodexWorkspace";
import {
  closedCodexAcpWorkspace,
  type CodexAcpWorkspaceSnapshot,
} from "../../src/runtime/codex-acp-workspace";
import {
  startHostShadow,
  type HostSessionBinding,
} from "../../src/runtime/host-shadow";
import type { LifeModelWorkspace } from "../../src/runtime/use-lifemodel-workspace";
import type { CodexNativeSession } from "../../src/runtime/codex-session";
import "../../src/styles.css";

// This browser-only file intercepts EVERY invoke. It is not imported by the app.
const calls: { command: string; sessionId?: string }[] = [];
const acp: HostSessionBinding = {
  farfoldSessionId: "fixture-acp",
  nativeSessionId: "acp-thread",
  runtimeProductId: "codex",
  installationId: "fixture-installation",
  adapterId: "codex-acp-stdio-v1",
  runtimeBuildId: "fixture-build",
  connectionId: "acp-connection",
  projectId: "project",
  projectPath: "/fixture",
  projectName: "Fixture",
  workingCopyId: "working-copy",
  workingCopyPath: "/fixture",
  workingCopyKind: "root",
  branchName: null,
  nativeLocatorRegistered: true,
  title: "ACP 原绑定",
  titleSource: "native",
  pinned: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
  unreviewedChangeCount: 0,
};
const direct: HostSessionBinding = {
  ...acp,
  farfoldSessionId: "fixture-direct",
  nativeSessionId: "direct-thread",
  adapterId: "codex-app-server",
  connectionId: "direct-connection",
  title: "旧 Direct 原绑定",
};
const navigation = {
  sessionIndex: { schemaVersion: 15, sessions: [acp, direct] },
  restoreState: { lastProjectId: "project", lastSessionId: null, updatedAt: 1 },
};
const native: CodexNativeSession = {
  thread: {
    id: direct.nativeSessionId,
    sessionId: "direct-tree",
    cwd: "/fixture",
    cliVersion: "0.143.0",
    createdAt: 1,
    updatedAt: 1,
    modelProvider: "fixture-provider",
    ephemeral: false,
    preview: "",
    source: "appServer",
    status: { type: "idle" },
    turns: [],
    name: "Old direct fixture",
  },
  model: "DIRECT FIXTURE MODEL",
  modelProvider: "fixture-provider",
  reasoningEffort: "medium",
  cwd: "/fixture",
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: { type: "workspaceWrite" },
};
function acpSnapshot(id: string | null): CodexAcpWorkspaceSnapshot {
  const s = closedCodexAcpWorkspace();
  if (!id) return s;
  if (id !== acp.farfoldSessionId) throw new Error("Foreign ACP target");
  s.target = {
    farfoldSessionId: id,
    runtime: {
      productId: "codex",
      installationId: acp.installationId,
      runtimeBuildId: acp.runtimeBuildId,
      adapterId: acp.adapterId,
      connectionId: acp.connectionId,
    },
    workingCopyId: acp.workingCopyId,
    cwd: acp.workingCopyPath,
    nativeThreadId: acp.nativeSessionId,
    nativeTreeId: "acp-tree",
  };
  return s;
}
let releaseRead: (() => void) | null = null;
let delayRead = false;
document.getElementById("fixture-delay")!.addEventListener("click", () => {
  delayRead = true;
});
document.getElementById("fixture-release")!.addEventListener("click", () => {
  releaseRead?.();
  releaseRead = null;
});
mockIPC(async (command, args = {}) => {
  const input = args.input as { farfoldSessionId?: string } | undefined;
  const id = (args.farfoldSessionId ?? input?.farfoldSessionId) as
    string | undefined;
  calls.push({ command, sessionId: id });
  document.getElementById("fixture-calls")!.textContent = JSON.stringify(
    calls,
    null,
    2,
  );
  if (command === "host_codex_acp_workspace") {
    const s = acpSnapshot(id ?? null);
    if (delayRead) {
      delayRead = false;
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
    }
    return s;
  }
  if (command === "host_session_open") {
    if (id !== direct.farfoldSessionId)
      throw new Error("ACP must never use direct open");
    return {
      farfoldSessionId: id,
      runtimeProductId: "codex",
      installationId: direct.installationId,
      nativeSessionId: direct.nativeSessionId,
      runtimeGeneration: 1,
      runtimeReadyAt: Date.now(),
      openedAt: 1,
      navigation,
      codex: native,
    };
  }
  if (command === "codex_connection_status")
    return {
      generation: 1,
      installationId: direct.installationId,
      connectionId: direct.connectionId,
      initialized: true,
      processRunning: true,
      stateDirectory: "/fixture/direct",
      account: { account: { type: "apiKey" }, requiresOpenaiAuth: true },
      loginPhase: null,
      diagnosticCount: 0,
      diagnosticMethods: [],
      droppedEvents: 0,
      error: null,
    };
  if (command === "session_draft_get")
    return {
      farfoldSessionId: id,
      body: id === acp.farfoldSessionId ? "ACP DRAFT" : "DIRECT DRAFT",
      updatedAt: 1,
    };
  if (command === "session_focus" || command === "host_session_focus")
    return navigation;
  if (command === "session_draft_set" || command === "session_draft_clear")
    return null;
  if (
    command === "host_session_title_refresh" ||
    command === "performance_trace_record"
  )
    return null;
  throw new Error(`Unexpected synthetic command: ${command}`);
});
const shadow = await startHostShadow(undefined, {
  initialSnapshot: async () => ({
    eventCursor: {
      streamId: "fixture",
      latestSequence: 0,
      oldestAvailable: null,
      droppedTotal: 0,
    },
    storage: {},
    navigation,
    runtimes: [],
    liveProjections: [],
    pendingInteractions: [],
  }),
  subscribe: async (_, __, callback) => {
    callback({
      type: "ready",
      snapshot: {
        streamId: "fixture",
        requestedAfter: 0,
        oldestAvailable: null,
        latestSequence: 0,
        nextAfter: 0,
        hasMore: false,
        gap: null,
        events: [],
      },
    });
    return { subscriptionId: 1 };
  },
  eventSnapshot: async () => {
    throw new Error("Unexpected replay");
  },
  unsubscribe: async () => undefined,
});
const noop = () => undefined;
const lifeModel = new Proxy(
  {
    open: false,
    snapshot: null,
    candidates: [],
    selectedItemIds: [],
    unavailable: null,
    busy: false,
  },
  {
    get: (target, key) =>
      key in target ? target[key as keyof typeof target] : noop,
  },
) as LifeModelWorkspace;
createRoot(document.getElementById("root")!).render(
  <CodexWorkspace
    active
    initialProjectPath="/fixture"
    onProjectPath={noop}
    requestedHostSessionId={null}
    requestedHostSession={null}
    onRequestedHostSessionHandled={noop}
    onSelectRuntime={noop}
    onSelectHostSession={noop}
    themeMode="light"
    onThemeMode={noop}
    onOpenUpdate={noop}
    lifeModel={lifeModel}
    notice={null}
    hostChannel={{
      state: shadow.snapshot(),
      unavailable: false,
      reconnectForQa: async () => shadow.snapshot(),
    }}
  />,
);
Object.assign(window, {
  codexClosedFixture: {
    calls,
    delayNextRead() {
      delayRead = true;
    },
    releaseRead() {
      releaseRead?.();
      releaseRead = null;
    },
  },
});
