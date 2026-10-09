import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base =
  "docs/evidence/2026-10-09-capability-hardening/text-feedback/native-scroll-review";
const r = {
  at: new Date().toISOString(),
  cases: [],
  cssBefore: createHash("sha256")
    .update(fs.readFileSync("src/components/TextBlockPreview.css"))
    .digest("hex"),
};
for (const [engine, type] of [
  ["webkit", webkit],
  ["chromium", chromium],
]) {
  const item = { engine, checks: [], errors: [] };
  r.cases.push(item);
  const browser = await type.launch({
    headless: true,
    executablePath:
      engine === "webkit"
        ? path.resolve(
            "output/2026-10-10-text-feedback-webkit/browsers/webkit-2336/pw_run.sh",
          )
        : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 900, height: 620 },
    });
    page.setDefaultTimeout(10000);
    await page.route("**/*", (route) =>
      route.request().url().startsWith("http://127.0.0.1:1463/")
        ? route.continue()
        : route.abort(),
    );
    page.on("pageerror", (e) => item.errors.push(String(e)));
    const check = async (label, extra = true) => {
      const m = await page.evaluate(() => window.fixture.metrics());
      const pass =
        extra &&
        m.windowY === 0 &&
        m.elements[".app"].y === 0 &&
        m.elements.html.scrollHeight <= 620;
      item.checks.push({ label, pass, metrics: m });
      if (!pass) throw new Error(label);
    };
    await page.goto(`http://127.0.0.1:1463/${base}/index.html?length=640`, {
      waitUntil: "networkidle",
    });
    await page
      .getByText("CONTROLLED_SCROLL_LAYOUT", { exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "大文本选段", exact: true }).click();
    await page.getByText("按行选择", { exact: true }).click();
    await page.getByLabel("结束行", { exact: true }).click();
    await page.keyboard.press("Tab");
    await check(
      "Tab from number field",
      await page
        .locator(".text-block-preview")
        .evaluate(
          (e) =>
            e.contains(document.activeElement) &&
            document.activeElement?.tagName !== "INPUT",
        ),
    );
    await page.getByLabel("结束行", { exact: true }).focus();
    await page.keyboard.press("Enter");
    await check(
      "keyboard selection confirmation focused",
      await page
        .getByRole("button", { name: "对此选段提意见", exact: true })
        .evaluate((e) => e === document.activeElement),
    );
    await page.keyboard.press("Enter");
    await page.getByLabel("补充给 Agent 的意见", { exact: true }).waitFor();
    await check("keyboard feedback focus");
    await page.locator(".text-block-content").focus();
    await check("pre keyboard focus remains local");
    const before = await page
      .locator(".text-block-content")
      .evaluate((e) => e.scrollTop);
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(250);
    const after = await page
      .locator(".text-block-content")
      .evaluate((e) => e.scrollTop);
    await check("PageDown scrolls original text locally", after > before);
    await page.getByLabel("片段序号", { exact: true }).focus();
    await check("return to fragment control");
    item.passed = item.errors.length === 0;
    await page.screenshot({ path: `${base}/keyboard-${engine}.png` });
  } catch (e) {
    item.failure = String(e);
    item.passed = false;
  } finally {
    await browser.close();
  }
}
r.cssAfter = createHash("sha256")
  .update(fs.readFileSync("src/components/TextBlockPreview.css"))
  .digest("hex");
r.passed = r.cssBefore === r.cssAfter && r.cases.every((c) => c.passed);
fs.writeFileSync(`${base}/keyboard.json`, JSON.stringify(r, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      passed: r.passed,
      cases: r.cases.map((c) => ({
        engine: c.engine,
        passed: c.passed,
        checks: c.checks.length,
        failure: c.failure,
      })),
    },
    null,
    2,
  ),
);
process.exitCode = r.passed ? 0 : 1;
