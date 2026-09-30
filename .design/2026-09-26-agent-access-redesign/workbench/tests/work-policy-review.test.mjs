import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

let server, sendingScopes, WorkPolicyDialog, General;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    cacheDir: "/tmp/farfold-work-policy-review-cache",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  ({ sendingScopes, default: WorkPolicyDialog } = await server.ssrLoadModule(
    "/src/WorkPolicyDialog.jsx",
  ));
  General = (await server.ssrLoadModule("/src/SettingsGeneral.jsx")).default;
});
after(async () => server?.close());

test("没有对话的已暂停位置仍有恢复入口，不因删除最后一条对话而丢失", () => {
  const props = {
    modal: "work-policy",
    tasks: [],
    workPolicies: { "/projects/removed-last-task": false },
  };
  const scopes = sendingScopes(props);
  assert.deepEqual(
    scopes.map((scope) => scope.location),
    ["普通对话", "/projects/removed-last-task"],
  );
  const html = renderToStaticMarkup(
    React.createElement(WorkPolicyDialog, props),
  );
  assert.match(html, /aria-label="恢复发送 \/projects\/removed-last-task"/);
});

test("影响范围合并当前草稿、对话与历史位置，并区分普通聊天", () => {
  const tasks = [
    { id: "plain", title: "普通聊天" },
    { id: "one", title: "当前项目", folder: "/project/a" },
    { id: "two", title: "项目归档", folder: "/project/a", archived: true },
    { id: "other", title: "另一项目", folder: "/project/b" },
  ];
  const scopes = sendingScopes({
    folder: "/project/a",
    tasks,
    workPolicies: { "/project/a": false, "/project/old": true },
  });
  assert.equal(
    scopes.filter((scope) => scope.location === "/project/a").length,
    1,
  );
  assert.deepEqual(
    scopes.find((scope) => scope.currentDraft)?.tasks.map((task) => task.id),
    ["one", "two"],
  );
  assert.deepEqual(
    scopes[0].tasks.map((task) => task.id),
    ["plain"],
  );
  assert.equal(scopes[0].currentDraft, false);
  assert.ok(scopes.some((scope) => scope.location === "/project/old"));
});

test("消息发送控制只在设置高级折叠区提供入口，不冒充 Agent 权限", () => {
  const html = renderToStaticMarkup(
    React.createElement(General, {
      theme: "light",
      onManageSending: () => {},
    }),
  );
  assert.match(html, /<details><summary[^>]*>高级<\/summary>/);
  assert.match(html, /暂停消息发送/);
  assert.ok(!html.includes("工作权限"));
  assert.ok(!html.includes("由 Farfold 为普通对话准备的固定位置"));
});
