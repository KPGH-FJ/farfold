import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base =
  "docs/evidence/2026-10-09-capability-hardening/worktree-native-followup/independent/browser";
const engine = process.argv[2] ?? "webkit",
  label = process.argv[3] ?? "first";
const port = 1478;
const inputs = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else inputs.push(p);
  }
}
walk("src");
inputs.push(
  "vite.config.ts",
  "package.json",
  "pnpm-lock.yaml",
  ...["fixture.tsx", "index.html", "serve.mjs", "run.mjs", "run-cold.mjs"].map(
    (f) => base + "/" + f,
  ),
);
inputs.sort();
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
    "Actual full App/React StrictMode with production stores/components/CSS; controlled in-memory IPC and synthetic Git/filesystem receipts only, no formal App/Agent/Git/user-data activity.",
  before: hashes(),
  checks: [],
  errors: [],
  blocked: [],
  screenshots: [],
  scenarios: [],
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
const deadline = setTimeout(() => void browser.close(), 180000);
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.setDefaultTimeout(8000);
page.on("pageerror", (e) => result.errors.push(String(e)));
await page.route("**/*", (r) =>
  r.request().url().startsWith(`http://127.0.0.1:${port}/`)
    ? r.continue()
    : (result.blocked.push(r.request().url()), r.abort()),
);
const button = (n) => page.getByRole("button", { name: n, exact: true });
const dialog = () => page.getByRole("dialog", { name: "工作树", exact: true });
const review = () =>
  page.getByRole("region", { name: "删除已归档的工作文件", exact: true });
const recoveryRegion = () =>
  page.getByRole("region", { name: "提交恢复副本", exact: true });
const ack = "我已查看恢复副本和删除位置，确认永久删除此处的工作文件";
const current = () => page.evaluate(() => window.fixture.current());
const count = (s, c) => s.calls.filter((v) => v.cmd === c).length;
const check = (name, pass, detail) => {
  result.checks.push({ name, pass, detail });
  if (!pass) throw Error(name);
};
async function snap(n) {
  const p = `${base}/${engine}-${label}-${n}.png`;
  await page.screenshot({ path: p });
  result.screenshots.push(p);
}
async function load(mode, open = false) {
  await page.goto(`http://127.0.0.1:${port}/${base}/index.html?mode=${mode}`);
  await page.waitForFunction(() => !!window.fixture);
  await button("工作树").waitFor();
  if (open) {
    await button("工作树").click();
    await dialog().waitFor();
  }
}
async function stableCatalogue() {
  await page.waitForFunction(() => {
    const s = window.fixture.current().snapshot;
    return s.ready && !s.loading && !s.working;
  });
}
async function prepare() {
  await dialog()
    .getByRole("button", { name: "删除工作文件…", exact: true })
    .click();
  await review()
    .getByRole("checkbox", {
      name: "我已停止其他程序使用这个工作树",
      exact: true,
    })
    .check();
  await review()
    .getByRole("button", { name: "准备提交恢复副本", exact: true })
    .click();
}
async function noAgent(name) {
  const s = await current();
  check(
    name,
    !s.calls.some((c) =>
      [
        "session_open",
        "session_prompt",
        "agent_connect",
        "agent_register",
      ].includes(c.cmd),
    ),
    s.calls.filter((c) => c.cmd.startsWith("session_")).map((c) => c.cmd),
  );
  check(
    name + " keeps draft/cwd/history",
    s.draft.text === "KEEP_CONTROLLED_UNSENT_TEXT" &&
      s.historyCwd === "/controlled/created-tree" &&
      !s.calls.some((c) => c.cmd === "session_prompt"),
  );
  result.scenarios.push({ name, current: s });
}
try {
  let s;
  await load("cold-recovery", true);
  await stableCatalogue();
  s = await current();
  check(
    "cold canonical unknown is not promoted by same revision operation proof",
    s.snapshot.recoveries[0].availability === "unknown" &&
      s.snapshot.operation.recovery.availability === "verified",
  );
  check(
    "unknown canonical copy disables recovery action",
    await recoveryRegion()
      .getByRole("button", { name: "恢复到新文件夹…", exact: true })
      .isDisabled(),
  );
  check(
    "cold load does not dispatch recover preparation",
    !count(s, "worktree_recover_prepare"),
  );
  await recoveryRegion()
    .getByRole("button", { name: "核验恢复副本", exact: true })
    .click();
  await stableCatalogue();
  s = await current();
  check(
    "explicit canonical verification alone enables new-folder recovery",
    s.snapshot.recoveries[0].availability === "verified" &&
      s.snapshot.recoveries[0].revision === 2 &&
      (await recoveryRegion()
        .getByRole("button", { name: "恢复到新文件夹…", exact: true })
        .isEnabled()),
  );
  check(
    "old operation proof cannot replace canonical newer revision",
    s.snapshot.operation.recovery.revision === 1 &&
      s.snapshot.recoveries[0].revision === 2,
  );
  await snap("cold-canonical-verified");
  await noAgent("cold recovery catalogue");

  await load("draft-cold-held");
  await page.waitForFunction(() =>
    window.fixture.current().calls.some((c) => c.cmd === "worktree_list"),
  );
  await page.waitForTimeout(550);
  s = await current();
  check(
    "remembered draft waits for first canonical catalogue before opening",
    s.cwd === "/controlled/created-tree" &&
      !count(s, "session_open") &&
      !count(s, "session_prompt"),
  );
  await snap("draft-first-catalogue-held");
  await page.evaluate(() => window.fixture.releaseCatalogue());
  await stableCatalogue();
  await button("管理已归档位置").waitFor();
  s = await current();
  check(
    "confirmed archived draft keeps preparation blocked",
    s.snapshot.archives.length === 1 && !count(s, "session_open"),
  );
  await page.evaluate(() => window.fixture.failAndReload());
  s = await current();
  check(
    "known archived barrier survives failed refresh",
    !!s.snapshot.error && !count(s, "session_open"),
  );
  check(
    "failed refresh displays catalogue uncertainty",
    (await page
      .getByText(
        "此工作位置此前已归档；当前清单尚未确认，请先核对工作树清单。",
        { exact: true },
      )
      .count()) === 1,
  );
  await snap("draft-load-failure");
  await page.evaluate(() => window.fixture.restoreArchives());
  await stableCatalogue();
  await button("管理已归档位置").waitFor();
  await noAgent("remembered archived draft retry");
  await page.evaluate(() => window.fixture.removeArchive());
  await stableCatalogue();
  await page.waitForFunction(() =>
    window.fixture.current().calls.some((c) => c.cmd === "session_open"),
  );
  s = await current();
  check(
    "positive control: confirmed restored cwd permits mocked connection inquiry",
    count(s, "session_open") > 0 &&
      !count(s, "session_prompt") &&
      s.draft.text === "KEEP_CONTROLLED_UNSENT_TEXT" &&
      s.historyCwd === "/controlled/created-tree",
  );
  await snap("restored-cwd-mocked-inquiry-only");
  check(
    "no unexpected controlled IPC",
    !(await current()).unexpected.length,
    (await current()).unexpected,
  );
} catch (e) {
  result.failure = String(e);
  result.body = await page
    .locator("body")
    .innerText()
    .catch(() => null);
  result.current = await current().catch(() => null);
  await snap("failure").catch(() => {});
} finally {
  result.after = hashes();
  result.sourceUnchanged =
    JSON.stringify(result.before) === JSON.stringify(result.after);
  result.passed =
    !result.failure &&
    !result.errors.length &&
    result.checks.every((c) => c.pass) &&
    result.sourceUnchanged;
  clearTimeout(deadline);
  await browser.close();
  fs.writeFileSync(
    `${base}/${engine}-${label}.raw.txt`,
    JSON.stringify(result, null, 2) + "\n",
  );
  fs.writeFileSync(
    `${base}/${engine}-${label}.json`,
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      engine,
      label,
      passed: result.passed,
      checks: result.checks.length,
      failure: result.failure,
      errors: result.errors,
    }),
  );
  process.exitCode = result.passed ? 0 : 1;
}
