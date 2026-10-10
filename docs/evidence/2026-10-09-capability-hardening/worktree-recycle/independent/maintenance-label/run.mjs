import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const engine = process.argv[2];
const base =
  "docs/evidence/2026-10-09-capability-hardening/worktree-recycle/independent/maintenance-label";
const fixture = base;
const label = engine + "-final";
const owner = JSON.parse(
  fs.readFileSync(
    "docs/evidence/2026-10-09-capability-hardening/worktree-recycle/frontend/implementation.json",
    "utf8",
  ),
);
const inputs = [
  ...owner.sourceRefs.map((r) => r.path),
  ...["index.html", "fixture.tsx"].map((p) => fixture + "/" + p),
  "docs/evidence/2026-10-09-capability-hardening/worktree-recycle/independent/browser/serve.mjs",
  base + "/run.mjs",
  "src/App.tsx",
  "src/components/ThreadView.tsx",
  "src/runtime/session_projection.ts",
  "src/runtime/async_tasks.ts",
  "src/components/CommandPalette.tsx",
  "src/components/useDraftWorkLocation.ts",
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
  scope:
    "Production full App with prior controlled IPC fixture; narrow maintenance copy followup only. No native App/Git/Agent.",
  before: hashes(),
  checks: [],
  errors: [],
  blocked: [],
  screenshots: [],
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
const deadline = setTimeout(() => void browser.close(), 45000);
const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
page.setDefaultTimeout(7000);
page.on("pageerror", (e) => result.errors.push(String(e)));
await page.route("**/*", (r) =>
  r.request().url().startsWith("http://127.0.0.1:1476/")
    ? r.continue()
    : (result.blocked.push(r.request().url()), r.abort()),
);
const dialog = () => page.getByRole("dialog", { name: "工作树", exact: true });
const changed = "当前草稿或工作位置已变化，请重新选择。";
const check = (name, pass) => {
  result.checks.push({ name, pass });
  if (!pass) throw Error(name);
};
const snap = async (name) => {
  let p = base + "/" + label + "-" + name + ".png";
  await page.screenshot({ path: p });
  result.screenshots.push(p);
};
async function load() {
  await page.goto("http://127.0.0.1:1476/" + fixture + "/index.html");
  await page.getByRole("button", { name: "工作树", exact: true }).click();
  await dialog()
    .getByText("/controlled/created-tree", { exact: true })
    .waitFor();
}
try {
  await load();
  await dialog()
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
    () => window.fixture.current().snapshot.operation?.state === "running",
  );
  check(
    "maintenance lease remains active",
    await page.evaluate(() => window.fixture.current().locked),
  );
  check(
    "lease alone no longer claims changed draft",
    (await dialog().getByText(changed, { exact: true }).count()) === 0,
  );
  check(
    "Use remains disabled while maintenance holds",
    (
      await dialog()
        .getByRole("button", { name: "使用此位置", exact: true })
        .all()
    ).length > 0 &&
      (await dialog()
        .getByRole("button", { name: "使用此位置", exact: true })
        .evaluateAll((bs) => bs.every((b) => b.disabled))),
  );
  check(
    "actual maintenance explanation and cancel remain reachable",
    await dialog()
      .getByRole("button", { name: "请求停止文件维护", exact: true })
      .isEnabled(),
  );
  await snap("maintaining");
  await dialog()
    .getByRole("button", { name: "请求停止文件维护", exact: true })
    .click();
  await page.waitForFunction(() => !window.fixture.current().locked);
  check(
    "same current draft does not become stale after exact cancellation",
    (await dialog().getByText(changed, { exact: true }).count()) === 0,
  );
  await load();
  await page.evaluate(() => {
    window.savedH15Request = window.fixture.current().request;
  });
  await dialog().getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /所有对话/ })
    .click();
  await page.waitForFunction(() => !window.savedH15Request.target.isCurrent());
  await page.evaluate(() =>
    window.fixture.reopenRequest(window.savedH15Request),
  );
  await dialog().getByText(changed, { exact: true }).waitFor();
  check(
    "real draft owner retirement still shows changed hint after reopening stale request",
    await dialog().getByText(changed, { exact: true }).isVisible(),
  );
  check(
    "retired target cannot Use",
    await dialog()
      .getByRole("button", { name: "使用此位置", exact: true })
      .evaluateAll((bs) => bs.length > 0 && bs.every((b) => b.disabled)),
  );
  check(
    "stale owner recovery dispatches no maintenance or Agent work",
    await page.evaluate(
      () =>
        !window.fixture
          .current()
          .calls.some((c) =>
            /worktree_(recycle_prepare|start)|session_(open|load|prompt)/.test(
              c.cmd,
            ),
          ),
    ),
  );
  await snap("retired-target");
  result.status = "passed";
} catch (e) {
  result.status = "failed";
  result.failure = String(e);
  try {
    await snap("failure");
    result.dom = await page.locator("body").innerText();
    result.state = await page.evaluate(() => window.fixture.current());
  } catch {}
} finally {
  clearTimeout(deadline);
  await browser.close();
  result.after = hashes();
  result.changedInputs = inputs.filter(
    (p) => result.before[p] !== result.after[p],
  );
  result.sourceUnchanged = result.changedInputs.length === 0;
  for (const ext of ["raw.txt", "json"])
    fs.writeFileSync(
      base + "/" + label + "." + ext,
      JSON.stringify(result, null, 2) + "\n",
    );
  console.log(
    JSON.stringify({
      status: result.status,
      checks: result.checks.length,
      passed: result.checks.filter((x) => x.pass).length,
      errors: result.errors,
      failure: result.failure,
      sourceUnchanged: result.sourceUnchanged,
    }),
  );
  if (result.status !== "passed") process.exitCode = 1;
}
