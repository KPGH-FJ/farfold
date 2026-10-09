import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "/src/App";
import { threads, freshThreadState } from "/src/runtime/sessions";
import { composerDrafts, draftPersistence } from "/src/runtime/drafts";
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
const key = "codex:/controlled:scroll-fixture";
const title = "CONTROLLED_SCROLL_LAYOUT";
const params = new URLSearchParams(location.search);
const small = params.get("scenario") === "short";
const smallText = "受控短文本第一行。\r\n第二行文字结束。";
const file = {
  root: "/controlled",
  path: "/controlled/selected-large.txt",
  resolvedPath: "/controlled/selected-large.txt",
  name: "selected-large.txt",
  size: small ? new TextEncoder().encode(smallText).length : 2097152,
  sha256: "a".repeat(64),
  version: "controlled-v1",
};
const row = {
  id: key,
  agentId: "codex",
  cwd: "/controlled",
  nativeSessionId: "scroll-fixture",
  title,
  configOptions: null,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: Date.now(),
};
(window as any).testInvoke = async (cmd: string, args: any) => {
  (window as any).calls.push(cmd);
  if (cmd === "settings_get") return args.key === "autoArchiveDays" ? 0 : null;
  if (
    [
      "settings_set",
      "host_performance_sample",
      "session_mark_read",
      "session_index_mark_read",
    ].includes(cmd)
  )
    return;
  if (cmd === "host_performance_origin") return null;
  if (cmd === "plugin:event|listen") return 1;
  if (cmd === "plugin:event|unlisten") return;
  if (cmd === "app_initial_snapshot") return { agents: [], settings: {} };
  if (
    [
      "catalog_list",
      "catalog_scan",
      "credential_list",
      "desktop_notification_take_pending",
      "prompt_templates_list",
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
  if (cmd === "agent_status") return [];
  if (cmd === "desktop_notifications_get")
    return { enabled: false, sound: false };
  if (
    cmd === "file_delivery_inspect" ||
    cmd === "file_delivery_inspect_selected"
  )
    return file;
  if (cmd === "file_delivery_read_text") return { file, text: smallText };
  if (cmd === "file_delivery_check_revision") return { kind: "hintUnchanged" };
  if (cmd === "file_delivery_read_text_block") {
    const i = args.blockIndex;
    const text =
      i === 1 ? "中🙂END\r\n" + "x".repeat(131072 - 12) : "x".repeat(131072);
    return {
      file,
      blockIndex: i,
      blockCount: 16,
      text,
      byteStart: i * 131072,
      byteEnd: (i + 1) * 131072,
      startLine: i === 0 ? 1 : i === 1 ? 1 : 2,
      endLine: i === 0 ? 1 : 2,
      startsMidLine: i > 0,
      endsMidLine: true,
    };
  }
  (window as any).unexpected.push(cmd);
  throw new Error("Unexpected controlled IPC " + cmd);
};
await draftPersistence.load();
const state = freshThreadState(key, "codex", "/controlled", "scroll-fixture");
state.title = title;
state.identity = "established";
state.items = [
  {
    id: "reply",
    kind: "agent",
    text: "[大文本选段](/controlled/selected-large.txt)",
    streaming: false,
    time: Date.now(),
  },
];
threads.getSnapshot().threads.set(key, state);
await threads.refreshIndex();
if (params.get("candidate") === "block-scroll") {
  const css = document.createElement("style");
  css.textContent = ".text-block-preview { min-height: 0; overflow: auto; }";
  document.head.append(css);
}
const length = Number(params.get("length") ?? 640);
composerDrafts.update("session:" + key, () => ({
  text: "原有受控输入内容保持不发送。"
    .repeat(Math.ceil(length / 14))
    .slice(0, length),
  attachments: [],
}));
function metrics() {
  const selectors = [
    "html",
    "body",
    "#root",
    ".app",
    ".body-row",
    ".product-sidebar",
    ".product-brand",
    ".workspace-thread",
    ".thread-body",
    ".thread-main",
    ".workspace-topbar",
    ".transcript",
    ".composer-wrap",
    ".composer",
    ".c-input",
    ".artifact-pane",
    ".artifact-opened-file-body",
    ".file-artifact-view",
    ".text-block-preview",
    ".source-text-selection",
    ".source-text-selection-controls",
    ".text-block-content",
  ];
  const elements = Object.fromEntries(
    selectors.map((s) => {
      const e =
        [...document.querySelectorAll<HTMLElement>(s)].find(
          (e) => e.getBoundingClientRect().height > 0,
        ) ?? null;
      if (!e) return [s, null];
      const r = e.getBoundingClientRect(),
        c = getComputedStyle(e);
      return [
        s,
        {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          scrollTop: e.scrollTop,
          scrollHeight: e.scrollHeight,
          clientHeight: e.clientHeight,
          overflowX: c.overflowX,
          overflowY: c.overflowY,
          minHeight: c.minHeight,
          flex: c.flex,
          position: c.position,
        },
      ];
    }),
  );
  return {
    windowY: window.scrollY,
    visualViewport: window.visualViewport
      ? {
          offsetTop: window.visualViewport.offsetTop,
          pageTop: window.visualViewport.pageTop,
          height: window.visualViewport.height,
        }
      : null,
    scrollingTag: document.scrollingElement?.tagName,
    active: document.activeElement?.outerHTML.slice(0, 240),
    elements,
  };
}
const events: any[] = [];
for (const t of ["scroll", "focusin", "focusout"])
  document.addEventListener(
    t,
    (e) => {
      events.push({
        t,
        target:
          e.target instanceof Element
            ? e.target.tagName + ":" + e.target.className
            : "document",
        windowY: window.scrollY,
        rootTop: document.querySelector(".app")?.getBoundingClientRect().top,
      });
    },
    true,
  );
(window as any).fixture = {
  metrics,
  events,
  state,
  sourceLength: length,
  composer: () => composerDrafts.read("session:" + key),
  clearEvents: () => events.splice(0),
  applyStyle: (css: string) => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
  },
};
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
