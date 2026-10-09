import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(
  "output/2026-10-10-text-feedback-webkit/browsers",
);
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base =
  "docs/evidence/2026-10-09-capability-hardening/text-feedback/webkit-enter";
const engine = process.argv[2] ?? "webkit";
const sourcePath = "src/components/SourceTextSelection.tsx";
const hash = () =>
  createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
const result = { engine, before: hash(), checks: [], errors: [], network: [] };
const browser = await (engine === "webkit" ? webkit : chromium).launch({
  headless: true,
  ...(engine === "chromium"
    ? {
        executablePath:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }
    : {}),
});
try {
  for (const scenario of [
    "empty-selection",
    "outside",
    "changed-before-confirm",
    "changed-during-focus",
    "redirected-focus",
  ]) {
    const page = await browser.newPage({
      viewport: { width: 960, height: 680 },
    });
    page.on("pageerror", (e) => result.errors.push(String(e)));
    await page.route("**/*", (r) => {
      if (!r.request().url().startsWith("http://127.0.0.1:1462/")) {
        result.network.push(r.request().url());
        return r.abort();
      }
      return r.continue();
    });
    await page.goto(`http://127.0.0.1:1462/${base}/index.html`, {
      waitUntil: "networkidle",
    });
    await page.getByText("按行选择", { exact: true }).click();
    await page.getByLabel("起始行", { exact: true }).fill("3");
    await page.getByLabel("结束行", { exact: true }).fill("3");
    if (scenario === "changed-during-focus" || scenario === "redirected-focus")
      await page.evaluate((s) => {
        const action = Array.from(document.querySelectorAll("button")).find(
          (v) => v.textContent === "对此选段提意见",
        );
        action.addEventListener(
          "focus",
          () => {
            if (s === "changed-during-focus")
              document.querySelector("pre").firstChild.textContent = "changed";
            else document.getElementById("outside").focus();
          },
          { once: true },
        );
      }, scenario);
    await page.getByLabel("结束行", { exact: true }).press("Enter");
    await page.waitForTimeout(100);
    const staged = await page.evaluate(() => window.fixture.state());
    if (scenario === "empty-selection")
      await page.evaluate(() => document.getSelection().removeAllRanges());
    if (scenario === "outside") await page.locator("#outside").click();
    if (scenario === "changed-before-confirm") {
      await page.evaluate(() => {
        document.querySelector("pre").firstChild.textContent += "changed";
      });
      await page
        .getByRole("button", { name: "对此选段提意见", exact: true })
        .click();
    }
    await page.waitForTimeout(100);
    const final = await page.evaluate(() => window.fixture.state());
    result.checks.push({
      scenario,
      staged,
      final,
      passed:
        final.confirmDisabled === true &&
        final.confirmations.length === 0 &&
        (scenario === "changed-during-focus" ||
          scenario === "redirected-focus" ||
          staged.confirmDisabled === false),
    });
    await page.close();
  }
} finally {
  await browser.close();
  result.after = hash();
  fs.writeFileSync(
    `${base}/${engine}-boundaries.json`,
    JSON.stringify(result, null, 2) + "\n",
  );
}
console.log(JSON.stringify(result, null, 2));
process.exitCode =
  result.checks.every((c) => c.passed) && !result.errors.length ? 0 : 1;
