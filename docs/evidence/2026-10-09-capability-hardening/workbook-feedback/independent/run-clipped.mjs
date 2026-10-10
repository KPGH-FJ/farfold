import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base =
  "docs/evidence/2026-10-09-capability-hardening/workbook-feedback/independent";
const engine = process.argv[2] ?? "webkit",
  label = process.argv[3] ?? "clipped";
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
  base + "/fixture.tsx",
  base + "/capture-data.json",
  base + "/run-clipped.mjs",
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
  await page.goto(`http://127.0.0.1:1464/${base}/index.html?length=640`, {
    waitUntil: "networkidle",
  });
  await page
    .getByText("CONTROLLED_WORKBOOK_FEEDBACK", { exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "工作表样本", exact: true }).click();
  await page.locator('[data-cell="A2"] button').waitFor();
  const rectangle = { fromRow: 99, toRow: 102, fromColumn: 24, toColumn: 27 };
  const span = (address) =>
    page
      .locator(`[data-cell="${address}"]`)
      .evaluate((e) => ({ rows: e.rowSpan, columns: e.colSpan }));
  const confirm = async () => {
    await page
      .getByRole("button", { name: "对整个合并范围提意见", exact: true })
      .click();
    const a = (await feedback())[0].anchor;
    check(
      "full original range despite clipped DOM",
      Object.keys(rectangle).every((k) => a[k] === rectangle[k]),
      a,
    );
  };
  let shown = await span("X99");
  check(
    "initial window actually clips both row and column extent",
    shown.rows === 2 && shown.columns === 1,
    shown,
  );
  await select("X99");
  check(
    "partial range explicitly disclosed",
    (await page.locator(".workbook-cell-detail").innerText()).includes(
      "合并范围跨越当前显示范围",
    ),
  );
  await confirm();
  const first = JSON.stringify(await feedback());
  await page.getByRole("button", { name: "下一组行", exact: true }).click();
  check(
    "paging withdraws candidate without changing saved anchor",
    (await page
      .getByRole("button", { name: "对整个合并范围提意见", exact: true })
      .count()) === 0 && JSON.stringify(await feedback()) === first,
  );
  shown = await span("X101");
  check(
    "next row window begins inside original merge",
    shown.rows === 2 && shown.columns === 1,
    shown,
  );
  await select("X101");
  await confirm();
  await page.getByRole("button", { name: "下一组列", exact: true }).click();
  shown = await span("Y101");
  check(
    "next column window begins inside original merge",
    shown.rows === 2 && shown.columns === 3,
    shown,
  );
  await select("Y101");
  await confirm();
  const m = await page.evaluate(() => window.fixture.metrics());
  r.metrics = m;
  check(
    "clipped paging/confirm leaves app bounded",
    m.windowY === 0 &&
      m.elements[".app"].y === 0 &&
      m.elements.html.scrollHeight === 820,
  );
  check(
    "no unexpected IPC or errors",
    (await page.evaluate(() => window.unexpected.length === 0)) &&
      r.errors.length === 0,
  );
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
