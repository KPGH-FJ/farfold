import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

let server, General, Life, Editor, updatePreviewIssue;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    cacheDir: "/tmp/farfold-settings-review-cache",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const generalModule = await server.ssrLoadModule("/src/SettingsGeneral.jsx");
  General = generalModule.default;
  updatePreviewIssue = generalModule.updatePreviewIssue;
  Life = (await server.ssrLoadModule("/src/SettingsLife.jsx")).default;
  Editor = (await server.ssrLoadModule("/src/SettingsApi.jsx")).ServiceEditor;
});
after(async () => server?.close());
const render = (Component, props = {}) =>
  renderToStaticMarkup(React.createElement(Component, props));

test("notification preview is interactive but explicit about system limits; shortcut customization remains unavailable", () => {
  const html = render(General, { theme: "light", setTheme() {} });
  assert.ok(html.includes("需要你时提醒"));
  assert.ok(html.includes("不请求系统权限、不播放声音、不发送桌面通知"));
  assert.equal((html.match(/role="switch"/g) || []).length, 2);
  assert.ok(html.includes("尚未请求"));
  assert.ok(html.includes("预览测试提醒"));
  assert.ok(html.includes("查看快捷键"));
  assert.ok(!html.includes("查看与自定义"));
  assert.ok(html.includes("⌘ K"));
});
test("LifeModel stays an explanation with no simulated collection or approval controls", () => {
  const html = render(Life);
  assert.ok(html.includes("当前尚未启用"));
  assert.ok(!html.includes("<button"));
  assert.ok(!html.includes('role="switch"'));
});
test("API editor accepts only a read-only demo key and separates save from test", () => {
  const html = render(Editor, { onSave() {}, onCancel() {} });
  assert.match(html, /readonly=""[^>]*aria-label="只读演示密钥"/i);
  assert.ok(html.includes("保存无需先测试"));
  assert.ok(html.includes("保存配置"));
  assert.ok(!html.includes('type="password"'));
});
test("a failed browser save blocks update completion even without an admitted conversation", () => {
  const issue = updatePreviewIssue({ tasks: [], storageIssue: true });
  assert.equal(issue.kind, "storage");
  assert.match(issue.message, /保留草稿/);
});
test("the save-failure demo and actual storage failure independently prevent update success", () => {
  assert.equal(updatePreviewIssue({ saveFailed: true }).kind, "storage");
  assert.equal(
    updatePreviewIssue({ storageIssue: true, saveFailed: false }).kind,
    "storage",
  );
  assert.equal(
    updatePreviewIssue({ storageIssue: false, saveFailed: true }).kind,
    "storage",
  );
  assert.equal(
    updatePreviewIssue({ storageIssue: false, saveFailed: false }),
    null,
  );
});
test("saved drafts do not block updates while work and queued messages still do", () => {
  const draft = {
    id: "draft",
    status: "done",
    draft: "保留这段文字",
    contentDrafts: { file: "待提交的意见" },
    queue: [],
  };
  assert.equal(updatePreviewIssue({ tasks: [draft] }), null);
  for (const status of [
    "approval",
    "question",
    "unknown",
    "submitting",
    "running",
  ])
    assert.equal(
      updatePreviewIssue({ tasks: [{ ...draft, status }] }).kind,
      "work",
    );
  assert.equal(
    updatePreviewIssue({ tasks: [{ ...draft, stopPhase: "unknown" }] }).kind,
    "work",
  );
  assert.equal(
    updatePreviewIssue({ tasks: [{ ...draft, queue: [{ text: "待发" }] }] })
      .kind,
    "work",
  );
});
