import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base =
    "docs/evidence/2026-10-09-capability-hardening/visual-area/independent/browser",
  engine = process.argv[2] ?? "webkit";
const walk = (d) =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
    );
const inputs = [
  ...walk("src"),
  ...["restore.tsx", "restore.html", "run-restore.mjs", "serve.mjs"].map(
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
  scope:
    "Actual StorageRestore React component and strict preview parser; controlled dialog/preview IPC only. No apply/recovery command, database, native failure gate or installed App.",
  before: hashes(),
  cases: [],
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
try {
  for (const mode of ["valid", "invalid", "unknown"]) {
    const page = await browser.newPage({
        viewport: { width: 1000, height: 700 },
      }),
      c = { mode, checks: [], errors: [], blocked: [] };
    result.cases.push(c);
    page.setDefaultTimeout(8000);
    page.on("pageerror", (e) => c.errors.push(String(e)));
    await page.route("**/*", (r) =>
      r.request().url().startsWith("http://127.0.0.1:1468/")
        ? r.continue()
        : (c.blocked.push(r.request().url()), r.abort()),
    );
    const check = (name, pass, detail) => {
      c.checks.push({ name, pass, detail });
      if (!pass) throw Error(name);
    };
    try {
      await page.goto(
        `http://127.0.0.1:1468/${base}/restore.html?mode=${mode}`,
      );
      await page
        .getByRole("button", { name: "从副本恢复…", exact: true })
        .click();
      const box = page.getByRole("checkbox"),
        confirm = page.getByRole("button", {
          name: "保存当前副本并恢复…",
          exact: true,
        });
      await box.waitFor();
      check(
        "no selection means confirm disabled",
        await confirm.isDisabled(),
        await page.locator("main").innerText(),
      );
      if (mode === "valid") {
        check(
          "known legacy and area anchors make shared fixture selectable",
          await box.isEnabled(),
          await page.locator("main").innerText(),
        );
        await box.check();
        check(
          "explicit selection permits confirmation",
          await confirm.isEnabled(),
        );
        await box.uncheck();
        check("unselect revokes confirmation", await confirm.isDisabled());
      } else {
        check(
          "invalid/unknown anchor disables recovery choice",
          (await box.isDisabled()) && (await confirm.isDisabled()),
          await page.locator("main").innerText(),
        );
        check(
          "invalid summary is explicit",
          (await page.locator("main").innerText()).includes(
            "无法确认格式或版本",
          ),
        );
      }
      c.calls = await page.evaluate(() => window.calls);
      check(
        "preview only; no apply or other IO command",
        c.calls.length === 2 &&
          c.calls[0].cmd === "plugin:dialog|open" &&
          c.calls[1].cmd === "storage_recovery_restore_preview",
        c.calls,
      );
      check(
        "no page errors/external fetch",
        !c.errors.length && !c.blocked.length,
        { errors: c.errors, blocked: c.blocked },
      );
      c.screenshot = `${base}/${engine}-restore-${mode}.png`;
      await page.screenshot({ path: c.screenshot });
    } catch (e) {
      c.failure = String(e);
      c.body = await page.locator("body").innerText();
    } finally {
      await page.close();
    }
    if (c.failure) break;
  }
} finally {
  await browser.close();
  result.after = hashes();
  result.sourceUnchanged =
    JSON.stringify(result.before) === JSON.stringify(result.after);
  result.passed =
    result.sourceUnchanged &&
    result.cases.length === 3 &&
    result.cases.every((c) => !c.failure);
  const raw = JSON.stringify(result, null, 2) + "\n";
  fs.writeFileSync(`${base}/${engine}-restore.raw.txt`, raw);
  fs.writeFileSync(`${base}/${engine}-restore.json`, raw);
  console.log(
    JSON.stringify({
      passed: result.passed,
      sourceUnchanged: result.sourceUnchanged,
      cases: result.cases.map((c) => ({
        mode: c.mode,
        checks: c.checks.length,
        failure: c.failure,
      })),
    }),
  );
  process.exitCode = result.passed ? 0 : 1;
}
