import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  OBSERVED_CONFIGURATION_SAMPLE,
  INTERACTIVE_CONFIGURATION_SAMPLE,
} from "../src/additional-configuration.js";
let server, ConfigurationOptions, ConversationConfiguration, NewConversation;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
    logLevel: "error",
  });
  ({ default: ConfigurationOptions } = await server.ssrLoadModule(
    "/src/ConfigurationOptions.jsx",
  ));
  ({ default: ConversationConfiguration } = await server.ssrLoadModule(
    "/src/ConversationConfiguration.jsx",
  ));
  ({ default: NewConversation } = await server.ssrLoadModule(
    "/src/NewConversationV2.jsx",
  ));
});
after(async () => server?.close());
const render = (options, props = {}) =>
  renderToStaticMarkup(
    React.createElement(ConfigurationOptions, { options, ...props }),
  );

test("实际组件将缺少说明、范围与时点标为未知，观测单值不渲染虚构开关", () => {
  const html = render(OBSERVED_CONFIGURATION_SAMPLE);
  assert.match(html, /Collaboration mode/);
  assert.match(html, /Fast mode/);
  assert.match(html, /作用对象/);
  assert.match(html, /生效时点/);
  assert.match(html, /不据名称推断行为、速度或费用/);
  assert.doesNotMatch(html, /<select|type="checkbox"/);
});

test("实际通用组件支持声明选项和未知类型共存，忙碌时保留旧值并禁用选择", () => {
  const html = render(INTERACTIVE_CONFIGURATION_SAMPLE, {
    savedValues: { "review-detail": "standard" },
    values: { "review-detail": "expanded" },
    disabled: true,
  });
  assert.match(html, /标准样例/);
  assert.match(html, /<select[^>]+disabled=""/);
  assert.match(html, /<option value="expanded" selected="">扩展样例/);
  assert.match(html, /此配置类型尚未支持编辑/);
  assert.equal((html.match(/<select/g) || []).length, 1);
});

test("同一配置入口覆盖首发前后，待确认状态保留可重新进入的设置按钮", () => {
  for (const [status, additionalOnly] of [
    ["draft", true],
    ["done", false],
  ]) {
    const html = renderToStaticMarkup(
      React.createElement(ConversationConfiguration, {
        task: {
          id: "sample",
          agent: "Example",
          model: "Model",
          status,
          configurationChange: { phase: "unknown" },
        },
        additionalOnly,
        onTaskChange() {},
      }),
    );
    assert.match(
      html,
      additionalOnly ? /查看和更改更多设置/ : /查看和更改对话设置/,
    );
    assert.doesNotMatch(html, /<button[^>]+disabled/);
  }
});

test("草稿设置未知时来源与位置不能变，Agent 暂不可用也保留设置核对入口", () => {
  const html = renderToStaticMarkup(
    React.createElement(NewConversation, {
      draft: "保留草稿",
      files: [],
      folder: "原位置",
      services: [],
      agents: [{ id: "a", name: "Example", installed: false }],
      choice: {
        agentId: "a",
        agent: "Example",
        model: "M",
        configurationChange: { phase: "unknown" },
      },
      setChoice() {},
      setDraft() {},
      setFiles() {},
      setFolder() {},
      onSend() {},
      onExplore() {},
    }),
  );
  assert.match(html, /查看和更改更多设置/);
  assert.match(html, /aria-label="选择 Agent" disabled=""/);
  assert.match(html, /aria-label="移除工作文件夹" disabled=""/);
  assert.match(html, /设置或发送待确认 · 草稿保留/);
  assert.doesNotMatch(html, /Enter 发送 · Shift Enter 换行/);
});
