import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { admittedConversation, makeAttempt } from "../src/workbench-state.js";

let server, NewConversation;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    cacheDir: "/tmp/farfold-new-conversation-review-cache",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  NewConversation = (await server.ssrLoadModule("/src/NewConversationV2.jsx"))
    .default;
});
after(async () => server?.close());
const base = {
  draft: "",
  files: [],
  folder: "",
  services: [],
  agents: [
    {
      name: "Codex",
      installed: true,
      connected: true,
      onboardingComplete: true,
      models: ["A"],
    },
  ],
  choice: {
    agent: "Codex",
    model: "A",
    source: "沿用已有设置",
    accessMode: "existing",
  },
};
const render = (props = {}) =>
  renderToStaticMarkup(
    React.createElement(NewConversation, { ...base, ...props }),
  );
const sendDisabled = (html) => {
  const button = html.match(/<button\b[^>]*aria-label="发送新对话"[^>]*>/)?.[0];
  assert.ok(button, "the prepared draft exposes its send action");
  return button.includes("disabled");
};

test("已有正文时不显示会替换草稿的灵感建议", () => {
  const html = render({ draft: "不能被建议覆盖的草稿" });
  assert.ok(html.includes("不能被建议覆盖的草稿"));
  assert.ok(!html.includes("计划一次旅行"));
  assert.ok(!html.includes("把想法写清楚"));
});
test("空草稿仍可使用灵感建议，发送保持禁用", () => {
  const html = render();
  assert.ok(html.includes("计划一次旅行"));
  assert.ok(sendDisabled(html));
});
test("只有附件可提交，但暂停与发送中仍保护原请求", () => {
  assert.equal(sendDisabled(render({ files: ["资料.md"] })), false);
  assert.equal(
    sendDisabled(render({ files: ["资料.md"], workEnabled: false })),
    true,
  );
  assert.equal(
    sendDisabled(render({ files: ["资料.md"], pending: true })),
    true,
  );
});
test("附件首条消息保留附件并生成可找回的标题，不编造用户文字", () => {
  const task = admittedConversation(
    makeAttempt({
      text: "",
      files: ["资料.md"],
      folder: "",
      choice: base.choice,
      outcome: "success",
      id: "attachment-only",
    }),
  );
  assert.equal(task.title, "资料.md");
  assert.equal(task.prompt, "");
  assert.deepEqual(task.sentAttachments, ["资料.md"]);
});
