import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "/src/App";
import { DraftStartup } from "/src/components/DraftStartup";
import { StorageStartup } from "/src/components/StorageRecovery";
import { threads, freshThreadState } from "/src/runtime/sessions";
import {
  composerDrafts,
  newConversationChoice,
  draftPersistence,
} from "/src/runtime/drafts";
import { worktrees } from "/src/runtime/worktrees";
import { worktreeManagement } from "/src/runtime/worktree_management";
import "@xterm/xterm/css/xterm.css";
import "/src/styles.css";
import "/src/styles-settings.css";
import "/src/styles-content.css";
import "/src/styles-thread.css";
import "/src/styles-artifact.css";
import "/src/product-shell.css";
import "/src/conversation-workspace.css";
import "/src/history-import.css";
import "/src/desktop-workbench.css";

const w = window as any;
const oid = "a".repeat(40),
  cwd = "/controlled/new11-tree";
const mode = new URLSearchParams(location.search).get("mode") ?? "archive";
const tree = {
  id: "new11-location",
  revision: 1,
  path: cwd,
  repositoryRoot: "/controlled/new11-repo",
  headOid: oid,
  branch: "refs/heads/new11",
  ownership: "created",
  availability: "verified",
};
const archive = {
  id: tree.id,
  revision: 2,
  originalPath: cwd,
  retainedPath: "/controlled/new11-retained/tree",
  repositoryRoot: tree.repositoryRoot,
  headOid: oid,
  branch: tree.branch,
  ownership: "created",
  availability: "verified",
};
const agent = {
  id: "fixture",
  name: "Controlled Agent",
  source: "custom",
  command: "/controlled/never-executed",
  args: [],
  env: [],
  version: null,
  handshake: null,
  createdAt: 1,
  updatedAt: 1,
};
const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "one",
    options: [
      { value: "one", name: "One" },
      { value: "two", name: "Two" },
    ],
  },
];
const settings = new Map<string, unknown>();
settings.set("agentSetup.v1", {
  version: 1,
  completed: ["fixture"],
  pending: {},
  progress: {},
  selections: { fixture: { service: null, config: {} } },
});
let locations: any[] = [tree],
  archives: any[] = [],
  operation: any = null;
let opened = 0,
  channel: any = null;
let releaseConfig: (() => void) | null = null;
const list = () =>
  structuredClone({
    locations,
    archives,
    recoveries: [],
    materials: [],
    operation,
  });
const draftKey = () => `fixture:${cwd}:prepared-${opened}`;
const historyKey = `fixture:/controlled/other:existing`;
const row = {
  id: historyKey,
  agentId: "fixture",
  cwd: "/controlled/other",
  nativeSessionId: "existing",
  title: "NEW11_OTHER_HISTORY",
  configOptions: null,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
};
w.testInvoke = async (cmd: string, args: any) => {
  w.calls.push({
    cmd,
    args: args
      ? {
          ...args,
          channel: args.channel ? "controlled-real-Channel" : undefined,
        }
      : args,
  });
  if (cmd === "settings_get")
    return args.key === "autoArchiveDays"
      ? 0
      : (settings.get(args.key) ?? null);
  if (cmd === "settings_set") {
    settings.set(args.key, structuredClone(args.value));
    return;
  }
  if (cmd === "storage_recovery_status")
    return {
      ready: true,
      issue: null,
      dataDirectory: "/controlled/data",
      databaseReplacementAvailable: false,
      databaseReplacement: null,
    };
  if (cmd === "app_initial_snapshot") return { agents: [agent], settings: {} };
  if (cmd === "app_default_working_directory") return "/controlled/default";
  if (cmd === "session_index_list") return [row];
  if (
    [
      "catalog_list",
      "catalog_scan",
      "credential_list",
      "desktop_notification_take_pending",
      "prompt_templates_list",
      "agent_status",
    ].includes(cmd)
  )
    return [];
  if (
    [
      "app_drafts_ready",
      "host_performance_sample",
      "session_mark_read",
      "session_index_mark_read",
      "session_close",
      "session_dismiss",
      "plugin:event|unlisten",
    ].includes(cmd)
  )
    return;
  if (cmd === "host_performance_origin") return null;
  if (cmd === "plugin:event|listen") return 1;
  if (cmd === "agent_work_get")
    return { cwd: args.cwd, enabled: {}, locationEnabled: true };
  if (cmd === "desktop_notifications_get")
    return { enabled: false, sound: false };
  if (cmd === "browser_share_status")
    return {
      taskKey: args.taskKey,
      label: args.label,
      agentId: "fixture",
      phase: "unshared",
      revision: 0,
      reason: null,
      pendingRequest: null,
    };
  if (cmd === "session_open") {
    opened++;
    channel = args.channel;
    return {
      nativeSessionId: `prepared-${opened}`,
      connectionId: "controlled-preparation-connection",
      cwd: args.cwd,
      configOptions,
      configOptionsModern: true,
      resumed: false,
      warnings: [],
      permissionState: "ready",
    };
  }
  if (cmd === "session_set_config")
    return new Promise((resolve) => {
      releaseConfig = () =>
        resolve({
          configOptions: configOptions.map((c) => ({
            ...c,
            currentValue: args.value,
          })),
          configCheck: { status: "ready" },
        });
    });
  if (cmd === "worktree_list") return list();
  if (cmd === "worktree_recycle_inspect")
    return {
      inspectionId: "new11-inspection",
      action: "archive",
      recordId: tree.id,
      revision: tree.revision,
      originalPath: cwd,
      retainedPath: archive.retainedPath,
      repositoryRoot: tree.repositoryRoot,
      headOid: oid,
      branch: tree.branch,
      blockers: [],
      impact: { conversations: 0, unsent: false },
      material: { entries: 1, bytes: 42, sha256: "b".repeat(64) },
      draftBaseline: { unsentWork: null, agentSetup: null },
    };
  if (cmd === "worktree_recycle_prepare")
    return (operation = {
      kind: "operation",
      operationId: args.operationId,
      action: "archive",
      state: "prepared",
      settled: false,
      cancelRequested: false,
      maintenanceActive: true,
      originalPath: cwd,
      retainedPath: archive.retainedPath,
    });
  if (cmd === "worktree_start") {
    archives = [archive];
    locations = [];
    return (operation = {
      ...operation,
      state: "ready",
      settled: true,
      maintenanceActive: false,
      archive,
    });
  }
  if (cmd === "worktree_status" || cmd === "worktree_recheck")
    return structuredClone(operation);
  w.unexpected.push(cmd);
  throw Error("Unexpected controlled IPC " + cmd);
};
await draftPersistence.load();
newConversationChoice.cwd = cwd;
newConversationChoice.agentId = "fixture";
composerDrafts.update("new", () => ({ text: "", attachments: [] }));
const history = freshThreadState(
  historyKey,
  "fixture",
  "/controlled/other",
  "existing",
);
history.identity = "established";
history.title = row.title;
history.items = [
  {
    kind: "agent",
    id: "existing-message",
    text: "NEW11_EXISTING_BODY_UNCHANGED",
    streaming: false,
    time: 0,
  },
];
threads.getSnapshot().threads.set(historyKey, history);
await draftPersistence.flush();
w.fixture = {
  current: () => ({
    mode,
    cwd: newConversationChoice.cwd,
    draft: composerDrafts.read("new"),
    snapshot: worktrees.snapshot(),
    threads: [...threads.getSnapshot().threads.values()].map((t) => ({
      key: t.key,
      identity: t.identity,
      connectionLost: t.connectionLost,
      configuring: t.configuring,
      items: t.items.length,
    })),
    draftKey: draftKey(),
    calls: w.calls,
    unexpected: w.unexpected,
    settings: [...settings],
    request: worktreeManagement.snapshot(),
  }),
  retire: () => threads.retirePreparationDraft(draftKey(), () => true),
  discard: () => threads.discardDraft(draftKey()),
  openManagement: () => worktreeManagement.open({ cwd: null, target: null }),
  closeManagement: () => {
    const r = worktreeManagement.snapshot();
    if (r) worktreeManagement.close(r);
  },
  archiveExternal: () => {
    archives = [archive];
    locations = [];
    return worktrees.load();
  },
  loseConnection: () =>
    channel?.onmessage({ kind: "connectionLost", reason: "configuration" }),
  configure: () => {
    void threads.setConfig(draftKey(), "model", "two").catch((e) => {
      w.configError = String(e);
    });
  },
  releaseConfig: () => releaseConfig?.(),
  setDraftText: (text: string) =>
    composerDrafts.update("new", (d) => ({ ...d, text })),
};
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StorageStartup>
      <DraftStartup>
        <App />
      </DraftStartup>
    </StorageStartup>
  </StrictMode>,
);
