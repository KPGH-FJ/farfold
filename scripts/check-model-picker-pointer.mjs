import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";

// Uses an existing engine and a new exclusive output directory; installs nothing.
// argv: Playwright module, browser executable, new evidence directory, engine.
const [playwrightModule, executablePath, outputDirectory, engine = "chromium"] =
  process.argv.slice(2);
assert.ok(
  playwrightModule && executablePath && outputDirectory,
  "Explicit existing browser and new output directory required",
);
assert.ok(
  ["chromium", "webkit"].includes(engine),
  "Supported explicit engine required",
);
const playwright = await import(pathToFileURL(resolve(playwrightModule)).href);
const root = process.cwd();
const evidence = resolve(outputDirectory);
await mkdir(evidence, { mode: 0o700 });
const entry = "/__model-pointer-layout-fixture.jsx";
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelPicker } from "/src/components/ModelPicker.tsx";
import { WorkspacePopover } from "/src/components/WorkspacePopover.tsx";
import "/src/styles.css";
import "/src/styles-thread.css";
import "/src/product-shell.css";
import "/src/conversation-workspace.css";
const option = { id:"model",name:"Model",category:"model",type:"select",currentValue:"original",
  options:[{value:"original",name:"Original"}, ...Array.from({length:80},(_,i)=>({value:"item-"+i,name:"Model "+i})),
    {value:"owned-free",name:"Owned free model"}]};
window.fixture={picks:[],events:[]};
for (const type of ["mousedown","focusin","mouseup","click"]) window.addEventListener(type,event=>{
  const target=event.target;
  window.fixture.events.push({type,tag:target.tagName,role:target.getAttribute?.("role"),className:typeof target.className==="string"?target.className:"",withinOption:!!target.closest?.('[role="option"]')});
},true);
function App(){
  const [selected,setSelected]=useState(null);
  const picker=<ModelPicker option={option} onPick={value=>{window.fixture.picks.push(value);setSelected(value);}} />;
  return <div style={{position:"fixed",bottom:30,left:300,width:344}}>
    {new URLSearchParams(location.search).has("standalone")?picker:
      <WorkspacePopover title="Owned model options" label="Owned model options">
        <dl className="workspace-identity"><dt>Agent</dt><dd>Owned fixture</dd><dt>Source</dt><dd>Existing fixture source</dd><dt>Model</dt><dd>Original</dd></dl>
        {picker}
        {selected&&<section data-review={selected}>Pending selection, no settings applied</section>}
        <p className="workspace-control-note">A selected value is reviewed before any configuration call.</p>
      </WorkspacePopover>}
  </div>;
}
createRoot(document.getElementById("fixture")).render(<App />);
`;
const server = await createServer({
  root,
  configFile: false,
  cacheDir: resolve(evidence, "vite-cache"),
  server: { host: "127.0.0.1", port: 0 },
  optimizeDeps: {
    entries: [],
    noDiscovery: true,
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@phosphor-icons/react",
    ],
  },
  plugins: [
    {
      name: "owned-model-pointer-layout",
      enforce: "pre",
      resolveId(id) {
        if (id === entry) return entry;
      },
      load(id) {
        if (id === entry) return fixture;
        if (id.endsWith("/src/runtime/browser_surface.ts"))
          return "export const useBrowserSurfaceBarrier = requested => requested;";
      },
      configureServer(current) {
        current.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/__model-pointer-layout")
            return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            `<!doctype html><meta charset="utf-8"><div id="fixture"></div><script type="module" src="${entry}"></script>`,
          );
        });
      },
    },
  ],
});

let browser;
const cases = [];
const errors = [];
const geometry = async (page) =>
  page.evaluate(() => {
    const summarize = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const css = getComputedStyle(element);
      const x = rect.left + rect.width / 2,
        y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        rect: {
          top: rect.top,
          left: rect.left,
          bottom: rect.bottom,
          right: rect.right,
          width: rect.width,
          height: rect.height,
        },
        centerHit: element === hit || element.contains(hit),
        hit: {
          tag: hit?.tagName,
          role: hit?.getAttribute("role"),
          className: typeof hit?.className === "string" ? hit.className : "",
        },
        css: {
          position: css.position,
          overflow: css.overflow,
          transform: css.transform,
          filter: css.filter,
          backdropFilter: css.backdropFilter,
          contain: css.contain,
        },
      };
    };
    return {
      outer: summarize(".workspace-control-panel"),
      picker: summarize(".mp"),
      panel: summarize(".mp-panel"),
      search: summarize(".mp-search"),
      option: summarize('[role="option"]'),
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
async function open(page, standalone = false) {
  await page.goto(
    `${server.resolvedUrls.local[0]}__model-pointer-layout${standalone ? "?standalone" : ""}`,
  );
  if (!standalone)
    await page
      .getByRole("button", { name: "Owned model options", exact: true })
      .click();
  await page.locator(".mp-btn").click();
  await page.waitForFunction(() => !!document.querySelector(".mp-search"));
}
async function search(page) {
  await page.getByRole("combobox").fill("owned free");
  await page.waitForFunction(
    () => document.querySelectorAll('[role="option"]').length === 1,
  );
}
try {
  await server.listen();
  browser = await playwright[engine].launch({ headless: true, executablePath });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  const unfiltered = await geometry(page);
  await page.screenshot({ path: resolve(evidence, "nested-unfiltered.png") });
  await search(page);
  const filtered = await geometry(page);
  await page.screenshot({ path: resolve(evidence, "nested-filtered.png") });
  const rect = filtered.option.rect;
  await page.mouse.click(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
  const pointer = await page.evaluate(() => ({
    picks: window.fixture.picks,
    events: window.fixture.events,
    remainingOptions: document.querySelectorAll('[role="option"]').length,
    pending:
      document.querySelector("[data-review]")?.getAttribute("data-review") ??
      null,
  }));
  cases.push({
    name: "nested-pointer",
    unfiltered,
    filtered,
    ...pointer,
    passed:
      filtered.search.centerHit &&
      filtered.option.centerHit &&
      pointer.picks.length === 1 &&
      pointer.picks[0] === "owned-free",
  });
  await open(page);
  await search(page);
  await page.getByRole("combobox").press("Enter");
  const keyboard = await page.evaluate(() => ({
    picks: window.fixture.picks,
    pending:
      document.querySelector("[data-review]")?.getAttribute("data-review") ??
      null,
  }));
  cases.push({
    name: "nested-keyboard",
    ...keyboard,
    passed:
      keyboard.picks.length === 1 &&
      keyboard.picks[0] === "owned-free" &&
      keyboard.pending === "owned-free",
  });
  await open(page, true);
  await search(page);
  const standalone = await geometry(page);
  const direct = standalone.option.rect;
  await page.mouse.click(
    direct.left + direct.width / 2,
    direct.top + direct.height / 2,
  );
  const control = await page.evaluate(() => ({
    picks: window.fixture.picks,
    events: window.fixture.events,
  }));
  cases.push({
    name: "standalone-pointer",
    geometry: standalone,
    ...control,
    passed:
      standalone.search.centerHit &&
      standalone.option.centerHit &&
      control.picks.length === 1 &&
      control.picks[0] === "owned-free",
  });
  await open(page);
  await search(page);
  await page.evaluate(() =>
    document
      .querySelector('[role="option"]')
      .addEventListener("mousedown", (event) => event.preventDefault()),
  );
  const beforeDefaultControl = await geometry(page);
  const controlled = beforeDefaultControl.option.rect;
  await page.mouse.click(
    controlled.left + controlled.width / 2,
    controlled.top + controlled.height / 2,
  );
  const preservedFocus = await page.evaluate(() => ({
    picks: window.fixture.picks,
    events: window.fixture.events,
    pending:
      document.querySelector("[data-review]")?.getAttribute("data-review") ??
      null,
  }));
  cases.push({
    name: "nested-pointer-prevent-default-focus-control",
    geometry: beforeDefaultControl,
    ...preservedFocus,
    passed:
      preservedFocus.picks.length === 1 &&
      preservedFocus.picks[0] === "owned-free" &&
      preservedFocus.pending === "owned-free",
  });
  const result = {
    kind: "OwnedProductionPickerBrowserLayoutObservation",
    browserVersion: browser.version(),
    cases,
    errors,
    scope:
      "Real production ModelPicker and WorkspacePopover/CSS; native browser-surface hook only replaced by a ready boolean. Synthetic option/DOM with no Agent/native calls, no configuration confirmation or model request.",
  };
  await writeFile(
    resolve(evidence, "browser-observations.json"),
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      caseCount: cases.length,
      passed: cases.filter((item) => item.passed).length,
      failed: cases.filter((item) => !item.passed).length,
      errors: errors.length,
      observations: "browser-observations.json",
    }),
  );
  assert.equal(
    errors.length,
    0,
    "Fixture must load the actual production components without runtime error",
  );
  assert.equal(
    cases.every((item) => item.passed),
    true,
    "Real pointer must reach the displayed nested model option, as keyboard and standalone controls do",
  );
} finally {
  await browser?.close();
  await server.close();
}
