/** Real-time browser harness: owns one headless Chromium with a temporary profile. */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const folder = dirname(fileURLToPath(import.meta.url));
const name = process.argv[2] ?? "browser-realtime";
const profile = await mkdtemp(join(tmpdir(), "farfold-xlsx-review-chrome-"));
const child = spawn(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-extensions",
    "--disable-component-update",
    "--enable-precise-memory-info",
    "--js-flags=--expose-gc",
    "about:blank",
  ],
  { detached: true, stdio: ["ignore", "ignore", "pipe"] },
);
const diagnostics = [];
let stderr = "";
child.stderr.on("data", (data) => (stderr += data));
let ws;
const requests = new Map();
let id = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let watchdog = setTimeout(() => {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}, 75000);
try {
  let port;
  for (let i = 0; i < 300; i++) {
    try {
      port = (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      ).split("\n")[0];
      break;
    } catch {
      await sleep(50);
    }
  }
  if (!port) throw new Error("debug endpoint not ready");
  const pages = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json();
  ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (
      msg.method === "Runtime.exceptionThrown" ||
      msg.method === "Runtime.consoleAPICalled"
    )
      diagnostics.push(msg);
    if (requests.has(msg.id)) {
      requests.get(msg.id)(msg);
      requests.delete(msg.id);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      requests.set(n, (msg) =>
        msg.error
          ? reject(new Error(JSON.stringify(msg.error)))
          : resolve(msg.result),
      );
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await call("Runtime.enable");
  await call("Page.navigate", {
    url: "http://127.0.0.1:1458/docs/evidence/2026-10-09-capability-hardening/xlsx/independent-browser/index.html",
  });
  const captured = new Set();
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1000,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false,
  });
  let raw;
  for (let i = 0; i < 500; i++) {
    await sleep(100);
    const stage = await call("Runtime.evaluate", {
      expression: "document.documentElement.dataset.capture || null",
      returnByValue: true,
    });
    const label = stage.result.value;
    if (label && !captured.has(label)) {
      const shot = await call("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });
      await writeFile(
        join(folder, `${label}.png`),
        Buffer.from(shot.data, "base64"),
      );
      captured.add(label);
      await call("Runtime.evaluate", {
        expression:
          "document.documentElement.dataset.captured = " +
          JSON.stringify(label),
      });
    }
    const value = await call("Runtime.evaluate", {
      expression:
        'document.documentElement.dataset.done === "true" ? document.querySelector("#result").textContent : null',
      returnByValue: true,
    });
    if (value.result.value) {
      raw = value.result.value;
      break;
    }
  }
  if (!raw) throw new Error("fixture did not finish within 50 seconds");
  await writeFile(join(folder, `${name}.json`), raw + "\n");
  const result = JSON.parse(raw);
  console.log(raw);
  console.log(JSON.stringify(diagnostics));
  process.exitCode = result.passed ? 0 : 1;
} catch (error) {
  console.error(error);
  process.exitCode = 2;
} finally {
  clearTimeout(watchdog);
  ws?.close();
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await new Promise((r) =>
    child.exitCode !== null ? r() : child.once("exit", r),
  );
  await writeFile(join(folder, `${name}.stderr.txt`), stderr);
  await writeFile(
    join(folder, `${name}.diagnostics.json`),
    JSON.stringify(diagnostics, null, 2),
  );
  await rm(profile, { recursive: true, force: true });
}
