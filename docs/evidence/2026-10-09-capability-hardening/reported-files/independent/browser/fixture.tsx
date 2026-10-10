import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "/src/App";
import { threads, freshThreadState } from "/src/runtime/sessions";
import { applyUpdate, applyTurnEnd } from "/src/runtime/session_projection";
import {
  composerDrafts,
  fileFeedbackDrafts,
  draftPersistence,
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

const key = "codex:/controlled:p19-list";
const title = "CONTROLLED_P19_REPORTED_FILES";
const path = "/controlled/report one.md";
const texts = {
  v1: "# Controlled report V1\n\nOnly synthetic P19 content.\n",
  v2: "# Controlled report V2\n\nChanged synthetic P19 content.\n",
};
const hash = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const hashes = { v1: await hash(texts.v1), v2: await hash(texts.v2) };
let version: keyof typeof texts = "v1";
let inspection: "ready" | "missing" | "pending" = "ready";
let pendingRelease: (() => void) | null = null;
const settings = new Map<string, unknown>();
const file = (requested = path, v = version) => ({
  root: "/controlled",
  path: requested,
  resolvedPath: requested.startsWith("/")
    ? requested
    : "/controlled/" + requested,
  name: requested.split("/").at(-1),
  size: new TextEncoder().encode(texts[v]).length,
  sha256: hashes[v],
  version: "controlled-p19-" + v,
});
const row = {
  id: key,
  agentId: "codex",
  cwd: "/controlled",
  nativeSessionId: "p19-list",
  title,
  configOptions: null,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: Date.now(),
};
(window as any).testInvoke = async (cmd: string, args: any) => {
  (window as any).calls.push({ cmd, args });
  if (cmd === "settings_get")
    return args.key === "autoArchiveDays"
      ? 0
      : (settings.get(args.key) ?? null);
  if (cmd === "settings_set") {
    settings.set(args.key, args.value);
    return;
  }
  if (
    [
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
  if (cmd === "app_default_working_directory") return "/controlled";
  if (cmd === "session_index_list") return [row];
  if (cmd === "agent_work_get")
    return {
      cwd: "/controlled",
      enabled: { codex: true },
      locationEnabled: true,
    };
  if (cmd === "browser_share_status")
    return {
      taskKey: args.taskKey,
      label: args.label,
      agentId: "codex",
      phase: "unshared",
      revision: 0,
      reason: null,
      pendingRequest: null,
    };
  if (cmd === "desktop_notifications_get")
    return { enabled: false, sound: false };
  if (
    cmd === "file_delivery_inspect" ||
    cmd === "file_delivery_inspect_selected"
  ) {
    const captured = file(args.path);
    if (inspection === "pending")
      await new Promise<void>((resolve) => {
        pendingRelease = resolve;
      });
    if (inspection === "missing") throw "文件不存在或无法访问";
    return captured;
  }
  if (cmd === "file_delivery_read_text") {
    const v =
      args.file.sha256 === hashes.v1
        ? "v1"
        : args.file.sha256 === hashes.v2
          ? "v2"
          : null;
    if (!v) throw { code: "changed" };
    return { file: args.file, text: texts[v] };
  }
  if (cmd === "file_delivery_check_revision")
    return args.file.sha256 === hashes[version]
      ? { kind: "hintUnchanged" }
      : { kind: "verified", file: file(args.file.path) };
  (window as any).unexpected.push(cmd);
  throw new Error("Unexpected controlled IPC " + cmd);
};
await draftPersistence.load();
const state = freshThreadState(key, "codex", "/controlled", "p19-list");
state.title = title;
state.identity = "established";
const emit = (toolCallId: string, fields: Record<string, unknown>) =>
  applyUpdate(state, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    ...fields,
  });
const resource = (uri: string) => ({
  type: "content",
  content: { type: "resource_link", name: "Controlled report", uri },
});
const finish = () => {
  applyTurnEnd(state, { stopReason: "end_turn" });
  const end = state.items.at(-1)!;
  state.roundItemBase = state.items.length;
  return end.id;
};
applyUpdate(state, {
  sessionUpdate: "user_message_chunk",
  content: { type: "text", text: "First controlled round, no actual Agent." },
});
emit("old-pending", {
  title: "OLD_PENDING",
  kind: "edit",
  status: "in_progress",
  locations: [{ path }],
});
emit("link-only", {
  title: "LINK_ONLY",
  kind: "other",
  status: "completed",
  content: [resource("file:///controlled/report%20one.md")],
});
const firstRound = finish();
applyUpdate(state, {
  sessionUpdate: "user_message_chunk",
  content: { type: "text", text: "Second controlled round, no actual Agent." },
});
emit("location-only", {
  title: "LOCATION_ONLY",
  kind: "edit",
  status: "completed",
  locations: [{ path: "/controlled/location-only.md" }],
});
emit("duplicate", {
  title: "SECOND_REPORT",
  kind: "edit",
  status: "completed",
  locations: [{ path }],
});
emit("diff", {
  title: "DIFFERENCE",
  kind: "edit",
  status: "completed",
  content: [
    {
      type: "diff",
      path: "/controlled/change.txt",
      oldText: "before",
      newText: "after",
    },
  ],
});
emit("command", {
  title: "CONTROLLED_OUTPUT",
  kind: "execute",
  status: "completed",
  rawOutput: "CONTROLLED_COMMAND_OUTPUT",
});
const secondRound = finish();
threads.getSnapshot().threads.set(key, state);
await threads.refreshIndex();
composerDrafts.update("session:" + key, () => ({
  text: "Existing controlled composer remains unsent. ".repeat(18),
  attachments: [],
}));
const notify = () => (threads as any).emit(key, true);
(window as any).fixture = {
  state,
  key,
  firstRound,
  secondRound,
  path,
  calls: () => (window as any).calls,
  fileCalls: () =>
    (window as any).calls.filter(
      (c: any) =>
        c.cmd.startsWith("file_") ||
        c.cmd.includes("opener") ||
        c.cmd === "session_prompt",
    ),
  feedback: () => fileFeedbackDrafts.entries(key),
  composer: () => composerDrafts.read("session:" + key),
  update: (id: string, fields: Record<string, unknown>) => {
    emit(id, fields);
    notify();
  },
  lateComplete: () => {
    emit("old-pending", { status: "completed" });
    notify();
  },
  retractOld: () => {
    emit("old-pending", { locations: [] });
    emit("link-only", { content: [] });
    notify();
  },
  addMany: () => {
    for (let i = 0; i < 56; i++)
      emit("paged-" + i, {
        title: "PAGED_" + i,
        kind: "edit",
        status: "completed",
        locations: [
          { path: "/controlled/page-" + String(i).padStart(2, "0") + ".md" },
        ],
      });
    notify();
  },
  setVersion: (value: keyof typeof texts) => {
    version = value;
  },
  setInspection: (value: typeof inspection) => {
    inspection = value;
  },
  releaseInspection: () => {
    pendingRelease?.();
    pendingRelease = null;
    inspection = "ready";
  },
  saveNow: () => draftPersistence.flush(),
  metrics: () => ({
    windowY: window.scrollY,
    appY: document.querySelector(".app")?.getBoundingClientRect().y,
    rootHeight: document.scrollingElement?.scrollHeight,
    viewportHeight: innerHeight,
    fileCalls: (window as any).calls.filter((c: any) =>
      c.cmd.startsWith("file_"),
    ).length,
  }),
};
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
