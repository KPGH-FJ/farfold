import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { makePrototypeSnapshot } from "../src/prototype-persistence.js";
let server, App;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  App = (await server.ssrLoadModule("/src/AppV2.jsx")).default;
});
after(async () => {
  await server?.close();
});
function render(snapshot = null) {
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const media = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) =>
        key === "farfold-workbench-review-v6" ? JSON.stringify(snapshot) : null,
    },
  });
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  try {
    return renderToStaticMarkup(React.createElement(App));
  } finally {
    for (const [key, descriptor] of [
      ["localStorage", storage],
      ["matchMedia", media],
    ]) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
test("opening without saved data starts with discovery rather than preconnected sample Agents", () => {
  const html = render();
  assert.ok(!html.includes("切换评审场景"));
  assert.ok(html.includes("载入示例"));
  assert.ok(html.includes('aria-label="挑选 Agent"'));
  assert.ok(!html.includes('aria-label="发送新对话"'));
});
test("restart restores the scene and existing draft without inserting daily samples", () => {
  const html = render(
    makePrototypeSnapshot({
      scene: "first",
      tasks: [],
      groups: [],
      agents: [],
      services: [],
      view: "new",
      active: null,
      draft: {
        text: "保留这个首次草稿",
        files: [],
        folder: "",
        choice: { agent: "", model: "" },
      },
    }),
  );
  assert.ok(!html.includes("切换评审场景"));
  assert.ok(html.includes("载入示例"));
  assert.ok(html.includes("保留这个首次草稿"));
  assert.ok(html.includes('aria-label="挑选 Agent"'));
});
