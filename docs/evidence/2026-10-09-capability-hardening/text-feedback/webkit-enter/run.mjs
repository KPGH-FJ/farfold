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
const name = process.argv[2] ?? "first";
const engine = process.argv[3] ?? "webkit";
const files = [
  "src/components/SourceTextSelection.tsx",
  "src/components/SourceTextSelection.css",
];
const hashes = () =>
  Object.fromEntries(
    files.map((file) => [
      file,
      createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    ]),
  );
const result = {
  name,
  engine,
  startedAt: new Date().toISOString(),
  before: hashes(),
  scenarios: [],
  network: [],
  errors: [],
};
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
    "click",
    "last-input-enter",
    "first-input-enter",
    "block-input-enter",
  ]) {
    const page = await browser.newPage({
      viewport: { width: 960, height: 680 },
    });
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (!url.startsWith("http://127.0.0.1:1462/")) {
        result.network.push(url);
        return route.abort();
      }
      return route.continue();
    });
    page.on("pageerror", (error) => result.errors.push(String(error)));
    await page.goto(
      `http://127.0.0.1:1462/${base}/index.html${scenario === "block-input-enter" ? "?block=1" : ""}`,
      { waitUntil: "networkidle" },
    );
    await page.getByText("按行选择", { exact: true }).click();
    const first = page.getByLabel("起始行", { exact: true }),
      last = page.getByLabel("结束行", { exact: true });
    const line = scenario === "block-input-enter" ? "1" : "3";
    await first.fill(line);
    await last.fill(line);
    await page.evaluate(() => window.fixture.clear());
    if (scenario === "click")
      await page
        .getByRole("button", { name: "选择这些行", exact: true })
        .click();
    else await (scenario === "first-input-enter" ? first : last).press("Enter");
    await page.waitForTimeout(150);
    const staged = await page.evaluate(() => ({
      state: window.fixture.state(),
      events: [...window.fixture.events],
    }));
    const passed =
      staged.state.confirmDisabled === false &&
      staged.state.confirmations.length === 0;
    await page.screenshot({ path: `${base}/${name}-${scenario}.png` });
    let confirmed = null;
    if (passed) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(100);
      confirmed = await page.evaluate(() => window.fixture.state());
    }
    result.scenarios.push({ scenario, passed, staged, confirmed });
    await page.close();
  }
} finally {
  await browser.close();
  result.after = hashes();
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(
    `${base}/${name}.json`,
    JSON.stringify(result, null, 2) + "\n",
  );
}
const summary = {
  name,
  engine,
  checks: result.scenarios.map(({ scenario, passed, staged, confirmed }) => ({
    scenario,
    passed,
    state: staged.state,
    confirmed,
  })),
  errors: result.errors,
  network: result.network,
  sourceUnchanged:
    JSON.stringify(result.before) === JSON.stringify(result.after),
};
console.log(JSON.stringify(summary, null, 2));
process.exitCode =
  result.scenarios.every((v) => v.passed) && result.errors.length === 0 ? 0 : 1;
