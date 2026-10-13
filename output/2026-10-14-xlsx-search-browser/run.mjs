import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base = "output/2026-10-14-xlsx-search-browser";
const independent = "output/2026-10-14-xlsx-search-independent";
const engine = process.argv[2],
  label = process.argv[3];
if (!["chromium", "webkit"].includes(engine) || !/^run\d+$/.test(label))
  throw Error("identity required");
const hash = (p) =>
  createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const scan = (p) =>
  fs
    .readdirSync(p, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? scan(p + "/" + e.name) : [p + "/" + e.name],
    );
const refs = () =>
  Object.fromEntries(
    [
      ...scan("src"),
      ...[
        "fixture.tsx",
        "index.html",
        "serve.mjs",
        "run.mjs",
        "captures.json",
        "oracle.json",
        "author.xlsx",
        "second.xlsx",
        "generate-fixtures.py",
        "budget-a.xlsx",
        "budget-b.xlsx",
        "budget-captures.json",
        "budget-oracle.json",
      ].map((n) => base + "/" + n),
      ...[
        "captures.json",
        "author.docx",
        "budget-captures.json",
        "budget-a.docx",
      ].map((n) => "output/2026-10-14-docx-search-browser/" + n),
      ...[
        "generate-supplement.py",
        "captures.json",
        "oracle.json",
        "decoding-fields.xlsx",
        "scope-barriers.xlsx",
        "hidden-only.xlsx",
        "fixture-freeze.json",
      ].map((n) => independent + "/" + n),
      "package.json",
      "pnpm-lock.yaml",
      "vite.config.ts",
    ]
      .sort()
      .map((p) => [p, hash(p)]),
  );
const result = {
  schema: 1,
  engine,
  label,
  scope:
    "Full production App and actual production XLSX and DOCX Workers; controlled Tauri capture/check returns from independently authored synthetic OOXML. No native IO, installed App, real Agent, user data or external network.",
  before: refs(),
  checks: [],
  errors: [],
  externalRequests: [],
  localBlobRequests: [],
  screenshots: [],
  scenarios: [],
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
let page,
  scenario = "start",
  baseline;
const check = (name, pass, detail) => {
  result.checks.push({
    scenario,
    name,
    pass: !!pass,
    ...(detail === undefined ? {} : { detail }),
  });
  if (!pass) throw Error(name);
};
const count = (s, cmd) => s.calls.filter((c) => c.cmd === cmd).length;
const state = () => page.evaluate(() => window.fixture.current());
const panel = () =>
  page.getByRole("region", { name: "查找当前附件文件", exact: true });
const button = (n) => panel().getByRole("button", { name: n, exact: true });
const query = () =>
  page.getByRole("textbox", { name: "搜索所选附件内容…", exact: true });
const scope = () =>
  page.getByRole("combobox", { name: "搜索范围", exact: true });
const box = (n) =>
  panel().getByRole("checkbox", {
    name: new RegExp("^" + n.replaceAll(".", "\\.") + "\\s"),
  });
const mode = (m) => page.evaluate((m) => window.fixture.mode(m), m);
async function load(name, seed = {}) {
  scenario = name;
  if (page) await page.close();
  page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) =>
    result.errors.push({ scenario, error: String(e) }),
  );
  await page.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith("http://127.0.0.1:1538/")) return r.continue();
    if (url.startsWith("blob:http://127.0.0.1:1538/")) {
      result.localBlobRequests.push({ scenario, url });
      return r.continue();
    }
    result.externalRequests.push(url);
    return r.abort();
  });
  await page.addInitScript((seed) => (window.fixtureSeed = seed), seed);
  await page.goto("http://127.0.0.1:1538/" + base + "/index.html");
  await page
    .locator(".product-navigation")
    .getByRole("button", { name: /所有对话/ })
    .click();
  await scope().selectOption("attachments");
  await panel().waitFor();
  baseline = await state();
}
async function choose(names, q = "needle") {
  for (const name of names) await box(name).check();
  await query().fill(q);
}
async function start() {
  await button("开始查找附件").click();
  await page.waitForFunction(
    () =>
      window.fixture.current().search.phase === "complete" &&
      !window.fixture.current().busy,
  );
}
async function shot(name) {
  const file = base + "/" + engine + "-" + label + "-" + name + ".png";
  await page.screenshot({ path: file });
  result.screenshots.push({ file, sha256: hash(file) });
}
async function post() {
  const s = await state();
  check(
    "No Agent or settings-write side effects",
    !s.calls.some((c) =>
      /^(session_prompt|session_open|session_load|session_set_config|history_search_)/.test(
        c.cmd,
      ),
    ) &&
      s.unexpected.length === 0 &&
      count(s, "settings_set") === count(baseline, "settings_set"),
    { unexpected: s.unexpected },
  );
  check("Existing drafts and feedback retained exactly", s.protectedUnchanged);
  result.scenarios.push({
    name: scenario,
    phase: s.search.phase,
    rows: s.search.rows,
    matches: s.search.matches,
    bytes: s.search.bytes,
    workers: s.workers,
    maxActive: s.maxActive,
    calls: s.calls.filter((c) => /^file_delivery_/.test(c.cmd)),
  });
}
const oracle = JSON.parse(fs.readFileSync(base + "/oracle.json", "utf8"));
const supplement = JSON.parse(
  fs.readFileSync(independent + "/oracle.json", "utf8"),
);
const cacheNotice =
  "单元格和公式结果来自文件保存的内容，可能不是最新；不重新计算公式，不展开共享公式，也不更新外部数据。";
const partialNotice =
  "XLSX 存在省略内容或未确认的范围；没有匹配不代表完整工作簿没有匹配。";
const locationKey = (h) =>
  [h.location?.sheetId, h.location?.reference, h.location?.field].join(":");
try {
  await load("real-xlsx-worker-authored-values-and-formulas");
  await choose(["author.xlsx"]);
  let s = await state();
  check(
    "Selecting and typing do not read files or start Workers",
    count(s, "file_delivery_inspect_text") === 0 &&
      count(s, "file_delivery_read_workbook_search") === 0 &&
      s.workers.length === 0,
  );
  await start();
  s = await state();
  check(
    "Five independently authored matches and 226 actual UTF8 bytes",
    s.search.matches === oracle.authorNeedleCount &&
      s.search.bytes === oracle.authorBytes &&
      s.search.rows[0].state === "searched",
    { matches: s.search.matches, bytes: s.search.bytes, row: s.search.rows[0] },
  );
  check(
    "Production complete-input XLSX Worker parsed once",
    s.workers.length === 1 &&
      s.workers[0].messages.includes("inputReady") &&
      count(s, "file_delivery_read_workbook_search") === 1 &&
      count(s, "file_delivery_read_text") === 0,
  );
  const expected = oracle.segments
    .filter((v) => v.text.includes("needle"))
    .map((v) => [v.sheetId, v.reference, v.field].join(":"))
    .sort();
  check(
    "Every location matches declared relationship ID cell and independent field",
    s.search.hits.every((h) => h.location?.kind === "xlsx") &&
      JSON.stringify(s.search.hits.map(locationKey).sort()) ===
        JSON.stringify(expected),
    { expected, actual: s.search.hits.map(locationKey) },
  );
  check(
    "Cache and partial scope explanations are visible without opening details",
    (await panel()
      .getByRole("status")
      .getByText(cacheNotice, { exact: true })
      .isVisible()) &&
      (await panel()
        .getByRole("status")
        .getByText(partialNotice, { exact: true })
        .isVisible()),
  );
  check(
    "Hostile string content remains inert",
    (await panel().locator("img,script,iframe").count()) === 0 &&
      (await page.evaluate(() => window.BAD === undefined)),
  );
  await page.setViewportSize({ width: 780, height: 760 });
  await button("开始查找附件").focus();
  check(
    "Narrow layout fits and keyboard focus reaches start",
    (await button("开始查找附件").evaluate(
      (e) => document.activeElement === e,
    )) &&
      (await panel().evaluate(
        (e) =>
          e.getBoundingClientRect().right <= innerWidth + 1 &&
          e.scrollWidth <= e.clientWidth + 1,
      )),
  );
  await panel()
    .getByRole("heading", { name: "当前文件的匹配片段", exact: true })
    .scrollIntoViewIfNeeded();
  await shot("xlsx-results");
  await panel()
    .getByRole("button", { name: "前往来源附件", exact: true })
    .first()
    .click();
  await page
    .getByText("已定位到来源附件；文件匹配片段仍以本次查找为准。", {
      exact: true,
    })
    .waitFor();
  check(
    "Navigation rechecks and reaches actual source attachment",
    (await page
      .locator('[data-loaded-message="A-message"].search-match')
      .count()) === 1 &&
      (await page
        .locator(
          '[data-loaded-message="A-message"] [data-loaded-attachment="0"]',
        )
        .isVisible()),
  );
  await shot("source-location");
  await post();

  await load("precise-values-unicode-and-formula-cache-separation");
  await choose(["author.xlsx"], "汉😀é");
  for (const [term, cell, field] of [
    ["汉😀é", "A1", "value"],
    ["12345678901234567890.000100", "B1", "value"],
    ["#DIV/0!", "D1", "value"],
    ["NO_CACHE_FORMULA", "I1", "formula"],
    ["EMPTY_CACHE_FORMULA", "J1", "formula"],
    ["needle formula-only", "F1", "formula"],
    ["needle cached-result", "F1", "savedCache"],
  ]) {
    await query().fill(term);
    await start();
    s = await state();
    check(
      "Exact authored field " + cell + "/" + field + " for " + term,
      s.search.matches === 1 &&
        s.search.hits[0].location.reference === cell &&
        s.search.hits[0].location.field === field,
    );
  }
  await query().fill("0");
  await start();
  s = await state();
  check(
    "Shared string index and absent or empty cache do not become numeric zero",
    !s.search.hits.some(
      (h) =>
        h.location.reference === "A1" ||
        (["I1", "J1"].includes(h.location.reference) &&
          h.location.field === "savedCache"),
    ) &&
      s.search.hits.some(
        (h) =>
          h.location.reference === "K1" && h.location.field === "savedCache",
      ),
  );
  await post();

  await load("hidden-and-generated-labels-excluded");
  await choose(["author.xlsx"]);
  for (const term of oracle.negativeTerms) {
    await query().fill(term);
    await start();
    s = await state();
    check(
      "No false match for " + term,
      s.search.matches === 0 && s.search.rows[0].state === "searched",
    );
  }
  await post();

  await load("two-workbooks-serialize-production-workers");
  await choose(["author.xlsx", "second.xlsx"]);
  await start();
  s = await state();
  check(
    "Two selected XLSX files complete without self-contention",
    s.search.rows.length === 2 &&
      s.search.rows.every((r) => r.state === "searched") &&
      s.search.matches === oracle.authorNeedleCount + oracle.secondNeedleCount,
    { rows: s.search.rows, matches: s.search.matches },
  );
  check(
    "Both real input Workers and bounded admitted capture concurrency",
    s.workers.length === 2 &&
      s.workers.every((w) => w.messages.includes("inputReady")) &&
      s.maxActive <= 2,
  );
  await post();

  await load("text-docx-xlsx-share-search");
  await choose(["author.xlsx", "author.docx", "a.txt"]);
  await start();
  s = await state();
  check(
    "Three file formats share one result set",
    s.search.matches === 15 &&
      s.search.rows.every((r) => r.state === "searched") &&
      count(s, "file_delivery_read_workbook_search") === 1 &&
      count(s, "file_delivery_read_docx_search") === 1 &&
      count(s, "file_delivery_read_text") === 1,
    { matches: s.search.matches },
  );
  check(
    "Both production parser types ran and text hit shape is unchanged",
    s.workers.length === 2 &&
      s.workers.some((w) => w.messages.includes("inputReady")) &&
      s.workers.some((w) => w.messages.includes("ready")) &&
      s.search.hits
        .filter((h) => h.source.name === "a.txt")
        .every((h) => h.location === undefined),
  );
  await post();

  for (const other of ["budget-b.xlsx", "budget-a.docx"]) {
    await load("actual-utf8-budget-with-" + other, { budget: true });
    await choose(["budget-a.xlsx", other, "a.txt"]);
    await start();
    s = await state();
    const plain = s.search.rows.find((r) => r.source.name === "a.txt");
    check(
      "Nine-million extracted UTF8 bytes rather than compressed source bytes govern budget",
      s.search.rows[0].state === "searched" &&
        s.search.rows[1].state === "skipped" &&
        s.search.rows[1].code === "budget" &&
        plain.state === "searched" &&
        s.search.bytes === 9000007 + plain.file.size &&
        s.search.matches === 3,
      { bytes: s.search.bytes, rows: s.search.rows, matches: s.search.matches },
    );
    check(
      "Both actual Workers ran before budget decision",
      s.workers.length === 2 &&
        s.workers[0].messages.includes("inputReady") &&
        s.workers[1].messages.includes(
          other.endsWith(".xlsx") ? "inputReady" : "ready",
        ),
    );
    check(
      "Saved-cache warning remains visible on complete workbook reads",
      await panel()
        .getByRole("status")
        .getByText(cacheNotice, { exact: true })
        .isVisible(),
    );
    await post();
  }

  for (const item of supplement.cases) {
    await load("independent-" + item.file);
    await choose([item.file], item.queries?.[0].query ?? "needle");
    if (item.expectedError) {
      await start();
      s = await state();
      check(
        "Only hidden sheets report empty visible scope without expanding authorization",
        s.search.rows[0].code === item.expectedError &&
          s.search.hits.length === 0 &&
          s.search.bytes === 0 &&
          s.workers.length === 1,
        { row: s.search.rows[0] },
      );
    } else {
      for (const entry of item.queries) {
        await query().fill(entry.query);
        await start();
        s = await state();
        check(
          "Independent " + item.file + " query " + entry.query,
          s.search.matches === entry.expectedOccurrences &&
            s.search.rows[0].state === "searched" &&
            s.search.bytes === item.searchableUtf8Bytes,
          { matches: s.search.matches, bytes: s.search.bytes },
        );
        const expected = item.segments
          .filter((segment) =>
            segment.text
              .toLocaleLowerCase()
              .includes(entry.query.toLocaleLowerCase()),
          )
          .map((segment) =>
            [segment.sheetId, segment.reference, segment.field].join(":"),
          )
          .sort();
        check(
          "Independent field locations for " + entry.query,
          JSON.stringify(s.search.hits.map(locationKey).sort()) ===
            JSON.stringify(expected),
        );
      }
      check(
        "Independent partial scope and cache notice visibly retained",
        s.search.rows[0].workbook?.partial === item.expectedPartial &&
          (await panel()
            .getByRole("status")
            .getByText(cacheNotice, { exact: true })
            .isVisible()),
      );
      if (item.requiredWarnings)
        check(
          "Independent omission kinds are preserved",
          item.requiredWarnings.every((code) =>
            s.search.rows[0].workbook.warnings.some((w) => w.code === code),
          ),
        );
    }
    await post();
  }

  await load("capture-source-version-mismatch");
  await choose(["author.xlsx"]);
  await mode({ captureChanged: true });
  await start();
  s = await state();
  check(
    "Changed captured source cannot parse or publish",
    s.search.hits.length === 0 &&
      s.search.rows[0].code === "changed" &&
      s.workers.length === 0,
  );
  await post();

  for (const mutation of ["sourceChange", "mimeChange", "indexChange"]) {
    await load("late-xlsx-" + mutation);
    await choose(["author.xlsx"]);
    await mode({ hold: true, stage: "capture" });
    await button("开始查找附件").click();
    await page.waitForFunction(() => window.fixture.current().held === 1);
    await page.evaluate((m) => window.fixture[m](), mutation);
    await page.evaluate(() => window.fixture.release());
    await page.waitForFunction(() => !window.fixture.current().busy);
    s = await state();
    check(
      "Changed source owner discards late capture before Worker or publication",
      s.search.hits.length === 0 &&
        s.workers.length === 0 &&
        count(s, "file_delivery_check_text_revision") === 0,
    );
    await post();
  }

  await load("equal-index-refresh-retains-authorization");
  await choose(["author.xlsx"]);
  await mode({ hold: true, stage: "capture" });
  await button("开始查找附件").click();
  await page.waitForFunction(() => window.fixture.current().held === 1);
  await page.evaluate(() => window.fixture.refresh());
  await page.evaluate(() => window.fixture.release());
  await page.waitForFunction(
    () =>
      window.fixture.current().search.phase === "complete" &&
      !window.fixture.current().busy,
  );
  s = await state();
  check(
    "Semantically unchanged index retains selected workbook result",
    s.search.matches === 5 && s.search.rows[0].state === "searched",
  );
  await post();

  await load("cancel-capture");
  await choose(["author.xlsx"]);
  await mode({ hold: true, stage: "capture" });
  await button("开始查找附件").click();
  await page.waitForFunction(() => window.fixture.current().held === 1);
  await button("取消本次附件查找").click();
  check(
    "Cancel does not dispatch another read",
    count(await state(), "file_delivery_read_workbook_search") === 1,
  );
  await page.evaluate(() => window.fixture.release());
  await page.waitForFunction(() => !window.fixture.current().busy);
  s = await state();
  check(
    "Cancelled capture publishes no results or Worker",
    s.search.hits.length === 0 && s.workers.length === 0,
  );
  await post();

  await load("changed-before-navigation");
  await choose(["author.xlsx"]);
  await start();
  await mode({ changed: true });
  await panel()
    .getByRole("button", { name: "前往来源附件", exact: true })
    .first()
    .click();
  await panel().getByRole("alert").waitFor();
  s = await state();
  check(
    "Revision mismatch removes results before navigation",
    s.search.hits.length === 0 &&
      s.search.error === "changed" &&
      (await button("开始查找附件").isEnabled()),
  );
  await post();
} catch (error) {
  result.failure = String(error);
  if (page) {
    result.diagnostic = {
      scenario,
      body: await page
        .locator("body")
        .innerText()
        .catch(() => ""),
      aria: await page
        .locator("body")
        .ariaSnapshot()
        .catch(() => ""),
      state: await state().catch(() => null),
    };
    await shot("failure").catch(() => {});
  }
} finally {
  await browser.close();
  result.after = refs();
  result.stable =
    JSON.stringify(result.before) === JSON.stringify(result.after);
  result.passed =
    !result.failure &&
    result.stable &&
    !result.errors.length &&
    !result.externalRequests.length;
  fs.writeFileSync(
    base + "/" + engine + "-" + label + ".json",
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      engine,
      label,
      passed: result.passed,
      checks: result.checks.length,
      failure: result.failure,
      errors: result.errors,
      externalRequests: result.externalRequests,
      stable: result.stable,
    }),
  );
  process.exitCode = result.passed ? 0 : 1;
}
