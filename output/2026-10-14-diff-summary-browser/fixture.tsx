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

const w = window as any;
const clone = (value: any) => structuredClone(value);
const settings = new Map<string, any>();
const seed = w.fixtureSeed ?? {};
const held: { resolve: (value: any) => void; value: any }[] = [];
const mode: any = { hold: false, fail: false, changed: false };
const agent = {
  id: "comparison-fixture", name: "Controlled comparison Agent", source: "custom",
  command: "/controlled/never-executed", args: [], env: [], version: null,
  handshake: null, createdAt: 1, updatedAt: 1,
};
const rows = ["A", "B"].map((name, i) => ({
  id: "comparison-" + name, agentId: agent.id, cwd: "/controlled",
  nativeSessionId: "native-" + name, title: "P18_" + name, configOptions: null,
  pinned: false, archived: false, createdAt: 1, updatedAt: 10 - i,
}));
const long = Array.from({ length: 80 }, (_, i) => `line-${i + 1}`);
const cases: Record<string, { before: string | null; after: string; status?: string; input?: boolean }> = {
  replace: { before: "a\nb", after: "a\nc" },
  unchanged: { before: "a\nb", after: "a\nb" },
  missing: { before: null, after: "a\nb" },
  empty: { before: "", after: "a\nb" },
  whitespace: { before: "a\n \nz", after: "a\n\t\nz" },
  eof: { before: "a\nb", after: "a\nb\n" },
  shiftedEndings: { before: "a\nb", after: "X\na\r\nb" },
  unicode: { before: "é\n中\n😀", after: "é\n中\n🚀" },
  fallback: {
    before: Array.from({ length: 1100 }, (_, i) => `old-${i}`).join("\n"),
    after: Array.from({ length: 1100 }, (_, i) => `next-${i}`).join("\n"),
  },
  failed: { before: "a\nb", after: "a\nc", status: "failed" },
  input: { before: "a\nb", after: "a\nc", input: true, status: "failed" },
  pending: { before: "a\nb", after: "a\nc", status: "pending" },
  unknown: { before: "a\nb", after: "a\nc", status: "controlled-future-status" },
  long: {
    before: long.join("\n"),
    after: [...long.slice(0, 70), "P18_HIDDEN_NEEDLE", ...long.slice(71)].join("\n"),
  },
};
const selected = cases[seed.case ?? "replace"];
if (!selected) throw Error("Unknown controlled comparison case");
const path = "/controlled/result.txt";
const diskText = "CURRENT_DISK_CONTENT\nnot the reported fragment\n";
const bytes = new TextEncoder().encode(diskText);
const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
const file = { root: "/controlled", path, resolvedPath: path, name: "result.txt", size: bytes.length, sha256, version: "controlled-v1" };
const respond = async (value: any) => mode.hold
  ? await new Promise(resolve => held.push({ resolve, value: clone(value) }))
  : clone(value);
w.testInvoke = async (cmd: string, args: any) => {
  const { channel, ...captured } = args ?? {};
  w.calls.push({ cmd, args: clone(captured) });
  if (cmd === "settings_get") return args.key === "autoArchiveDays" ? 0 : (settings.get(args.key) ?? null);
  if (cmd === "settings_set") { settings.set(args.key, clone(args.value)); return; }
  if (cmd === "storage_recovery_status") return { ready: true, issue: null, dataDirectory: "/controlled/data", databaseReplacementAvailable: false, databaseReplacement: null };
  if (cmd === "app_initial_snapshot") return { agents: [agent], settings: {} };
  if (cmd === "app_default_working_directory") return "/controlled";
  if (cmd === "session_index_list") return clone(rows);
  if (["catalog_list", "catalog_scan", "credential_list", "desktop_notification_take_pending", "prompt_templates_list", "agent_status"].includes(cmd)) return [];
  if (["app_drafts_ready", "host_performance_sample", "session_mark_read", "session_index_mark_read", "plugin:event|unlisten"].includes(cmd)) return;
  if (cmd === "host_performance_origin") return null;
  if (cmd === "plugin:event|listen") return 1;
  if (cmd === "agent_work_get") return { cwd: args.cwd, enabled: {}, locationEnabled: true };
  if (cmd === "desktop_notifications_get") return { enabled: false, successEnabled: false, sound: false };
  if (cmd === "worktree_list") return { locations: [], archives: [], recoveries: [], materials: [], operation: null };
  if (cmd === "browser_share_status") return { taskKey: args.taskKey, label: args.label, agentId: agent.id, phase: "unshared", revision: 0, reason: null, pendingRequest: null };
  if (["file_delivery_inspect", "file_delivery_inspect_text", "file_delivery_inspect_selected"].includes(cmd)) {
    if (mode.fail) throw "文件已无法读取，请检查位置和访问权限";
    if (args.path !== path || (cmd === "file_delivery_inspect" && args.root !== "/controlled")) throw Error("Unexpected controlled file target");
    return respond({ ...file, ...(mode.changed ? { version: "controlled-v2" } : {}) });
  }
  if (["file_delivery_check_revision", "file_delivery_check_text_revision"].includes(cmd)) {
    if (mode.fail) throw { code: "missing" };
    return respond({ kind: "verified", file: { ...file, ...(mode.changed ? { version: "controlled-v2" } : {}) } });
  }
  if (cmd === "file_delivery_read_text") {
    if (mode.fail) throw { code: "missing" };
    return respond({ file: args.file, text: diskText });
  }
  w.unexpected.push(cmd);
  throw Error("Unexpected P18 controlled IPC " + cmd);
};
await draftPersistence.load();
newConversationChoice.cwd = null;
newConversationChoice.agentId = null;
const a = freshThreadState(rows[0].id, agent.id, "/controlled", "native-A");
a.identity = "established";
a.title = "P18_A";
if (seed.case === "pending") a.activeToolCallIds = ["comparison-one"];
a.items = [
  { kind: "user", id: "A-message", text: "P18_KEEP_MESSAGE", time: 1, streaming: false, attachments: [] },
  { kind: "tool", id: "A-tool", call: {
    toolCallId: "comparison-one", title: "P18_TOOL", kind: "edit", status: selected.status ?? "completed",
    startedAt: 2, endedAt: 3, locations: [],
    content: selected.input ? [] : [{ type: "diff", path, oldText: selected.before, newText: selected.after }],
    rawInput: selected.input ? { path, oldString: selected.before, newString: selected.after } : null,
  } },
];
const b = freshThreadState(rows[1].id, agent.id, "/controlled", "native-B");
b.identity = "established";
b.title = "P18_B";
b.items = [{ kind: "user", id: "B-message", text: "P18_OTHER_OWNER", time: 1, streaming: false, attachments: [] }];
threads.getSnapshot().threads.set(a.key, a);
threads.getSnapshot().threads.set(b.key, b);
composerDrafts.update("session:" + a.key, () => ({ text: "P18_KEEP_UNSENT", attachments: [] }));
fileFeedbackDrafts.update(a.key, "/controlled/other.txt", { text: "P18_KEEP_OTHER_FEEDBACK", selection: null });
await draftPersistence.flush();
const protectedValue = JSON.stringify({ draft: composerDrafts.read("session:" + a.key), opinion: fileFeedbackDrafts.read(a.key, "/controlled/other.txt") });
w.fixture = {
  current: () => ({
    calls: clone(w.calls), unexpected: clone(w.unexpected), held: held.length,
    copied: clone(w.copied), selectedCase: seed.case ?? "replace", source: clone(selected),
    protectedUnchanged: JSON.stringify({ draft: composerDrafts.read("session:" + a.key), opinion: fileFeedbackDrafts.read(a.key, "/controlled/other.txt") }) === protectedValue,
  }),
  mode: (next: any) => Object.assign(mode, next),
  release: () => { mode.hold = false; held.splice(0).forEach(item => item.resolve(item.value)); },
  changeReported: (before: string | null, after: string) => {
    const call = a.items[1].call;
    call.content = [{ type: "diff", path, oldText: before, newText: after }];
    (threads as any).emit();
  },
};
createRoot(document.getElementById("root")!).render(<StrictMode><StorageStartup><DraftStartup><App /></DraftStartup></StorageStartup></StrictMode>);
