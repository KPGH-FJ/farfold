import fs from "node:fs";
import path from "node:path";
const { webkit } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const browser = await webkit.launch({
  headless: true,
  executablePath: path.resolve(
    "output/2026-10-10-text-feedback-webkit/browsers/webkit-2336/pw_run.sh",
  ),
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) =>
  errors.push({ message: e.message, stack: e.stack }),
);
try {
  await page.goto(
    "http://127.0.0.1:1472/docs/evidence/2026-10-09-capability-hardening/loaded-history-search/independent/index.html",
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.fixture);
  const output = await page.evaluate(async () => {
    try {
      return await window.fixture.searchLoadedConversations(
        window.fixture.keys,
        new Map(
          window.fixture.states.map((s, i) => [
            window.fixture.keys[[0, 1, 2, 4][i]],
            s,
          ]),
        ),
        "USER_ONLY",
      );
    } catch (e) {
      return { error: String(e), stack: e.stack };
    }
  });
  await page.waitForTimeout(500);
  console.log(JSON.stringify({ output, errors }, null, 2));
} finally {
  await browser.close();
}
