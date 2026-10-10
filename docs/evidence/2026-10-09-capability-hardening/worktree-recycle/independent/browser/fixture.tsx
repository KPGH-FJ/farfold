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
const params = new URLSearchParams(location.search);
let mode = params.get("mode") ?? "normal";
const oid = "a".repeat(40);
const originalPath = "/controlled/created-tree";
const retainedPath = "/controlled/retained/tree";
const tree = {
  id: "controlled-created",
  revision: 1,
  path: originalPath,
  repositoryRoot: "/controlled/repo",
  branch: "refs/heads/controlled",
  headOid: oid,
  ownership: "created",
  availability: "verified",
};
const adopted = {
  ...tree,
  id: "controlled-existing",
  path: "/controlled/adopted",
  ownership: "existing",
  branch: "refs/heads/adopted",
};
const archive = {
  id: tree.id,
  revision: 2,
  originalPath,
  retainedPath,
  repositoryRoot: tree.repositoryRoot,
  branch: tree.branch,
  headOid: oid,
  ownership: "created",
  availability: "verified",
};
let locations: any[] = [tree, adopted];
let archives: any[] = [];
let operation: any = null;
let releasePrepare: (() => void) | null = null;
let ticket = 0;
const settings = new Map<string, unknown>();
const key = "fixture:/controlled/created-tree:history";
const row = {
  id: key,
  agentId: "fixture",
  cwd: originalPath,
  nativeSessionId: "history",
  title: "CONTROLLED_HISTORY_UNMOVED",
  configOptions: null,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
};
function op(
  id: string,
  action: string,
  state: string,
  active: boolean,
  code?: string,
) {
  return {
    kind: "operation",
    operationId: id,
    action,
    state,
    maintenanceActive: active,
    settled: ["ready", "failed", "cancelled", "unknown"].includes(state),
    cancelRequested: state === "cancelled",
    originalPath,
    retainedPath,
    ...(code ? { code } : {}),
    ...(state === "ready"
      ? action === "archive"
        ? { archive }
        : { location: { ...tree, revision: 3 } }
      : {}),
  };
}
function complete() {
  if (!operation) throw Error("No operation");
  operation = op(operation.operationId, operation.action, "ready", false);
  if (operation.action === "archive") {
    locations = [adopted];
    archives = [archive];
  } else {
    locations = [{ ...tree, revision: 3 }, adopted];
    archives = [];
  }
}
w.testInvoke = async (cmd: string, args: any) => {
  w.calls.push({
    cmd,
    args,
    locked: !!draftPersistence.snapshot().interactionLocked,
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
  if (
    [
      "app_drafts_ready",
      "host_performance_sample",
      "session_mark_read",
      "session_index_mark_read",
      "plugin:event|unlisten",
    ].includes(cmd)
  )
    return;
  if (cmd === "host_performance_origin") return null;
  if (cmd === "plugin:event|listen") return 1;
  if (cmd === "app_initial_snapshot") return { agents: [], settings: {} };
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
  if (cmd === "app_default_working_directory") return "/controlled/unrelated";
  if (cmd === "session_index_list") return [row];
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
  if (cmd === "worktree_list")
    return structuredClone({ locations, archives, materials: [], operation });
  if (cmd === "worktree_recycle_inspect")
    return {
      inspectionId: "controlled-ticket-" + ++ticket,
      action: args.action,
      recordId: tree.id,
      revision: args.expectedRevision,
      originalPath,
      retainedPath,
      repositoryRoot: tree.repositoryRoot,
      headOid: oid,
      branch: tree.branch,
      blockers: mode === "blocked" ? ["unsentWork"] : [],
      impact: { conversations: 1, unsent: mode === "blocked" },
      material: { entries: 8, bytes: 512, sha256: "b".repeat(64) },
      draftBaseline: { unsentWork: "c".repeat(64), agentSetup: null },
    };
  if (cmd === "worktree_recycle_prepare") {
    operation = op(args.operationId, args.action, "prepared", true);
    if (mode === "rejected")
      return (operation = op(
        args.operationId,
        args.action,
        "failed",
        false,
        "draftChanged",
      ));
    if (mode === "prepare-error")
      throw Error("Controlled lost prepare receipt");
    if (mode === "late")
      return new Promise((resolve) => {
        const captured = structuredClone(operation);
        releasePrepare = () => resolve(captured);
      });
    return structuredClone(operation);
  }
  if (cmd === "worktree_start") {
    operation = op(args.operationId, operation.action, "running", true);
    return structuredClone(operation);
  }
  if (cmd === "worktree_status" || cmd === "worktree_recheck") {
    if (mode === "wrong-id") return { ...operation, operationId: "wrong" };
    return structuredClone(operation);
  }
  if (cmd === "worktree_cancel") {
    operation = op(
      args.operationId,
      operation?.action ?? "archive",
      "cancelled",
      false,
    );
    return structuredClone(operation);
  }
  if (cmd === "worktree_recycle_check") {
    archives = archives.map((a) => ({ ...a, availability: "verified" }));
    return structuredClone({ locations, archives, materials: [], operation });
  }
  w.unexpected.push(cmd);
  throw Error("Unexpected controlled IPC " + cmd);
};
await draftPersistence.load();
newConversationChoice.cwd = "/controlled/unrelated";
newConversationChoice.agentId = null;
composerDrafts.update("new", () => ({
  text: "KEEP_CONTROLLED_UNSENT_TEXT",
  attachments: [],
}));
const state = freshThreadState(key, "fixture", originalPath, "history");
state.title = row.title;
state.identity = "established";
state.items = [];
threads.getSnapshot().threads.set(key, state);
await draftPersistence.flush();
w.fixture = {
  mode: (v: string) => (mode = v),
  complete,
  releasePrepare: () => releasePrepare?.(),
  legacy: (v: boolean) => draftPersistence.lockInteraction(v),
  current: () => ({
    snapshot: worktrees.snapshot(),
    locked: !!draftPersistence.snapshot().interactionLocked,
    draft: composerDrafts.read("new"),
    cwd: newConversationChoice.cwd,
    historyCwd: state.cwd,
    request: worktreeManagement.snapshot(),
    calls: w.calls,
    unexpected: w.unexpected,
    settings: [...settings],
  }),
  unknownArchive: () => {
    locations = [adopted];
    archives = [{ ...archive, availability: "unknown" }];
    operation = null;
    return worktrees.load();
  },
  openManagement: () => worktreeManagement.open({ cwd: null, target: null }),
  query: () => worktrees.status(),
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
