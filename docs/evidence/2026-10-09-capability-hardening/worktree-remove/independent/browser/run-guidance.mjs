import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base =
  "docs/evidence/2026-10-09-capability-hardening/worktree-remove/independent/browser";
const engine = process.argv[2] ?? "webkit",
  label = process.argv[3] ?? "first";
const owner = JSON.parse(
  fs.readFileSync(
    "docs/evidence/2026-10-09-capability-hardening/worktree-remove/frontend/final.json",
    "utf8",
  ),
);
const notice = JSON.parse(
  fs.readFileSync(
    "docs/evidence/2026-10-09-capability-hardening/archived-work-location/implementation.json",
    "utf8",
  ),
);
const inputs = [
  ...new Set([
    ...owner.ownedSourceRefs.map((r) => r.path),
    ...notice.sourceRefs.map((r) => r.path),
    "src/App.tsx",
    "src/components/StorageRecovery.tsx",
    "src/components/DraftStartup.tsx",
    "src/components/WorktreeManagementHost.tsx",
    "src/runtime/worktree_management.ts",
    "src/runtime/draft_storage.ts",
    "src/runtime/setup_storage.ts",
    ...["fixture.tsx", "run.mjs", "serve.mjs", "index.html"].map(
      (f) => base + "/" + f,
    ),
  ]),
];
inputs.push(base + "/run-guidance.mjs");
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
    "Actual complete App and React StrictMode, production stores/components/CSS. Controlled IPC, in-memory settings, synthetic filesystem/Git replies; no actual delete/recover or native app/Agent/user data.",
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
const timer = setTimeout(() => void browser.close(), 120000);
const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
page.setDefaultTimeout(6500);
page.on("pageerror", (e) => result.errors.push(String(e)));
await page.route("**/*", (r) =>
  r.request().url().startsWith("http://127.0.0.1:1477/")
    ? r.continue()
    : (result.blocked.push(r.request().url()), r.abort()),
);
const button = (n) => page.getByRole("button", { name: n, exact: true });
const dialog = () => page.getByRole("dialog", { name: "工作树", exact: true });
const review = () =>
  page.getByRole("region", { name: "删除已归档的工作文件", exact: true });
const ack = "我已查看恢复副本和删除位置，确认永久删除此处的工作文件";
const current = () => page.evaluate(() => fixture.current());
const check = (name, pass, detail) => {
  result.checks.push({ name, pass, detail });
  if (!pass) throw Error(name);
};
const count = (s, cmd) => s.calls.filter((c) => c.cmd === cmd).length;
async function snap(n) {
  const p = `${base}/${engine}-${label}-${n}.png`;
  await page.screenshot({ path: p });
  result.screenshots.push(p);
}
async function load(mode = "normal", open = true) {
  await page.goto(`http://127.0.0.1:1477/${base}/index.html?mode=${mode}`);
  await button("工作树").waitFor();
  if (open) {
    await button("工作树").click();
    await dialog().waitFor();
    await dialog()
      .getByRole("button", { name: "删除工作文件…", exact: true })
      .waitFor();
  }
}
async function inspect() {
  await dialog()
    .getByRole("button", { name: "删除工作文件…", exact: true })
    .click();
  await review()
    .getByRole("checkbox", {
      name: "我已停止其他程序使用这个工作树",
      exact: true,
    })
    .waitFor();
}
async function prepare(keyboard = false) {
  await inspect();
  await review()
    .getByRole("checkbox", {
      name: "我已停止其他程序使用这个工作树",
      exact: true,
    })
    .check();
  const b = review().getByRole("button", {
    name: "准备提交恢复副本",
    exact: true,
  });
  if (keyboard) {
    await b.focus();
    await page.keyboard.press("Enter");
  } else await b.click();
}
async function prepared() {
  await page.evaluate(() => fixture.prepared());
  await page.evaluate(() => fixture.query());
  await review().getByRole("checkbox", { name: ack, exact: true }).waitFor();
}
async function unchanged(name) {
  const s = await current();
  check(
    name,
    s.draft.text === "KEEP_CONTROLLED_UNSENT_TEXT" &&
      s.historyCwd === "/controlled/created-tree" &&
      s.cwd === "/controlled/unrelated",
  );
}
try {
  for (const kind of ["archive", "recovery"]) {
    await load("known-" + kind, false);
    await page.evaluate(() => fixture.loadCatalogue());
    check(
      kind + " navigation precondition is ready catalogue before click",
      (await current()).snapshot.ready,
    );
    await button("CONTROLLED_HISTORY_UNMOVED").click();
    const label = kind === "archive" ? "管理已归档位置" : "管理提交恢复副本";
    await button(label).waitFor();
    let s = await current();
    check(
      kind +
        " known navigation does not reconnect and preserves loaded history",
      !count(s, "session_open") &&
        !count(s, "session_prompt") &&
        (await page
          .getByText("CONTROLLED_HISTORY_UNMOVED_BODY", { exact: true })
          .isVisible()),
    );
    check(
      kind + " guidance removes reconnect and does not change cwd",
      (await button("重连").count()) === 0 &&
        s.historyCwd === "/controlled/created-tree" &&
        s.cwd === "/controlled/unrelated",
    );
    await button(label).click();
    await dialog().waitFor();
    s = await current();
    check(
      kind + " opens management only without draft or backup selection",
      s.request.target === null &&
        !count(s, "worktree_recover_prepare") &&
        !count(s, "worktree_recycle_prepare") &&
        !count(s, "worktree_start"),
    );
    if (kind === "recovery") {
      check(
        "multiple recovery copies remain separate explicit choices",
        (await dialog()
          .getByRole("button", { name: "恢复到新文件夹…", exact: true })
          .count()) === 2,
      );
      await dialog()
        .getByText("/controlled/recovery-copy-two", { exact: true })
        .scrollIntoViewIfNeeded();
      await snap("multiple-recovery-choices");
    }
    await dialog().getByRole("button", { name: "关闭", exact: true }).click();
    if (kind === "archive")
      await page.evaluate(() => fixture.restoreCatalogue());
    else await page.evaluate(() => fixture.clearRecovery());
    await button("重连").waitFor();
    check(
      kind +
        " association removal restores explicit retry but never dispatches itself",
      (await button(label).count()) === 0 &&
        !count(await current(), "session_open"),
    );
  }
  await load("known-recovery", false);
  await page.evaluate(() => fixture.loadCatalogue());
  await button("CONTROLLED_HISTORY_UNMOVED").click();
  await button("管理提交恢复副本").waitFor();
  await page.evaluate(() => fixture.catalogue("hold"));
  await button("重连").waitFor();
  check(
    "recovery catalogue loading withdraws stale guidance",
    (await button("管理提交恢复副本").count()) === 0,
  );
  await page.evaluate(() => fixture.releaseLoad());
  await button("管理提交恢复副本").waitFor();
  await page.evaluate(() => fixture.catalogue("error"));
  await button("重连").waitFor();
  check(
    "failed recovery catalogue does not claim current backup association",
    (await button("管理提交恢复副本").count()) === 0 &&
      !count(await current(), "session_open"),
  );
  await load("recovery-cold", false);
  await button("管理提交恢复副本").waitFor();
  let s = await current();
  check(
    "cold recovery guidance preserves remembered path and exact unsent text",
    s.cwd === "/controlled/created-tree" &&
      s.draft.text === "KEEP_CONTROLLED_UNSENT_TEXT" &&
      !count(s, "session_open") &&
      !count(s, "session_prompt"),
  );
  check(
    "copy guidance does not promise deleted or original-path restoration",
    (await page
      .getByText(
        "此工作位置有关联的提交恢复副本，请到工作树管理中核验并选择恢复位置。",
        { exact: true },
      )
      .isVisible()) &&
      (await page
        .getByText("工作位置已归档，请先核对并恢复原位置。", { exact: true })
        .count()) === 0 &&
      (await page
        .getByText("无法读取工作设置，请重试", { exact: true })
        .count()) === 0,
  );
  await snap("cold-recovery-guidance");
  check(
    "controlled followup has no unexpected IPC",
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
    result.checks.every((c) => c.pass) &&
    !result.errors.length &&
    result.sourceUnchanged;
  clearTimeout(timer);
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
