import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base =
  "docs/evidence/2026-10-09-capability-hardening/worktree-native-followup/new11/independent/browser";
const engine = process.argv[2] ?? "webkit",
  label = process.argv[3] ?? "red";
const files = [];
function walk(p) {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    if (e.isDirectory()) walk(f);
    else files.push(f);
  }
}
walk("src");
files.push(
  "package.json",
  "pnpm-lock.yaml",
  "vite.config.ts",
  ...["fixture.tsx", "index.html", "serve.mjs", "run.mjs"].map(
    (n) => base + "/" + n,
  ),
);
files.sort();
const hashes = () =>
  Object.fromEntries(
    files.map((f) => [
      f,
      createHash("sha256").update(fs.readFileSync(f)).digest("hex"),
    ]),
  );
const result = {
  engine,
  label,
  scope:
    "Actual App, EmptyState, useThread, ThreadPage and real production stores under React StrictMode; only controlled in-memory IPC and synthetic filesystem receipts. No formal App, Agent, Git or database access.",
  baselineOverlay: label.includes("red")
    ? "a3115244a86a87310e9fc84cf5d8dde46cfeee2a3b0bedab0fd149b0bbdf6748"
    : null,
  before: hashes(),
  checks: [],
  errors: [],
  scenarios: [],
  screenshots: [],
  blocked: [],
};
const browser = await (engine === "webkit" ? webkit : chromium).launch({
  headless: true,
  executablePath:
    engine === "webkit"
      ? path.resolve(
          "output/2026-10-10-text-feedback-webkit/browsers/webkit-2336/pw_run.sh",
        )
      : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const deadline = setTimeout(() => void browser.close(), 120000);
let page;
const check = (name, pass, detail) => {
  result.checks.push({ name, pass: !!pass, detail });
};
const button = (name) => page.getByRole("button", { name, exact: true });
const current = () => page.evaluate(() => window.fixture.current());
const count = (s, c) => s.calls.filter((x) => x.cmd === c).length;
async function screenshot(n) {
  const p = base + "/" + engine + "-" + label + "-" + n + ".png";
  await page.screenshot({ path: p });
  result.screenshots.push(p);
}
async function load(mode) {
  if (page) await page.close();
  page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(6000);
  page.on("pageerror", (e) => result.errors.push(String(e)));
  await page.route("**/*", (r) =>
    r.request().url().startsWith("http://127.0.0.1:1480/")
      ? r.continue()
      : (result.blocked.push(r.request().url()), r.abort()),
  );
  await page.goto("http://127.0.0.1:1480/" + base + "/index.html?mode=" + mode);
  await page.waitForFunction(() => {
    const s = window.fixture?.current();
    return s && s.threads.some((t) => t.identity === "draft");
  });
  await page.getByText("第一条消息即开始会话", { exact: true }).waitFor();
  await button("工作树").waitFor();
  const s = await current();
  check(
    mode + ": production ready draft is actually presented",
    s.threads.some((t) => t.key === s.draftKey && t.identity === "draft") &&
      (await page.locator("main.workspace-thread:visible").count()) === 1,
  );
  check(
    mode + ": real preparation performed no prompt",
    count(s, "session_open") === 1 && count(s, "session_prompt") === 0,
  );
  return s;
}
async function post(name) {
  const s = await current();
  check(name + ": no unexpected IPC", s.unexpected.length === 0, s.unexpected);
  check(
    name + ": no automatic prompt or repeat open",
    count(s, "session_prompt") === 0 && count(s, "session_open") === 1,
    s.calls.filter((c) => ["session_open", "session_prompt"].includes(c.cmd)),
  );
  result.scenarios.push({
    name,
    state: s,
    body: await page.locator("body").innerText(),
  });
  return s;
}
try {
  await load("archive");
  await screenshot("ready-draft");
  await button("工作树").click();
  const dialog = page.getByRole("dialog", { name: "工作树", exact: true });
  await dialog.waitFor();
  await dialog
    .getByRole("button", { name: "归档并保留文件", exact: true })
    .click();
  const review = page.getByRole("region", { name: "确认影响", exact: true });
  await review
    .getByRole("checkbox", {
      name: "我已停止其他程序使用这个工作树",
      exact: true,
    })
    .check();
  await review
    .getByRole("button", { name: "归档并保留文件", exact: true })
    .click();
  await page.waitForFunction(
    () => window.fixture.current().snapshot.operation?.state === "ready",
  );
  await page.waitForFunction(
    () => !window.fixture.current().threads.some((t) => t.identity === "draft"),
  );
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.waitForTimeout(300);
  let s = await current();
  let body = await page.locator("body").innerText();
  check(
    "archive: actual production discard removed prepared thread",
    !s.threads.some((t) => t.identity === "draft") &&
      count(s, "session_close") === 1 &&
      count(s, "session_dismiss") === 1,
  );
  check(
    "archive: visible start shows exact archive management instead of missing-key loading",
    (await button("管理已归档位置").count()) === 1 &&
      !(await page
        .locator("main.workspace-thread:visible .library-empty")
        .count()),
    body,
  );
  await screenshot("archive-after-close");
  await page.locator(".product-new").click();
  await page.waitForTimeout(300);
  body = await page.locator("body").innerText();
  check(
    "archive: explicit New conversation retains blocked cwd notice without reopening",
    (await button("管理已归档位置").count()) === 1 &&
      !(await page
        .locator("main.workspace-thread:visible .library-empty")
        .count()),
    body,
  );
  await post("archive");

  await load("retire");
  await page.evaluate(() =>
    window.fixture.setDraftText("NEW11_UNSENT_RETAINED"),
  );
  await page.evaluate(() => window.fixture.openManagement());
  await page.getByRole("dialog", { name: "工作树", exact: true }).waitFor();
  await page.evaluate(() => window.fixture.retire());
  await page
    .getByRole("dialog", { name: "工作树", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.waitForTimeout(300);
  s = await current();
  check(
    "retire: public retirePreparationDraft removes exact empty prepared thread",
    !s.threads.some((t) => t.identity === "draft") &&
      count(s, "session_close") === 1,
  );
  check(
    "retire: same unsent composer is visible on start with contents retained",
    s.draft.text === "NEW11_UNSENT_RETAINED" &&
      (await page.locator("textarea:visible").count()) === 1 &&
      (await page.locator("textarea:visible").inputValue()) ===
        "NEW11_UNSENT_RETAINED" &&
      !(await page
        .locator("main.workspace-thread:visible .library-empty")
        .count()),
  );
  await screenshot("retired-back-to-draft");
  await post("retire");

  await load("disconnected");
  await page.evaluate(() => window.fixture.loseConnection());
  await page.waitForFunction(() =>
    window.fixture
      .current()
      .threads.some((t) => t.identity === "draft" && t.connectionLost),
  );
  check(
    "disconnected: still-existing displayed draft retains ThreadPage",
    (await page.locator("main.workspace-thread:visible").count()) === 1 &&
      !(await page
        .locator("main.workspace-thread:visible .library-empty")
        .count()),
  );
  await screenshot("retained-disconnected");
  await post("disconnected");

  await load("configuring");
  await page.evaluate(() => window.fixture.configure());
  await page.waitForFunction(() =>
    window.fixture
      .current()
      .threads.some((t) => t.identity === "draft" && t.configuring),
  );
  check(
    "configuring: real setConfig pending does not remove existing displayed draft",
    (await page.locator("main.workspace-thread:visible").count()) === 1 &&
      !(await page
        .locator("main.workspace-thread:visible .library-empty")
        .count()),
  );
  await screenshot("retained-configuring");
  await post("configuring");

  await load("library");
  await page.getByRole("button", { name: /^所有对话/ }).click();
  await page.waitForTimeout(250);
  const before = await page.locator("body").innerText();
  await page.evaluate(() => window.fixture.archiveExternal());
  await page.waitForFunction(
    () => !window.fixture.current().threads.some((t) => t.identity === "draft"),
  );
  await page.waitForTimeout(250);
  const after = await page.locator("body").innerText();
  check(
    "other route: prepared retirement does not force navigation away from library",
    (await page
      .locator(".product-navigation button.active")
      .filter({ hasText: "所有对话" })
      .count()) === 1 &&
      after.includes("NEW11_OTHER_HISTORY") &&
      !(await page.locator("main.workspace-thread:visible").count()),
    { before, after },
  );
  await screenshot("library-not-stolen");
  await page.locator(".product-new").click();
  await page.waitForTimeout(250);
  check(
    "other route: later explicit New shows remembered archive barrier",
    (await button("管理已归档位置").count()) === 1 &&
      !(await page
        .locator("main.workspace-thread:visible .library-empty")
        .count()),
  );
  await post("library");
} catch (e) {
  result.errors.push(String(e.stack ?? e));
  if (page) {
    result.failureState = await current().catch(() => null);
    result.failureBody = await page
      .locator("body")
      .innerText()
      .catch(() => null);
    await screenshot("driver-or-product-failure").catch(() => {});
  }
} finally {
  clearTimeout(deadline);
  await browser.close();
  result.after = hashes();
  result.sourceUnchanged =
    JSON.stringify(result.before) === JSON.stringify(result.after);
  result.summary = {
    passed: result.checks.filter((c) => c.pass).length,
    failed: result.checks.filter((c) => !c.pass).length,
    errors: result.errors.length,
  };
  fs.writeFileSync(
    base + "/" + engine + "-" + label + ".json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result.summary));
  if (result.summary.failed || result.errors.length) process.exitCode = 1;
}
