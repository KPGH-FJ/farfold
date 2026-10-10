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

import {
  searchLoadedConversations,
  loadedMarkdownFields,
} from "/src/runtime/loaded_search";
import { browserSurfaceGuard } from "/src/runtime/browser_surface";
const settings = new Map();
const keys = [
  "controlled-main",
  "controlled-other",
  "controlled-broken",
  "controlled-cold",
  "controlled-archived",
];
const rows = keys.map((id, i) => ({
  id,
  agentId: "codex",
  cwd: "/controlled",
  nativeSessionId: id,
  title: "CONTROLLED_SEARCH_" + i,
  configOptions: null,
  pinned: false,
  archived: i === 4,
  createdAt: 1,
  updatedAt: 100 - i,
}));
window.testInvoke = async (cmd, args) => {
  window.calls.push({ cmd, args });
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
  if (cmd === "session_index_list")
    return [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
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
  window.unexpected.push(cmd);
  throw Error("Unexpected controlled IPC " + cmd);
};
await draftPersistence.load();
const states = keys.map((key) =>
  freshThreadState(key, "codex", "/controlled", key),
);
for (const [i, state] of states.entries()) {
  state.title = rows[i].title;
  state.identity = "established";
}
const emit = (state, id, text, role = "agent") =>
  applyUpdate(state, {
    sessionUpdate: role + "_message_chunk",
    messageId: id,
    content: { type: "text", text },
  });
emit(states[0], "user-a", "USER_ONLY 😀 exact original content", "user");
for (let i = 0; i < 4; i++)
  applyUpdate(states[0], {
    sessionUpdate: "user_message_chunk",
    messageId: "user-a",
    content: {
      type: "resource",
      resource: {
        uri: "file:///must-never-read/" + i + ".txt",
        text:
          i === 3
            ? "FOURTH_ATTACHMENT precise folded text"
            : "FIRST_THREE ordinary " + i,
      },
    },
  });
for (let i = 0; i < 18; i++)
  emit(
    states[0],
    "padding-" + i,
    "Controlled padding paragraph " + i + ". ".repeat(200),
  );
emit(
  states[0],
  "agent-a",
  "Visible **bold** `code` &amp; [link label](https://invalid.example)\n\n|left|right|\n|-|-|\n|alpha|omega|\n\n```txt\nCODE_ONLY needle\n```\n\nTAIL_MATCH exacttarget",
);
applyUpdate(states[0], {
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text: "EXCLUDED_THOUGHT" },
});
applyUpdate(states[0], {
  sessionUpdate: "tool_call",
  toolCallId: "tool",
  title: "EXCLUDED_TOOL",
  content: [
    { type: "content", content: { type: "text", text: "EXCLUDED_TOOL" } },
  ],
});
emit(states[0], "entities", "Entity &amp; &notin; &notit; &semi; &#x1F600;");
applyTurnEnd(states[0], { stopReason: "end_turn" });
emit(states[0], "stream-tail", "TAIL_STREAM exacttarget");
emit(states[1], "same", "SECOND_THREAD target");
emit(states[2], "partial", "UNCONFIRMED_BODY target");
states[2].historyUnavailable = { reason: "incomplete", sourceKnown: true };
emit(states[4], "archived", "ARCHIVED_BODY target");
for (const i of [0, 1, 2, 4])
  threads.getSnapshot().threads.set(keys[i], states[i]);
await threads.refreshIndex();
composerDrafts.update("session:" + keys[0], () => ({
  text: "PRESERVED_UNSENT_TEXT",
  attachments: [],
}));
const notify = (state = states[0]) => threads.emit(state.key, true);
window.fixture = {
  keys,
  states,
  rows,
  searchLoadedConversations,
  loadedMarkdownFields,
  calls: () => window.calls,
  resetCalls: () => {
    window.calls.length = 0;
  },
  composer: () => composerDrafts.read("session:" + keys[0]),
  emit: (id, text) => {
    emit(states[0], id, text);
    notify();
  },
  changeBody: () => {
    emit(states[0], "stream-tail", " changed");
    notify();
  },
  budget: () => {
    emit(states[1], "too-large", "z".repeat(1048577));
    notify(states[1]);
  },
  async benchmark(size, count = 1) {
    const state = freshThreadState(
      "benchmark",
      "codex",
      "/controlled",
      "benchmark",
    );
    const text = "paragraph **bold** word\n\n".repeat(Math.floor(size / 25));
    for (let i = 0; i < count; i++) emit(state, "large" + i, text);
    let heartbeat = null;
    const abort = new AbortController();
    const start = performance.now();
    setTimeout(() => {
      heartbeat = performance.now() - start;
      abort.abort();
    }, 0);
    let result = null,
      error = null;
    try {
      result = await searchLoadedConversations(
        [state.key],
        new Map([[state.key, state]]),
        "absent-token",
        { signal: abort.signal },
      );
    } catch (e) {
      error = e.name;
    }
    const elapsed = performance.now() - start;
    await new Promise((r) => setTimeout(r, 0));
    return {
      characters: text.length,
      count,
      elapsed,
      heartbeat,
      error,
      matches: result?.matches,
      skipped: result?.skippedFields,
    };
  },
  async measuredBenchmark(size, count, abortOnPost = false) {
    const state = freshThreadState(
      "benchmark",
      "codex",
      "/controlled",
      "benchmark",
    );
    const text = "paragraph **bold** word\n\n".repeat(Math.floor(size / 25));
    for (let i = 0; i < count; i++) emit(state, "large" + i, text);
    const abort = new AbortController();
    let heartbeat = null,
      abortAt = null;
    const gaps = [];
    let previous = performance.now();
    const start = previous;
    const eventsAt = window.workerEvents.length;
    const interval = setInterval(() => {
      const now = performance.now();
      gaps.push(now - previous);
      previous = now;
    }, 16);
    setTimeout(() => (heartbeat = performance.now() - start), 0);
    window.afterWorkerPost = abortOnPost
      ? () => {
          window.afterWorkerPost = null;
          setTimeout(() => {
            abortAt = performance.now() - start;
            abort.abort();
          }, 0);
        }
      : null;
    let result = null,
      error = null;
    try {
      result = await searchLoadedConversations(
        [state.key],
        new Map([[state.key, state]]),
        "absent-token",
        { signal: abort.signal },
      );
    } catch (e) {
      error = e.name + ":" + e.message;
    }
    const elapsed = performance.now() - start;
    clearInterval(interval);
    window.afterWorkerPost = null;
    await new Promise((r) => setTimeout(r, 20));
    return {
      characters: text.length,
      count,
      elapsed,
      heartbeat,
      abortAt,
      error,
      matches: result?.matches,
      skipped: result?.skippedFields,
      maxTickGap: Math.max(0, ...gaps),
      ticks: gaps.length,
      workers: window.workerEvents.slice(eventsAt),
    };
  },
  longOther: () => {
    const s = freshThreadState(keys[1], "codex", "/controlled", keys[1]);
    s.identity = "established";
    const text = "paragraph **bold** word\n\n".repeat(Math.floor(262144 / 25));
    for (let i = 0; i < 8; i++) emit(s, "large" + i, text);
    states[1] = s;
    threads.getSnapshot().threads.set(keys[1], s);
    notify(s);
  },
  smallOther: () => {
    const s = freshThreadState(keys[1], "codex", "/controlled", keys[1]);
    s.identity = "established";
    emit(s, "same", "SECOND_THREAD target");
    states[1] = s;
    threads.getSnapshot().threads.set(keys[1], s);
    notify(s);
  },
  streamOther: () => {
    let n = 0;
    window.streamDone = false;
    const id = setInterval(() => {
      emit(states[1], "stream", " streamtick" + n);
      notify(states[1]);
      if (++n === 60) {
        clearInterval(id);
        window.streamDone = true;
      }
    }, 30);
  },
  streamTwo: () => {
    let n = 0;
    window.streamDone = false;
    const id = setInterval(() => {
      const i = n % 2;
      emit(states[i], "alternatingstream", " alternatingtick" + n);
      rows[i].updatedAt = 1000 + n;
      notify(states[i]);
      void threads.refreshIndex();
      if (++n === 60) {
        clearInterval(id);
        window.streamDone = true;
      }
    }, 30);
  },
  registerHeldSurface: () => {
    let resolve;
    const wait = new Promise((r) => (resolve = r));
    const registration = browserSurfaceGuard.register(
      () => wait,
      () => wait,
    );
    window.fixture.releaseSurface = () => {
      resolve();
      registration.release();
    };
  },
  metrics: () => ({
    windowY: scrollY,
    appY: document.querySelector(".app")?.getBoundingClientRect().y,
    documentHeight: document.scrollingElement?.scrollHeight,
    viewport: innerHeight,
  }),
};
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
