import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const fixtureBase =
  "docs/evidence/2026-10-09-capability-hardening/workbook-feedback/independent";
const base =
  "docs/evidence/2026-10-09-capability-hardening/docx-feedback/independent";
const engine = process.argv[2] ?? "webkit",
  label = process.argv[3] ?? "automatic";
const files = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((x) =>
      x.isDirectory()
        ? files(path.join(dir, x.name))
        : [path.join(dir, x.name)],
    );
const inputs = [
  ...files("src"),
  fixtureBase + "/fixture.tsx",
  fixtureBase + "/capture-data.json",
  base + "/run-workbook-regression.mjs",
];
const hashes = () =>
  Object.fromEntries(
    inputs.map((p) => [
      p,
      createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
    ]),
  );
const r = {
  engine,
  label,
  at: new Date().toISOString(),
  before: hashes(),
  checks: [],
  errors: [],
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
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(10000);
page.on("pageerror", (e) => r.errors.push(String(e)));
await page.route("**/*", (route) => {
  if (!route.request().url().startsWith("http://127.0.0.1:1464/")) {
    r.blocked.push(route.request().url());
    return route.abort();
  }
  return route.continue();
});
const check = (name, pass, detail) => {
  r.checks.push({ name, pass, detail });
  if (!pass) throw new Error(name);
};
const feedback = () =>
  page.evaluate(() => Object.values(window.fixture.feedback()));
const select = async (address) => {
  await page.locator(`[data-cell="${address}"] button`).click();
  await page.locator(".workbook-cell-detail").waitFor();
};
try {
  await page.goto(
    `http://127.0.0.1:1464/${fixtureBase}/index.html?length=640`,
    {
      waitUntil: "networkidle",
    },
  );
  await page
    .getByText("CONTROLLED_WORKBOOK_FEEDBACK", { exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "工作表样本", exact: true }).click();
  await page.locator('[data-cell="A2"] button').waitFor();
  check(
    "initial no opinion or selection",
    (await feedback()).length === 0 &&
      (await page.locator(".workbook-cell-detail").count()) === 0,
  );
  await page.evaluate(() => {
    window.fixture.blockCapture();
    window.fixture.replace("positions-v2.xlsx");
    window.dispatchEvent(new Event("focus"));
  });
  await page.waitForFunction(() =>
    window.calls.some(
      (x) =>
        x.cmd === "file_delivery_read_workbook" &&
        x.args.file.version === "controlled:positions-v2.xlsx",
    ),
  );
  check(
    "automatic staging does not show unparsed new cell value",
    !(await page
      .locator('[data-cell="A2"] button')
      .evaluateAll((es) => es.some((e) => e.textContent.trim() === "17"))),
  );
  check(
    "automatic staging disables opinion entry",
    await page
      .getByRole("button", { name: "修改意见", exact: true })
      .isDisabled(),
  );
  check(
    "automatic staging has no candidate confirmation",
    (await page
      .getByRole("button", { name: "对此单元格提意见", exact: true })
      .count()) === 0,
  );
  check(
    "held stage preserves actual old A2 zero",
    (await page.locator('[data-cell="A2"] button').innerText()).trim() === "0",
  );
  check(
    "held stage workbook is actually inert",
    await page.locator(".workbook-preview").evaluate((e) => e.inert),
  );
  const a2 = await page.locator('[data-cell="A2"] button').boundingBox();
  if (!a2) throw new Error("old A2 has no browser layout box");
  await page.mouse.click(
    a2.x + Math.min(12, a2.width / 2),
    a2.y + Math.min(12, a2.height / 2),
  );
  check(
    "actual pointer cannot select inert cell",
    (await page.locator(".workbook-cell-detail").count()) === 0,
  );
  const selector = page.locator(".workbook-preview select");
  const previousSheet = await selector.inputValue();
  const box = await selector.boundingBox();
  if (!box) throw new Error("old sheet selector has no browser layout box");
  await page.mouse.click(box.x + 15, box.y + box.height / 2);
  await page.keyboard.press("ArrowDown");
  check(
    "actual pointer/key cannot change inert sheet",
    (await selector.inputValue()) === previousSheet,
  );
  await page
    .getByRole("button", { name: "返回文件与输出", exact: true })
    .focus();
  for (let i = 0; i < 6; i++)
    await page.keyboard.press(engine === "webkit" ? "Alt+Tab" : "Tab");
  check(
    "actual tab navigation skips inert workbook",
    await page
      .locator(".workbook-preview")
      .evaluate((e) => !e.contains(document.activeElement)),
  );
  await page.evaluate(() => window.fixture.releaseCapture());
  await page.waitForFunction(
    () =>
      document.querySelector('[data-cell="A2"] button')?.textContent.trim() ===
      "17",
  );
  check(
    "automatic new version parsed before ready controls",
    !(await page
      .getByRole("button", { name: "修改意见", exact: true })
      .isDisabled()),
  );
  check(
    "prepared result does not repeat native capture",
    (await page.evaluate(
      () =>
        window.calls.filter(
          (x) =>
            x.cmd === "file_delivery_read_workbook" &&
            x.args.file.version === "controlled:positions-v2.xlsx",
        ).length,
    )) === 1,
  );
  await select("A2");
  await page
    .getByRole("button", { name: "对此单元格提意见", exact: true })
    .click();
  const saved = (await feedback())[0];
  check(
    "automatic replacement target uses actual new name/id/version",
    saved.anchor.sheetName === "副本'与&同文" &&
      saved.anchor.sheetId === "rId1" &&
      saved.contentId.includes("positions-v2.xlsx"),
    saved,
  );
  const m = await page.evaluate(() => window.fixture.metrics());
  r.metrics = m;
  check(
    "automatic replacement opinion root bounded",
    m.windowY === 0 &&
      m.elements[".app"].y === 0 &&
      m.elements.html.scrollHeight === 820,
  );
  check(
    "no unexpected IPC",
    await page.evaluate(() => window.unexpected.length === 0),
    await page.evaluate(() => window.unexpected),
  );
  check("no page errors", r.errors.length === 0, r.errors);
  r.screenshot = `${base}/${engine}-${label}.png`;
  await page.screenshot({ path: r.screenshot });
} catch (error) {
  r.failure = String(error);
  r.body = await page.locator("body").innerText();
  r.feedback = await feedback();
  r.calls = await page.evaluate(() => window.calls);
  await page.screenshot({ path: `${base}/${engine}-${label}-failure.png` });
} finally {
  await browser.close();
  r.after = hashes();
  r.sourceUnchanged = JSON.stringify(r.before) === JSON.stringify(r.after);
  r.passed = !r.failure;
  fs.writeFileSync(
    `${base}/${engine}-${label}.raw.txt`,
    JSON.stringify(r, null, 2) + "\n",
  );
  fs.writeFileSync(
    `${base}/${engine}-${label}.json`,
    JSON.stringify(r, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      passed: r.passed,
      sourceUnchanged: r.sourceUnchanged,
      checks: r.checks.length,
      failure: r.failure,
    }),
  );
}
