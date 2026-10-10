import fs from "node:fs";
import path from "node:path";
const { webkit } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const b =
  "docs/evidence/2026-10-09-capability-hardening/worktree-native-followup/new11/independent/browser";
const browser = await webkit.launch({
  headless: true,
  executablePath: path.resolve(
    "output/2026-10-10-text-feedback-webkit/browsers/webkit-2336/pw_run.sh",
  ),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 800 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/*", (r) =>
    r.request().url().startsWith("http://127.0.0.1:1480/")
      ? r.continue()
      : r.abort(),
  );
  await page.goto("http://127.0.0.1:1480/" + b + "/index.html");
  await page.waitForFunction(() =>
    window.fixture?.current().calls.some((c) => c.cmd === "session_open"),
  );
  await page.waitForTimeout(1200);
  const data = {
    state: await page.evaluate(() => window.fixture.current()),
    body: await page.locator("body").innerText(),
    buttons: await page.getByRole("button").allTextContents(),
    errors,
  };
  fs.writeFileSync(
    b + "/probe-first.json",
    JSON.stringify(data, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      calls: data.state.calls.map((c) => c.cmd),
      body: data.body,
      errors,
    }),
  );
} finally {
  await browser.close();
}
