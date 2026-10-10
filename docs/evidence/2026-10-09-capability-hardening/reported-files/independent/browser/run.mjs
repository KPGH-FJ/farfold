import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base =
  "docs/evidence/2026-10-09-capability-hardening/reported-files/independent/browser";
const engine = process.argv[2] ?? "webkit",
  label = process.argv[3] ?? "first";
const walk = (d) =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
    );
const inputs = [
  ...walk("src"),
  ...["fixture.tsx", "index.html", "serve.mjs", "run.mjs"].map(
    (n) => base + "/" + n,
  ),
];
const hashes = () =>
  Object.fromEntries(
    inputs.map((p) => [
      p,
      createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
    ]),
  );
const result = {
  engine,
  label,
  scope:
    "Actual complete App/React; real projection and text rendering; in-memory controlled IPC and draft storage. No Agent/Tauri native/user data.",
  before: hashes(),
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
const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
  }),
  page = await context.newPage();
page.setDefaultTimeout(10000);
page.on("pageerror", (e) => result.errors.push(String(e)));
await page.route("**/*", (r) =>
  r.request().url().startsWith("http://127.0.0.1:1470/")
    ? r.continue()
    : (result.blocked.push(r.request().url()), r.abort()),
);
const check = (name, pass, detail) => {
  result.checks.push({ name, pass, detail });
  if (!pass) throw Error(name);
};
const btn = (name) => page.getByRole("button", { name, exact: true });
const fileCalls = () => page.evaluate(() => window.fixture.fileCalls());
try {
  await page.goto("http://127.0.0.1:1470/" + base + "/index.html", {
    waitUntil: "networkidle",
  });
  await btn("CONTROLLED_P19_REPORTED_FILES").click();
  await btn("查看对话内容").click();
  await page.getByRole("region", { name: "报告的文件", exact: true }).waitFor();
  check(
    "opening report list performs zero file IPC",
    (await fileCalls()).length === 0,
    await fileCalls(),
  );
  check(
    "unique paths from actual structured events",
    (await page.locator(".reported-files-rows >li").count()) === 3,
  );
  const target = page
    .locator(".reported-files-rows >li")
    .filter({ hasText: "/controlled/report one.md" });
  check(
    "same path preserves two original tool records",
    (await target.innerText()).includes("2 条工具记录"),
  );
  await target.locator("summary").click();
  check(
    "source disclosure performs zero file IPC",
    (await fileCalls()).length === 0,
  );
  await target
    .getByRole("button", { name: "查看第 1 条来源记录", exact: true })
    .click();
  await page.getByText("这一步的内容", { exact: true }).waitFor();
  check(
    "resource-only step has one reported path",
    (await page.locator(".reported-files-rows >li").count()) === 1,
  );
  check(
    "source step navigation performs zero file IPC",
    (await fileCalls()).length === 0,
  );
  await btn("查看本轮全部内容").click();
  check(
    "exact first round has one path",
    (await page.locator(".reported-files-rows >li").count()) === 1,
  );
  await page.evaluate(() => window.fixture.lateComplete());
  await page.waitForFunction(() =>
    document
      .querySelector(".reported-files")
      ?.textContent?.includes("2 条工具记录"),
  );
  check(
    "late old completion updates old round sources",
    (await page.locator(".reported-files").innerText()).includes(
      "2 条工具记录",
    ),
  );
  await page.evaluate(() => window.fixture.retractOld());
  await page
    .getByText("当前范围没有报告的文件位置。", { exact: true })
    .waitFor();
  check(
    "explicit arrays retract only original scoped reports",
    (await page.locator(".reported-files-rows >li").count()) === 0,
  );
  await btn("查看会话全部产物").click();
  await page
    .getByRole("button", {
      name: "查看文件 /controlled/report one.md",
      exact: true,
    })
    .waitFor();
  check(
    "later same-path report remains after old round retraction",
    (await page.locator(".reported-files-rows >li").count()) === 3,
  );
  check(
    "updates and scope changes still zero file IPC",
    (await fileCalls()).length === 0,
  );
  await page.evaluate(() => window.fixture.addMany());
  await page.getByText("59 个文件位置", { exact: true }).waitFor();
  check(
    "pagination limits actual rows without silently dropping reported files",
    (await page.locator(".reported-files-rows >li").count()) === 50,
  );
  await btn("下一组文件").click();
  check(
    "last page exposes all remaining nine paths",
    (await page.locator(".reported-files-rows >li").count()) === 9,
  );
  await btn("上一组文件").click();
  check("paging performs no file IPC", (await fileCalls()).length === 0);
  const opener = btn("查看文件 /controlled/report one.md");
  await opener.focus();
  await page.keyboard.press("Enter");
  await page.getByText("Controlled report V1", { exact: true }).waitFor();
  check(
    "explicit keyboard action inspects only the exact requested path",
    (await fileCalls()).filter(
      (c) => c.cmd === "file_delivery_inspect_selected",
    ).length > 0 &&
      (await fileCalls())
        .filter((c) => c.cmd === "file_delivery_inspect_selected")
        .every((c) => c.args.path === "/controlled/report one.md"),
    await fileCalls(),
  );
  check(
    "actual text reader invoked only after explicit inspection",
    (await fileCalls()).filter((c) => c.cmd === "file_delivery_read_text")
      .length === 1,
  );
  await page.screenshot({
    path: base + "/" + engine + "-" + label + "-opened.png",
  });
  await btn("修改意见").click();
  await page
    .getByRole("textbox", { name: "补充给 Agent 的意见", exact: true })
    .fill("P19_OLD_VERSION_FEEDBACK");
  const feedbackBefore = await page.evaluate(() =>
    JSON.stringify(window.fixture.feedback()),
  );
  const composerBefore = await page.evaluate(
    () => window.fixture.composer().text,
  );
  const readsBefore = (await fileCalls()).filter(
    (c) => c.cmd === "file_delivery_read_text",
  ).length;
  await page.evaluate(() => {
    window.fixture.setVersion("v2");
    window.fixture.update("third-report", {
      kind: "edit",
      status: "completed",
      locations: [{ path: window.fixture.path }],
    });
  });
  await page.waitForTimeout(2100);
  check(
    "same-path new report does not replace an editing version",
    (await page
      .getByText("Controlled report V1", { exact: true })
      .isVisible()) &&
      (await fileCalls()).filter((c) => c.cmd === "file_delivery_read_text")
        .length === readsBefore,
  );
  check(
    "new report leaves exact old feedback and composer unchanged",
    (await page.evaluate(() => JSON.stringify(window.fixture.feedback()))) ===
      feedbackBefore &&
      (await page.evaluate(() => window.fixture.composer().text)) ===
        composerBefore,
  );
  await btn("返回文件与输出").click();
  await btn("查看文件 /controlled/report one.md").click();
  await page.getByText("Controlled report V2", { exact: true }).waitFor();
  check(
    "explicit re-open reads changed version and keeps old feedback",
    (await page.evaluate(() => JSON.stringify(window.fixture.feedback()))) ===
      feedbackBefore,
  );
  await page
    .locator(".artifact-opened-file-body summary")
    .filter({ hasText: "其他内容版本的意见" })
    .click();
  const old = page
    .locator(".artifact-opened-file-body")
    .getByRole("button", { name: "加入输入框", exact: true });
  await old.click();
  check(
    "take appends once to original composer and preserves prefix",
    await page
      .evaluate(() => window.fixture.composer().text)
      .then(
        (text) =>
          text.startsWith(composerBefore) &&
          text.split("P19_OLD_VERSION_FEEDBACK").length === 2,
      ),
  );
  check(
    "take removes exactly the old stored opinion without sending",
    !(
      await page.evaluate(() => JSON.stringify(window.fixture.feedback()))
    ).includes("P19_OLD_VERSION_FEEDBACK") &&
      !(await fileCalls()).some((c) => c.cmd === "session_prompt"),
  );
  await btn("返回文件与输出").click();
  await page.setViewportSize({ width: 900, height: 620 });
  await btn("下一组文件").focus();
  await page.keyboard.press("Enter");
  check(
    "narrow keyboard pagination remains reachable",
    (await page.locator(".reported-files-rows >li").count()) === 9,
  );
  await page.screenshot({
    path: base + "/" + engine + "-" + label + "-narrow.png",
  });
  result.uiText = await page.locator("body").innerText();
  result.metrics = await page.evaluate(() => window.fixture.metrics());
  check(
    "complete app retains root viewport",
    result.metrics.windowY === 0 &&
      result.metrics.appY === 0 &&
      result.metrics.rootHeight <= result.metrics.viewportHeight,
    result.metrics,
  );
  check(
    "no unexpected IPC or browser errors",
    (await page.evaluate(() => window.unexpected)).length === 0 &&
      result.errors.length === 0 &&
      result.blocked.length === 0,
    {
      unexpected: await page.evaluate(() => window.unexpected),
      errors: result.errors,
      blocked: result.blocked,
    },
  );
} catch (error) {
  result.failure = String(error);
  result.diagnostic = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  await page
    .screenshot({ path: base + "/" + engine + "-" + label + "-failure.png" })
    .catch(() => {});
} finally {
  result.after = hashes();
  result.sourceUnchanged =
    JSON.stringify(result.before) === JSON.stringify(result.after);
  result.passed = !result.failure && result.checks.every((c) => c.pass);
  await browser.close();
  fs.writeFileSync(
    base + "/" + engine + "-" + label + ".raw.txt",
    JSON.stringify(result, null, 2) + "\n",
  );
  fs.writeFileSync(
    base + "/" + engine + "-" + label + ".json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      engine,
      label,
      passed: result.passed,
      checks: result.checks.length,
      sourceUnchanged: result.sourceUnchanged,
      failure: result.failure,
    }),
  );
}
