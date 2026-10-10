import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base =
    "docs/evidence/2026-10-09-capability-hardening/real-stop/async-tasks/browser",
  engine = process.argv[2] ?? "webkit";
const source = [
  "src/runtime/async_tasks.ts",
  "src/runtime/async_task_actions.ts",
  "src/runtime/async_task_strings.ts",
  "src/runtime/session_types.ts",
  "src/runtime/sessions.ts",
  "src/runtime/session_projection.ts",
  "src/components/AsyncTasks.tsx",
  "src/components/AsyncTasks.css",
];
const hash = () =>
  Object.fromEntries(
    source.map((p) => [
      p,
      createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
    ]),
  );
const result = {
  engine,
  scope:
    "Actual AsyncTasks React StrictMode + real threads event projection/action; controlled IPC only. Not full App, native, Agent, or task termination proof.",
  before: hash(),
  checks: [],
  errors: [],
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
const timer = setTimeout(() => browser.close(), 45000);
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.setDefaultTimeout(6000);
page.on("pageerror", (e) => result.errors.push(String(e)));
await page.route("**/*", (r) =>
  r.request().url().startsWith("http://127.0.0.1:1473/")
    ? r.continue()
    : (result.blocked.push(r.request().url()), r.abort()),
);
const check = (name, pass, detail) => {
  result.checks.push({ name, pass, detail });
  if (!pass) throw Error(name);
};
const stop = () => page.getByRole("button", { name: "停止任务", exact: true });
try {
  await page.goto("http://127.0.0.1:1473/" + base + "/index.html");
  await stop().waitFor();
  check(
    "no automatic stop",
    (await page.evaluate(() => window.fixture.calls().length)) === 0,
  );
  await stop().focus();
  await page.keyboard.press("Enter");
  await page.getByText("正在请求停止…", { exact: true }).waitFor();
  check(
    "keyboard explicit dispatch once",
    (await page.evaluate(() => window.fixture.calls().length)) === 1,
  );
  check("pending button disabled", await stop().isDisabled());
  await page.evaluate(() => window.fixture.accepted());
  await page
    .getByText("停止请求已接受，等待任务结果", { exact: true })
    .waitFor();
  const accepted = await page.evaluate(() => window.fixture.snapshot());
  check(
    "accepted keeps running",
    accepted.task.state === "running" && accepted.busy,
    accepted,
  );
  check(
    "queue paused retained",
    accepted.pause === "stopped" &&
      accepted.queue[0][0].text === "Retained queued draft",
  );
  await page.screenshot({
    path: base + "/" + engine + "-accepted.png",
    fullPage: true,
  });
  await page.evaluate(() => window.fixture.wrong());
  check(
    "wrong owner cannot clear card",
    (await page.getByRole("region", { name: "后台任务" }).count()) === 1 ||
      (await page.locator(".async-tasks").count()) === 1,
  );
  await page.evaluate(() => window.fixture.terminal());
  await page.getByText("已完成", { exact: true }).waitFor();
  check(
    "natural completion stays completed",
    (await stop().count()) === 0 &&
      !(await page.evaluate(() => window.fixture.snapshot().busy)),
  );
  check(
    "no fake turn or tool terminal",
    (await page.evaluate(() => window.fixture.snapshot().items.length)) === 0,
  );
  await page.evaluate(() => window.fixture.reset());
  await stop().waitFor();
  await page.getByRole("button", { name: "隐藏控制", exact: true }).click();
  check("inactive card disables control", await stop().isDisabled());
  await page.getByRole("button", { name: "恢复控制", exact: true }).click();
  check("active exact card enabled", await stop().isEnabled());
  await page.evaluate(() => window.fixture.lost());
  await page
    .getByText("连接已结束，无法核实此任务的结果。", { exact: true })
    .waitFor();
  check(
    "connection loss preserves unknown work",
    (await stop().isDisabled()) &&
      (await page.evaluate(() => window.fixture.snapshot().busy)),
  );
  await page.setViewportSize({ width: 420, height: 640 });
  await page.screenshot({
    path: base + "/" + engine + "-lost-narrow.png",
    fullPage: true,
  });
  check(
    "narrow content no horizontal overflow",
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  check(
    "only exact target IPC",
    await page.evaluate(() =>
      window.fixture
        .calls()
        .every(
          (c) =>
            c.args.connectionId === "connection" &&
            c.args.sessionId === "native" &&
            c.args.taskId === "exact-1",
        ),
    ),
  );
  check(
    "no external requests or runtime errors",
    result.errors.length === 0 && result.blocked.length === 0,
    { errors: result.errors, blocked: result.blocked },
  );
} catch (e) {
  result.failure = String(e);
  process.exitCode = 1;
} finally {
  result.after = hash();
  result.sourceUnchanged =
    JSON.stringify(result.before) === JSON.stringify(result.after);
  clearTimeout(timer);
  await browser.close();
  const raw = JSON.stringify(result, null, 2) + "\n";
  fs.writeFileSync(base + "/" + engine + ".raw.txt", raw);
  fs.writeFileSync(base + "/" + engine + ".json", raw);
  console.log(
    JSON.stringify({
      engine,
      checks: result.checks.length,
      failed: result.failure ?? null,
      sourceUnchanged: result.sourceUnchanged,
    }),
  );
}
