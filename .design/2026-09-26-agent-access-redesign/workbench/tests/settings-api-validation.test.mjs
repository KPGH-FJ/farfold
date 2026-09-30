import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import {
  apiEndpointIssue,
  changeApiDraft,
  confirmDemoKey,
  initialApiDraft,
} from "../src/api-editor-state.js";

let server, Editor;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    cacheDir: "/tmp/farfold-api-validation-cache",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  Editor = (await server.ssrLoadModule("/src/SettingsApi.jsx")).ServiceEditor;
});
after(async () => server?.close());

const service = {
  id: "travel",
  name: "旅行服务测试",
  endpoint: "https://api.example.com/v1",
  format: "responses",
  models: ["travel-demo"],
  demoKey: true,
};
const render = (overrides = {}) =>
  renderToStaticMarkup(
    React.createElement(Editor, {
      service: { ...service, ...overrides },
      onSave() {},
      onCancel() {},
    }),
  );
const endpointInput = (html) => html.match(/<input[^>]*type="url"[^>]*>/)?.[0];
const saveButton = (html) => html.match(/<button[^>]*>保存配置<\/button>/)?.[0];
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const endpoint of [
  "api.example.com/v1",
  "https://",
  "http://api.example.com/v1",
  "https://api.example.com/v1/responses",
]) {
  test(`invalid address explains the same blocking rule beside the field: ${endpoint}`, () => {
    const html = render({ endpoint });
    const input = endpointInput(html);
    assert.match(input, /aria-invalid="true"/);
    const descriptionIds = input.match(/aria-describedby="([^"]+)"/)?.[1].split(" ");
    assert.ok(descriptionIds?.length);
    const issue = apiEndpointIssue(endpoint);
    assert.ok(
      descriptionIds.some((id) =>
        new RegExp(`id="${escaped(id)}"[^>]*>${escaped(issue)}<`).test(html),
      ),
      "the field must refer to the visible validation message",
    );
    assert.match(saveButton(html), /disabled=""/);
  });
}

test("an empty address is explained in the field hint and beside the disabled save action", () => {
  const html = render({ endpoint: "" });
  assert.ok(html.includes("填写完整的 HTTPS 基础地址"));
  const save = saveButton(html);
  assert.match(save, /disabled=""/);
  const description = save.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(description);
  assert.match(
    html,
    new RegExp(`id="${escaped(description)}"[^>]*>[\\s\\S]*?${escaped(apiEndpointIssue(""))}`),
  );
});

test("correcting the address clears its error but still explains the cleared key before saving", () => {
  const corrected = changeApiDraft(
    initialApiDraft({ ...service, endpoint: "api.example.com/v1" }),
    "endpoint",
    service.endpoint,
  );
  const html = render(corrected);
  assert.doesNotMatch(endpointInput(html), /aria-invalid="true"/);
  assert.match(saveButton(html), /disabled=""/);
  assert.ok(html.includes("请为当前地址和接口选择演示密钥。"));

  const ready = render(confirmDemoKey(corrected));
  assert.doesNotMatch(saveButton(ready), /disabled/);
  assert.doesNotMatch(endpointInput(ready), /aria-invalid="true"/);
  assert.ok(ready.includes("保存无需先测试"));
  assert.ok(!ready.includes("此模型的演示响应完整"));
});

test("the disabled save action explains the next missing name, key or model condition", () => {
  for (const [changes, reason] of [
    [{ name: "" }, "请填写不超过 160 字的配置名称。"],
    [{ name: "x".repeat(161) }, "请填写不超过 160 字的配置名称。"],
    [{ demoKey: false }, "请为当前地址和接口选择演示密钥。"],
    [{ models: [] }, "请至少添加一个有效模型 ID。"],
  ]) {
    const html = render(changes);
    assert.match(saveButton(html), /disabled=""/);
    assert.ok(html.includes(reason));
  }
});
