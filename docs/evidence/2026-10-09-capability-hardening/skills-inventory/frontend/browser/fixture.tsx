import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "/src/App";
import { DraftStartup } from "/src/components/DraftStartup";
import { StorageStartup } from "/src/components/StorageRecovery";
import {
  draftPersistence,
  composerDrafts,
  newConversationChoice,
} from "/src/runtime/drafts";
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
const settings = new Map<string, unknown>();
const agents = ["a", "b"].map((id) => ({
  id: `fixture-${id}`,
  name: `Controlled ${id.toUpperCase()}`,
  source: "custom",
  command: "/controlled/never-executed",
  args: [],
  env: [["CONTROLLED_VALUE", "A"]],
  version: null,
  handshake: null,
  createdAt: 1,
  updatedAt: 1,
}));
const listeners = new Map<number, { event: string; handler: number }>();
let nextListener = 1,
  nextTicket = 1;
let capabilityMode = "available";
let heldCapabilities: { resolve: (v: unknown) => void; agentId: string }[] = [];
let chooser: ((v: string | null) => void) | null = null;
const queries = new Map<string, any>();
let cancelNull = false,
  readRefusal: string | null = null;
const capability = () => ({
  selectionId:
    capabilityMode === "available"
      ? `bbbbbbbb-bbbb-bbbb-bbbb-${String(nextTicket++).padStart(12, "0")}`
      : null,
  mcpInventory: {
    availability: capabilityMode === "available" ? "available" : "unavailable",
    source: capabilityMode === "available" ? "officialCli" : null,
    reason: capabilityMode === "available" ? null : capabilityMode,
  },
  skillsInventory: {
    availability: capabilityMode === "available" ? "available" : "unavailable",
    source: capabilityMode === "available" ? "officialAppServer" : null,
    reason: capabilityMode === "available" ? null : capabilityMode,
  },
  toolInventory: "unavailable",
});
function op(q: any, patch: any = {}) {
  return {
    agentId: q.agentId,
    requestId: q.requestId,
    cwd: q.cwd,
    kind: q.kind,
    state: "running",
    settled: false,
    ...patch,
  };
}
function snapshot(name = "Fixture MCP", count = 1) {
  return {
    observedAtMs: 1791605000000,
    source: "officialCli",
    scope: "officialCliConfigurationForDirectory",
    complete: true,
    sessionApplicability: "unverified",
    items: Array.from({ length: count }, (_, id) => ({
      id,
      name: id === 1 ? null : `${name} ${id}`,
      transport: "stdio",
      reportedEnabled: id % 2 === 0,
      reportedAuth: "notLoggedIn",
      origin: "unreported",
      configurationLayer: "unreported",
      connection: "unverified",
      tools: "unreported",
    })),
  };
}
w.testInvoke = async (cmd: string, args: any) => {
  w.calls.push({ cmd, args: args ? { ...args, channel: undefined } : args });
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
  if (cmd === "app_initial_snapshot")
    return { agents: structuredClone(agents), settings: {} };
  if (cmd === "app_default_working_directory") return "/controlled/project-A";
  if (
    [
      "session_index_list",
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
  if (cmd === "plugin:event|listen") {
    const id = nextListener++;
    listeners.set(id, args);
    return id;
  }
  if (cmd === "agent_work_get")
    return { cwd: args.cwd, enabled: {}, locationEnabled: true };
  if (cmd === "desktop_notifications_get")
    return { enabled: false, sound: false };
  if (cmd === "worktree_list")
    return {
      locations: [],
      archives: [],
      recoveries: [],
      materials: [],
      operation: null,
    };
  if (cmd === "service_capabilities")
    return { apiTypes: [], customService: false };
  if (cmd === "agent_extension_capabilities") {
    if (capabilityMode === "hold")
      return new Promise((resolve) =>
        heldCapabilities.push({ resolve, agentId: args.agentId }),
      );
    return capability();
  }
  if (cmd === "agent_extension_inventory_read") {
    if (
      !["mcp", "skills"].includes(args.kind) ||
      !args.selectionId ||
      queries.has(args.requestId)
    )
      throw Error("missing ticket or duplicate query");
    if (readRefusal) throw { code: readRefusal };
    return new Promise((resolve, reject) =>
      queries.set(args.requestId, {
        ...args,
        resolve,
        reject,
        status: op(args),
      }),
    );
  }
  if (cmd === "agent_extension_inventory_status") {
    const q = queries.get(args.requestId);
    if (!q || q.absent || q.agentId !== args.agentId)
      throw { code: "unknownRequest" };
    return q.status;
  }
  if (cmd === "agent_extension_inventory_cancel") {
    const q = queries.get(args.requestId);
    return {
      agentId: args.agentId,
      requestId: args.requestId,
      cancelRequested: true,
      operation: cancelNull
        ? null
        : q
          ? op(q, { state: "cancelling", code: "cancelled" })
          : null,
    };
  }
  if (cmd === "plugin:dialog|open")
    return new Promise((resolve) => {
      chooser = resolve;
    });
  w.unexpected.push(cmd);
  throw Error("Unexpected controlled IPC " + cmd);
};
await draftPersistence.load();
composerDrafts.update("new", () => ({
  text: "KEEP P39 DRAFT",
  attachments: [],
}));
newConversationChoice.cwd = "/controlled/project-A";
await draftPersistence.flush();
w.fixture = {
  current: () => ({
    calls: w.calls,
    unexpected: w.unexpected,
    queries: [...queries.values()].map(({ resolve, reject, ...q }) => q),
    draft: composerDrafts.read("new"),
    cwd: newConversationChoice.cwd,
    held: heldCapabilities.length,
  }),
  choose: (path: string | null) => {
    if (!chooser) throw Error("no chooser");
    const r = chooser;
    chooser = null;
    r(path);
  },
  skills: (id: string, errors = 0, count = 3) => {
    const q = queries.get(id);
    q.status = op(q, {
      state: "ready",
      settled: true,
      snapshot: {
        observedAtMs: 1791606000000,
        source: "officialAppServer",
        scope: "officialSkillsForDirectory",
        complete: errors === 0,
        sessionApplicability: "unverified",
        errorCount: errors,
        items: Array.from({ length: count }, (_, id) => ({
          id,
          name: id === 1 ? null : "Same Skill",
          description:
            '<a href="https://example.invalid">PLAIN</a>\n[Markdown](https://example.invalid)',
          descriptionTruncated: true,
          descriptionRedacted: true,
          reportedEnabled: id % 2 === 0,
          origin: id === 0 ? "repo" : "user",
          pluginReported: true,
        })),
      },
    });
    q.resolve(q.status);
  },
  finish: (id: string, name = "Fixture MCP", count = 1) => {
    const q = queries.get(id);
    q.status = op(q, {
      state: "ready",
      settled: true,
      snapshot: snapshot(name, count),
    });
    q.resolve(q.status);
  },
  fail: (id: string, code = "queryFailed") => {
    const q = queries.get(id);
    q.status = op(q, { state: "failed", settled: true, code });
    q.resolve(q.status);
  },
  terminal: (id: string) => {
    const q = queries.get(id);
    q.status = op(q, { state: "cancelled", settled: true, code: "cancelled" });
    q.resolve(q.status);
  },
  pending: (id: string) => {
    const q = queries.get(id);
    q.status = op(q, { state: "pendingCleanup", code: "pendingCleanup" });
    q.resolve(q.status);
  },
  malformed: (id: string) => {
    const q = queries.get(id);
    q.resolve(
      op(q, {
        state: "ready",
        settled: true,
        snapshot: { ...snapshot(), env: "CONTROLLED_SECRET_CANARY" },
      }),
    );
  },
  absent: (id: string) => {
    queries.get(id).absent = true;
  },
  cancelNull: (value: boolean) => {
    cancelNull = value;
  },
  refusal: (value: string | null) => {
    readRefusal = value;
  },
  capability: (value: string) => {
    capabilityMode = value;
  },
  releaseCapabilities: () => {
    capabilityMode = "available";
    for (const q of heldCapabilities) q.resolve(capability());
    heldCapabilities = [];
  },
  update: (id: string, value: string) => {
    const row = agents.find((a) => a.id === id)!;
    row.env[0][1] = value;
    row.updatedAt++;
    for (const l of listeners.values())
      if (l.event === "catalog:updated")
        w.callbacks.get(l.handler)?.({ event: l.event, payload: null });
  },
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
