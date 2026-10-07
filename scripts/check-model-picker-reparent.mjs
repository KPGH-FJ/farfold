// Headless browser regression using the production picker and CSS. Pass an
// already installed Playwright module and browser executable; installs nothing.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createServer } from "vite";

const [playwrightModule, executablePath] = process.argv.slice(2);
if (!playwrightModule || !executablePath)
  throw new Error("Expected Playwright module path and browser executable");
const { chromium } = await import(
  pathToFileURL(resolve(playwrightModule)).href
);
const entry = "/__picker-reparent-fixture.jsx";
const fixture = `
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { NewConversationModelDialog } from "/src/components/NewConversationPickers.tsx";
const agent = { id: "fixture", name: "Fixture", status: "connected" };
function App() {
  const [host] = useState(() => document.createElement("div"));
  const [opened, setOpened] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const [pending, setPending] = useState(false);
  const opener = useRef(null);
  const first = useRef(null);
  const second = useRef(null);
  useEffect(() => {
    (prepared ? second.current : first.current).appendChild(host);
  }, [host, prepared]);
  useEffect(() => {
    window.fixture = {
      completePreparation: () => setPrepared(true),
      moveBack: () => setPrepared(false),
      pendingApply: () => setPending(true),
      applications: [],
      host,
    };
  }, [host]);
  const options = prepared ? {
    id: "model", type: "select", name: "Model", category: "model",
    currentValue: "model-250",
    options: Array.from({length: 475}, (_, i) => ({value: "model-"+i, name: "Model "+i})),
  } : null;
  return <>
    <button id="background">Background action</button>
    <div ref={first} id="draft-home" />
    <div ref={second} id="prepared-thread" />
    {createPortal(<>
      <textarea aria-label="Draft" defaultValue="retained draft" />
      <button ref={opener} onClick={() => setOpened(true)}>Open model picker</button>
      {opened && <NewConversationModelDialog
        agent={agent} value={{service:null,modelValue:null}}
        existingOption={options} readingModels={!prepared}
        returnFocusRef={opener} onPrepare={() => {}}
        onClose={() => setOpened(false)}
        onApply={async choice => {
          window.fixture.applications.push(choice);
          if (pending) await new Promise(resolve => window.fixture.finishApply = resolve);
        }}
      />}
    </>, host)}
  </>;
}
createRoot(document.getElementById("fixture")).render(<App />);
`;
const server = await createServer({
  root: resolve(import.meta.dirname, ".."),
  configFile: false,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "picker-reparent-fixture",
      enforce: "pre",
      resolveId(id) {
        if (id === entry) return entry;
      },
      load(id) {
        if (id === entry) return fixture;
        if (id.endsWith("/src/runtime/credentials.ts"))
          return `export const listCredentials = async () => [];
            export const getServiceCapabilities = async () => ({apiTypes:[]});
            export const subscribeCredentialChanges = () => () => {};`;
        if (id.endsWith("/src/runtime/agents.ts"))
          return `export const agentIdentity = () => ({letter:"F", cls:"fixture"});`;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/__picker-reparent") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(`<!doctype html><meta charset="utf-8"><style>
            body { margin: 0; font-family: sans-serif; --card: white; --line: #ddd; --ink: #111; }
            #draft-home, #prepared-thread { min-height: 80px; }
            </style><div id="fixture"></div><script type="module" src="${entry}"></script>`);
        });
      },
    },
  ],
});
let browser;
const observations = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  page.on("pageerror", (error) => console.error(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}__picker-reparent`);
  await page.getByRole("button", { name: "Open model picker" }).click();
  await page.waitForFunction(() =>
    document.querySelector("dialog")?.matches(":modal"),
  );
  observations.push({ phase: "loading", modal: true });
  await page.evaluate(() => window.fixture.completePreparation());
  await page.waitForFunction(
    () =>
      document.querySelector("#prepared-thread textarea") &&
      document.querySelectorAll(".new-model-groups > button").length === 475,
  );
  const afterMove = await page.evaluate(() => ({
    modal: document.querySelector("dialog").matches(":modal"),
    open: document.querySelector("dialog").open,
    draft: document.querySelector("textarea").value,
    parent: document.querySelector("dialog").parentElement.tagName,
  }));
  observations.push({ phase: "prepared-host-moved", ...afterMove });
  console.log(JSON.stringify(observations));
  assert.equal(
    afterMove.modal,
    true,
    "moving the prepared composer must retain the native modal",
  );
  assert.equal(afterMove.draft, "retained draft");
  await page.evaluate(() => document.querySelector("#background").focus());
  assert.equal(
    await page.evaluate(() =>
      document.querySelector("dialog").contains(document.activeElement),
    ),
    true,
  );
  const search = page.getByRole("textbox", { name: "搜索模型或服务" });
  await search.fill("Model 471");
  await page.getByRole("button", { name: "Model 471", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("dialog"));
  assert.equal(
    await page.evaluate(() => document.activeElement.textContent),
    "Open model picker",
  );
  assert.deepEqual(await page.evaluate(() => window.fixture.applications), []);
  // Reopen after moving: the search and footer remain reachable with 475 items.
  await page.getByRole("button", { name: "Open model picker" }).click();
  await search.fill("Model 471");
  await page.getByRole("button", { name: "Model 471", exact: true }).click();
  await page.evaluate(() => window.fixture.pendingApply());
  await page.getByRole("button", { name: "使用这个模型", exact: true }).click();
  await page.waitForFunction(() => !!window.fixture.finishApply);
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(() =>
      document.querySelector("dialog").matches(":modal"),
    ),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "关闭", exact: true }).isDisabled(),
    true,
  );
  await page.evaluate(() => window.fixture.moveBack());
  await page.waitForFunction(
    () => !!document.querySelector("#draft-home textarea"),
  );
  assert.equal(
    await page.evaluate(() =>
      document.querySelector("dialog").matches(":modal"),
    ),
    true,
  );
  await page.evaluate(() => window.fixture.finishApply());
  await page.waitForFunction(() => !document.querySelector("dialog"));
  assert.deepEqual(await page.evaluate(() => window.fixture.applications), [
    { service: null, modelValue: "model-471" },
  ]);
  assert.equal(
    await page.evaluate(() => document.activeElement.textContent),
    "Open model picker",
  );
  console.log(
    JSON.stringify({
      status: "passed",
      checks: [
        "native modal survives host relocation",
        "background focus blocked",
        "475 options searchable",
        "Escape cancels without apply",
        "focus returns to actual moved opener",
        "saving prevents close",
        "second move preserves pending apply",
        "one explicit apply",
      ],
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
