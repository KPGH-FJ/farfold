import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base =
  "docs/evidence/2026-10-09-capability-hardening/worktree-recycle/independent/browser";
const engine = process.argv[2] ?? "webkit",
  label = process.argv[3] ?? "first";
const owner = JSON.parse(
  fs.readFileSync(
    "docs/evidence/2026-10-09-capability-hardening/worktree-recycle/frontend/implementation.json",
    "utf8",
  ),
);
const inputs = [
  ...owner.sourceRefs.map((r) => r.path),
  "src/App.tsx",
  "src/components/WorkspaceDialog.tsx",
  "src/components/useModalDialog.ts",
  "src/components/EmptyState.tsx",
  "src/components/useDraftWorkLocation.ts",
  "src/components/StorageRecovery.tsx",
  "src/runtime/drafts.ts",
  "src/runtime/setup_storage.ts",
  "src/components/CommandPalette.tsx",
  base + "/fixture.tsx",
  base + "/run.mjs",
  base + "/serve.mjs",
  base + "/index.html",
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
    "Actual App, StorageStartup, DraftStartup, WorktreeManagementHost/dialog, production runtime stores and CSS in React StrictMode; all IPC/settings/Git/process responses are controlled synthetic values. No formal Farfold, real Agent, real worktree or user data.",
  before: hashes(),
  checks: [],
  errors: [],
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
const deadline = setTimeout(() => void browser.close(), 90000);
const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
page.setDefaultTimeout(7000);
page.on("pageerror", (e) => result.errors.push(String(e)));
await page.route("**/*", (r) =>
  r.request().url().startsWith("http://127.0.0.1:1476/")
    ? r.continue()
    : (result.blocked.push(r.request().url()), r.abort()),
);
const button = (name) => page.getByRole("button", { name, exact: true });
const dialog = () => page.getByRole("dialog", { name: "工作树", exact: true });
const review = () =>
  page.getByRole("region", { name: "确认影响", exact: true });
const check = (name, pass, detail) => {
  result.checks.push({ name, pass, detail });
  if (!pass) throw Error(name);
};
const current = () => page.evaluate(() => fixture.current());
const snap = async (name) => {
  const p = base + "/" + engine + "-" + label + "-" + name + ".png";
  await page.screenshot({ path: p });
  result.screenshots.push(p);
};
async function load(mode = "normal") {
  await page.goto("http://127.0.0.1:1476/" + base + "/index.html?mode=" + mode);
  await button("工作树").waitFor();
  await button("工作树").click();
  await dialog().waitFor();
  await dialog()
    .getByText("/controlled/created-tree", { exact: true })
    .waitFor();
}
async function preview(action = "归档并保留文件") {
  await dialog().getByRole("button", { name: action, exact: true }).click();
  await review()
    .getByText("/controlled/retained/tree", { exact: true })
    .waitFor();
}
async function confirm(action = "归档并保留文件") {
  await review()
    .getByRole("checkbox", {
      name: "我已停止其他程序使用这个工作树",
      exact: true,
    })
    .check();
  await review().getByRole("button", { name: action, exact: true }).click();
}
try {
  await load();
  check(
    "StrictMode manager lists without mutation",
    !(await current()).calls.some((c) =>
      /worktree_(recycle_prepare|start)/.test(c.cmd),
    ),
  );
  check(
    "adopted location offers no archive",
    (await dialog()
      .locator("li")
      .filter({ hasText: "/controlled/adopted" })
      .getByRole("button", { name: "归档并保留文件", exact: true })
      .count()) === 0,
  );
  await preview();
  check(
    "inspection does not lock or dispatch and explicit acknowledgement required",
    !(await current()).locked &&
      (await review()
        .getByRole("button", { name: "归档并保留文件", exact: true })
        .isDisabled()),
  );
  check(
    "StrictMode only one inspection for selected record",
    (await current()).calls.filter((c) => c.cmd === "worktree_recycle_inspect")
      .length === 1,
  );
  await confirm();
  await page.waitForFunction(
    () => fixture.current().snapshot.operation?.state === "running",
  );
  let s = await current();
  check(
    "prepare occurs with editing sealed after exact preview baseline",
    s.locked &&
      s.calls.filter((c) => c.cmd === "worktree_recycle_prepare").length ===
        1 &&
      s.calls.find((c) => c.cmd === "worktree_recycle_prepare").locked &&
      s.calls.find((c) => c.cmd === "worktree_recycle_prepare").args
        .expectedDraftBaseline.unsentWork === "c".repeat(64),
  );
  check(
    "active management dialog remains outside inert editing subtree",
    await dialog().evaluate(
      (e) =>
        !e.closest("[inert]") &&
        document.querySelector(".app")?.closest("[inert]") !== null,
    ),
  );
  await snap("running");
  await dialog().getByRole("button", { name: "关闭", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  check(
    "closing management does not release maintenance",
    (await current()).locked,
  );
  await button("查看工作树操作").click();
  await dialog().waitFor();
  check(
    "global recovery opens without a draft target",
    (await current()).request.target === null,
  );
  await page.evaluate(() => fixture.complete());
  await page.waitForFunction(
    () => fixture.current().snapshot.operation?.state === "ready",
  );
  s = await current();
  check(
    "confirmed archive releases only maintenance and separates archive from usable locations",
    !s.locked &&
      s.snapshot.archives.length === 1 &&
      !s.snapshot.locations.some((l) => l.id === "controlled-created"),
  );
  const archivedSection = dialog()
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "已归档的工作树", exact: true }),
    });
  check(
    "archived record cannot use or forget",
    (await archivedSection
      .getByRole("button", { name: "使用此位置", exact: true })
      .count()) === 0 &&
      (await archivedSection
        .getByRole("button", { name: "从清单移除", exact: true })
        .count()) === 0,
  );
  await preview("恢复原位置");
  await confirm("恢复原位置");
  await page.waitForFunction(
    () => fixture.current().snapshot.operation?.state === "running",
  );
  await page.evaluate(() => fixture.complete());
  await page.waitForFunction(
    () =>
      fixture.current().snapshot.operation?.state === "ready" &&
      fixture.current().snapshot.operation.action === "restore",
  );
  s = await current();
  check(
    "explicit restoration never applies to new draft or rewrites historical cwd",
    s.snapshot.archives.length === 0 &&
      s.cwd === "/controlled/unrelated" &&
      s.historyCwd === "/controlled/created-tree" &&
      s.draft.text === "KEEP_CONTROLLED_UNSENT_TEXT",
  );
  check(
    "archive and restore each start once",
    s.calls.filter((c) => c.cmd === "worktree_start").length === 2,
  );
  await snap("restored");

  await load("rejected");
  await preview();
  await confirm();
  await page.waitForFunction(
    () => fixture.current().snapshot.operation?.state === "failed",
  );
  s = await current();
  check(
    "confirmed changed baseline rejects before start and restores editing",
    !s.locked &&
      s.snapshot.operation.code === "draftChanged" &&
      !s.calls.some((c) => c.cmd === "worktree_start") &&
      s.draft.text === "KEEP_CONTROLLED_UNSENT_TEXT",
  );

  await load("late");
  await preview();
  await confirm();
  await page.waitForFunction(() =>
    fixture.current().calls.some((c) => c.cmd === "worktree_recycle_prepare"),
  );
  await dialog().getByRole("button", { name: "关闭", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  await page.evaluate(() => fixture.releasePrepare());
  await page.waitForFunction(
    () => fixture.current().snapshot.operation?.state === "cancelled",
  );
  s = await current();
  check(
    "late prepared after dialog departure cancels exact original operation without starting",
    !s.locked &&
      s.calls.filter((c) => c.cmd === "worktree_cancel").length === 1 &&
      !s.calls.some((c) => c.cmd === "worktree_start"),
  );

  await load("late");
  await preview();
  await confirm();
  const realWaitStarted = Date.now();
  await page.waitForFunction(
    () =>
      fixture.current().snapshot.uncertain &&
      !fixture.current().snapshot.working,
    undefined,
    { timeout: 14000 },
  );
  check(
    "real prepare observation deadline leaves lock and never dispatches start",
    (await current()).locked &&
      !(await current()).calls.some((c) => c.cmd === "worktree_start"),
    {
      observedWaitMs: Date.now() - realWaitStarted,
      note: "Real browser timer, not a resource/OS termination measurement",
    },
  );
  await dialog().getByRole("button", { name: "关闭", exact: true }).click();
  await button("查看工作树操作").click();
  await dialog()
    .getByRole("button", { name: /^请求停止(创建|文件维护)$/, exact: true })
    .click();
  await page.waitForFunction(
    () => fixture.current().snapshot.operation?.state === "cancelled",
  );
  await page.evaluate(() => fixture.releasePrepare());
  await page.waitForTimeout(100);
  check(
    "timeout recovery stays reachable and late prepared cannot revive cancelled operation",
    !(await current()).locked &&
      (await current()).snapshot.operation.state === "cancelled" &&
      !(await current()).calls.some((c) => c.cmd === "worktree_start"),
  );

  await load("prepare-error");
  await preview();
  await confirm();
  await page.waitForFunction(
    () =>
      fixture.current().snapshot.uncertain &&
      !fixture.current().snapshot.working,
  );
  check(
    "rejected IPC alone does not prove maintenance absent",
    (await current()).locked,
  );
  await page.evaluate(() => fixture.mode("wrong-id"));
  await dialog()
    .getByRole("button", { name: "重新核查", exact: true })
    .first()
    .click();
  await page.waitForFunction(() => !fixture.current().snapshot.working);
  check(
    "wrong operation status cannot release current lease",
    (await current()).locked,
  );
  await page.evaluate(() => {
    fixture.mode("normal");
    fixture.legacy(true);
  });
  await dialog()
    .getByRole("button", { name: /^请求停止(创建|文件维护)$/, exact: true })
    .click();
  await page.waitForFunction(
    () => fixture.current().snapshot.operation?.state === "cancelled",
  );
  check(
    "exact cancellation preserves independent legacy exit lock",
    (await current()).locked && !(await current()).snapshot.maintenanceLocked,
  );
  await page.evaluate(() => fixture.legacy(false));
  check(
    "releasing legacy lock after maintenance terminal restores editing",
    !(await current()).locked,
  );

  await load("blocked");
  await preview();
  check(
    "unsent impact cannot be acknowledged or confirmed",
    (await review().getByRole("checkbox").count()) === 0 &&
      (await review()
        .getByRole("button", { name: "归档并保留文件", exact: true })
        .isDisabled()),
  );
  await snap("blocked");
  check(
    "blocked inspection leaves draft and history unchanged",
    (await current()).draft.text === "KEEP_CONTROLLED_UNSENT_TEXT" &&
      (await current()).historyCwd === "/controlled/created-tree",
  );

  await load();
  await page.evaluate(() => fixture.unknownArchive());
  await dialog()
    .getByRole("heading", { name: "已归档的工作树", exact: true })
    .waitFor();
  check(
    "unknown archive cannot restore until explicit check",
    await dialog()
      .getByRole("button", { name: "恢复原位置", exact: true })
      .isDisabled(),
  );
  await dialog().getByRole("button", { name: "核对位置", exact: true }).click();
  await page.waitForFunction(
    () => fixture.current().snapshot.archives[0]?.availability === "verified",
  );
  check(
    "archive check only reads and does not start maintenance",
    !(await current()).locked &&
      !(await current()).calls.some((c) =>
        /worktree_(recycle_prepare|start)/.test(c.cmd),
      ) &&
      (await dialog()
        .getByRole("button", { name: "恢复原位置", exact: true })
        .isEnabled()),
  );
  await page.setViewportSize({ width: 900, height: 620 });
  await preview("恢复原位置");
  await review().getByRole("checkbox").focus();
  await page.keyboard.press("Space");
  await review()
    .getByRole("button", { name: "恢复原位置", exact: true })
    .focus();
  check(
    "narrow viewport keyboard confirmation is reachable with root fixed",
    await review()
      .getByRole("button", { name: "恢复原位置", exact: true })
      .evaluate((e) => {
        const r = e.getBoundingClientRect();
        return (
          document.activeElement === e &&
          r.top >= 0 &&
          r.bottom <= innerHeight &&
          window.scrollY === 0
        );
      }),
  );
  await snap("narrow-keyboard");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => fixture.current().snapshot.operation?.state === "running",
  );
  check(
    "keyboard confirmation explicitly starts restore once",
    (await current()).calls.filter((c) => c.cmd === "worktree_start").length ===
      1,
  );
  check(
    "no Agent/startup/file IPC escaped controlled fixture",
    (await current()).unexpected.length === 0 &&
      !(await current()).calls.some((c) =>
        /^session_(open|prompt|load|cancel)|^agent_connect|^file_delivery_/.test(
          c.cmd,
        ),
      ),
  );
  result.status = "passed";
} catch (e) {
  result.status = "failed";
  result.failure = String(e);
  try {
    await snap("failure");
    result.dom = await page.locator("body").innerText();
    result.state = await current();
  } catch {}
} finally {
  clearTimeout(deadline);
  await browser.close();
  result.after = hashes();
  result.changedInputs = inputs.filter(
    (p) => result.before[p] !== result.after[p],
  );
  result.sourceUnchanged = result.changedInputs.length === 0;
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
      status: result.status,
      checks: result.checks.length,
      passed: result.checks.filter((x) => x.pass).length,
      failure: result.failure,
      errors: result.errors,
      sourceUnchanged: result.sourceUnchanged,
      changedInputs: result.changedInputs,
    }),
  );
  if (result.status !== "passed") process.exitCode = 1;
}
