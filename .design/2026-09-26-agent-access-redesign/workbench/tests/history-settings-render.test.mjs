import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { archiveReviewTasks } from "./fixtures/archive-review-tasks.js";
let server, Library, Sidebar, General;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    cacheDir: "/tmp/farfold-history-settings-cache",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  Library = (await server.ssrLoadModule("/src/ConversationLibrary.jsx"))
    .default;
  Sidebar = (await server.ssrLoadModule("/src/SidebarV2.jsx")).default;
  General = (await server.ssrLoadModule("/src/SettingsGeneral.jsx")).default;
});
after(async () => {
  await server?.close();
});
const render = (Component, props) =>
  renderToStaticMarkup(React.createElement(Component, props));
const noop = () => {};
const fixture = {
  id: "c",
  title: "原对话",
  status: "done",
  agent: "Codex",
  group: "写作",
  queue: [],
  lastActivityAt: Date.now() - 40 * 86400000,
};

test("library title and selectors show the same Agent and group state", () => {
  const html = render(Library, {
    tasks: [fixture],
    groups: ["写作"],
    filters: { agent: "Codex", group: "写作", state: "all" },
    setFilters: noop,
  });
  assert.ok(html.includes("Codex · 写作</h1>"));
  assert.ok(html.includes('<option selected="">Codex</option>'));
  assert.ok(html.includes("当前筛选"));
  assert.ok(html.includes("原对话"));
  assert.ok(html.includes("清除筛选"));
});

test("unknown archived work remains in the attention list", () => {
  const html = render(Library, {
    tasks: [{ ...fixture, archived: true, status: "unknown" }],
    groups: [],
    filters: { state: "needs" },
    setFilters: noop,
  });
  assert.ok(html.includes("原对话"));
  assert.ok(html.includes("需要你"));
});

test("imported history does not hide a recovery requirement behind its imported badge", () => {
  const html = render(Library, {
    tasks: [
      { ...fixture, imported: true, status: "unknown", extraMessages: [] },
    ],
    groups: [],
    filters: { state: "needs" },
    setFilters: noop,
  });
  assert.match(html, /需要你/);
  assert.doesNotMatch(html, />已带入</);
});

test("sidebar highlights the one effective Agent condition even in favorites", () => {
  const html = render(Sidebar, {
    tasks: [fixture],
    agents: [{ id: "c", name: "Codex", added: true }],
    groups: ["写作"],
    view: "starred",
    filters: { agent: "Codex", group: "写作" },
  });
  assert.equal((html.match(/v2-nav v2-sub selected/g) || []).length, 2);
});

test("automatic archive exposes its retention, timestamp, restore and demonstration boundaries", () => {
  const html = render(General, {
    theme: "light",
    toast: noop,
    tasks: archiveReviewTasks(),
    archiveDays: "30",
    onArchiveDaysChange: noop,
    onRunArchive: noop,
    onOpenArchived: noop,
  });
  assert.ok(html.includes("当前有 1 段对话符合条件"));
  assert.ok(html.includes("重启后保持"));
  assert.ok(html.includes("重新等待完整的归档期限"));
  assert.ok(html.includes("最后活动时间未知"));
  assert.ok(html.includes("不会改变正式应用中的对话"));
  assert.ok(html.includes("查看已归档"));
  const action = html.match(/<button[^>]*>现在整理<\/button>/)?.[0];
  assert.ok(action && !action.includes("disabled"));
});

test("disabled auto archive cannot organize and tells users existing archives stay", () => {
  const html = render(General, {
    theme: "light",
    toast: noop,
    tasks: [fixture],
    archiveDays: "0",
    onArchiveDaysChange: noop,
    onRunArchive: noop,
  });
  assert.ok(html.includes("已归档的对话保持原位"));
  assert.ok(html.match(/<button[^>]*disabled=""[^>]*>现在整理<\/button>/));
});
