import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

let server, Conversation;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    cacheDir: "/tmp/farfold-stop-feedback-cache",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  Conversation = (await server.ssrLoadModule("/src/Conversation.jsx")).default;
});
after(async () => server?.close());

const render = (stopPhase) =>
  renderToStaticMarkup(
    React.createElement(Conversation, {
      task: {
        id: "stop-feedback",
        title: "停止反馈检查",
        agent: "Codex",
        model: "original-model",
        status: "approval",
        stopPhase,
        draft: "保留的独立草稿",
        queue: [{ id: "queued", text: "保留的待发消息" }],
        queuePaused: true,
      },
      onTaskChange: () => {},
    }),
  );

for (const [phase, label] of [
  ["waiting", "等待停止确认"],
  ["unknown", "停止结果未知"],
  ["failed", "停止请求未发送"],
]) {
  test(`${phase}: 停止状态在固定输入区显示，未发送内容保留`, () => {
    const html = render(phase);
    const inputArea = html.slice(html.indexOf('class="conv-composer-area"'));
    assert.ok(inputArea.includes(label));
    assert.match(inputArea, /role="status"[^>]*aria-label="停止确认状态"/);
    assert.equal((html.match(/aria-label="停止确认状态"/g) || []).length, 1);
    assert.ok(inputArea.includes("保留的独立草稿"));
    assert.ok(inputArea.includes("保留的待发消息"));
    if (phase === "waiting") {
      assert.match(html, /正在等待停止确认，原审批保留且暂不能操作/);
      assert.doesNotMatch(html, /class="badge amber">需要批准</);
      assert.match(html, /class="badge amber">等待停止确认</);
    }
    const stopButton = inputArea.match(
      /<button[^>]*class="[^"]*conv-stop[^>]*>[\s\S]*?<\/button>/,
    )?.[0];
    if (phase !== "unknown") {
      assert.ok(stopButton);
      assert.equal(stopButton.includes("disabled"), phase === "waiting");
      assert.ok(
        stopButton.includes(phase === "waiting" ? "停止中" : "重试停止"),
      );
    }
    if (phase === "unknown") {
      assert.ok(!stopButton);
      assert.match(inputArea, /检查停止结果/);
      assert.ok(!inputArea.includes("停止中"));
      assert.match(
        inputArea,
        /<button[^>]*aria-label="加入待发"[^>]*disabled=""/,
      );
    }
  });
}

test("没有停止请求时保持正常停止操作，不显示恢复提示", () => {
  const html = render(null);
  assert.ok(!html.includes('aria-label="停止确认状态"'));
  assert.ok(!html.includes("重试停止"));
});
