import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "/src/App";
import { DraftStartup } from "/src/components/DraftStartup";
import { StorageStartup } from "/src/components/StorageRecovery";
import { threads, freshThreadState } from "/src/runtime/sessions";
import { composerDrafts, newConversationChoice, draftPersistence, fileFeedbackDrafts } from "/src/runtime/drafts";
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

import { controlledBrowser } from "./transport";
const w = window as any;
const clone = (value: any) => structuredClone(value);
const settings = new Map<string, any>();
const listeners = new Map<number, { event: string; handler: number }>();
let listenerId = 0;
const emit = (event: string, payload: unknown) => {
  for (const [id, item] of listeners) if (item.event === event) w.controlledCallback(item.handler, { event, id, payload: clone(payload) });
};
const browser = controlledBrowser(emit);
const agent = { id: "tabs-fixture", name: "Controlled tabs Agent", source: "custom", command: "/controlled/never-executed", args: [], env: [], version: null, handshake: null, createdAt: 1, updatedAt: 1 };
const rows = ["A", "B"].map((name, i) => ({ id: "tabs-" + name, agentId: agent.id, cwd: "/controlled", nativeSessionId: "native-" + name, title: "P30_TASK_" + name, configOptions: null, pinned: false, archived: false, createdAt: 1, updatedAt: 10 - i }));
w.testInvoke = async (cmd: string, args: any) => {
  const { channel, ...captured } = args ?? {};
  w.calls.push({ cmd, args: clone(captured) });
  if (cmd.startsWith("browser_workspace_") || cmd.startsWith("browser_share_")) return browser.invoke(cmd, args);
  if (cmd === "settings_get") return args.key === "autoArchiveDays" ? 0 : (settings.get(args.key) ?? null);
  if (cmd === "settings_set") { settings.set(args.key, clone(args.value)); return; }
  if (cmd === "storage_recovery_status") return { ready: true, issue: null, dataDirectory: "/controlled/data", databaseReplacementAvailable: false, databaseReplacement: null };
  if (cmd === "app_initial_snapshot") return { agents: [agent], settings: {} };
  if (cmd === "app_default_working_directory") return "/controlled";
  if (cmd === "session_index_list") return clone(rows);
  if (["catalog_list", "catalog_scan", "credential_list", "desktop_notification_take_pending", "prompt_templates_list", "agent_status"].includes(cmd)) return [];
  if (["app_drafts_ready", "host_performance_sample", "session_mark_read", "session_index_mark_read"].includes(cmd)) return;
  if (cmd === "host_performance_origin") return null;
  if (cmd === "plugin:event|listen") { const id = ++listenerId; listeners.set(id, { event: args.event, handler: args.handler }); return id; }
  if (cmd === "plugin:event|unlisten") { listeners.delete(args.eventId); return; }
  if (cmd === "agent_work_get") return { cwd: args.cwd, enabled: {}, locationEnabled: true };
  if (cmd === "desktop_notifications_get") return { enabled: false, successEnabled: false, sound: false };
  if (cmd === "worktree_list") return { locations: [], archives: [], recoveries: [], materials: [], operation: null };
  w.unexpected.push(cmd);
  throw Error("Unexpected controlled P30 IPC " + cmd);
};
await draftPersistence.load();
newConversationChoice.cwd = null;
newConversationChoice.agentId = null;
for (const [index, row] of rows.entries()) {
  const thread = freshThreadState(row.id, agent.id, "/controlled", row.nativeSessionId);
  thread.identity = "established";
  thread.title = row.title;
  thread.artifactPaneOpen = true;
  thread.items = [{ kind: "user", id: row.id + "-message", text: "P30_KEEP_MESSAGE_" + index, time: 1, streaming: false, attachments: [] }];
  threads.getSnapshot().threads.set(thread.key, thread);
  composerDrafts.update("session:" + thread.key, () => ({ text: "P30_KEEP_UNSENT_" + index, attachments: [] }));
}
fileFeedbackDrafts.update(rows[0].id, "/controlled/other.txt", { text: "P30_KEEP_OTHER_FEEDBACK", selection: null });
await draftPersistence.flush();
const protectedData = () => JSON.stringify({ drafts: rows.map(row => composerDrafts.read("session:" + row.id)), opinion: fileFeedbackDrafts.read(rows[0].id, "/controlled/other.txt") });
const protectedValue = protectedData();
w.fixture = {
  configure: browser.configure,
  release: browser.release,
  current: () => ({ ...browser.current(), calls: clone(w.calls), unexpected: clone(w.unexpected), protectedUnchanged: protectedData() === protectedValue, listeners: [...listeners.values()].map(item => item.event) }),
};
createRoot(document.getElementById("root")!).render(<StrictMode><StorageStartup><DraftStartup><App /></DraftStartup></StorageStartup></StrictMode>);
