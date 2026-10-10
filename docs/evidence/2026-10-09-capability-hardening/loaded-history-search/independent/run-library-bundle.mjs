import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base =
  "docs/evidence/2026-10-09-capability-hardening/loaded-history-search/independent";
const engine = process.argv[2] ?? "webkit",
  label = process.argv[3] ?? "first";
const walk = (d) =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
    );
const inputs = [
  ...walk("src"),
  ...["fixture.tsx", "index.html", "serve.mjs", "run-library-bundle.mjs"].map(
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
  label,
  scope:
    "Complete App with production projection/render/search/DOM; controlled in-memory invoke, synthetic index/records. No native/Agent/history/file reads.",
  before: hashes(),
  checks: [],
  errors: [],
  blocked: [],
  network: [],
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
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(10000);
page.on("pageerror", (e) => result.errors.push(String(e)));
page.on("request", (r) => result.network.push(r.url()));
await page.route("**/*", (r) =>
  r.request().url().startsWith("http://127.0.0.1:1472/")
    ? r.continue()
    : (result.blocked.push(r.request().url()), r.abort()),
);
const check = (name, pass, detail) => {
  result.checks.push({ name, pass, detail });
  if (!pass) throw Error(name);
};
const btn = (name) => page.getByRole("button", { name, exact: true });
const palette = page.locator(".command-palette-dialog");
const hits = () => palette.locator(".loaded-search-hit");
async function open() {
  if (!(await palette.isVisible())) await page.keyboard.press("Meta+k");
  await palette.waitFor({ state: "visible" });
}
async function query(text) {
  await palette.getByRole("combobox", { name: "搜索所有对话" }).fill(text);
  await page.waitForFunction((t) => {
    const p = document.querySelector(".command-palette-dialog");
    return (
      p?.querySelector("input")?.value === t &&
      !p
        .querySelector(".loaded-search-summary")
        ?.textContent.includes("正在查找")
    );
  }, text);
}
async function scope(value) {
  await palette.getByRole("combobox", { name: "搜索范围" }).selectOption(value);
  await page.waitForTimeout(180);
}
async function locate(text) {
  await open();
  await scope("body");
  await query(text);
  await hits().first().click();
  await page.getByText("已定位到搜索命中的消息", { exact: true }).waitFor();
}
try {
  await page.goto("http://127.0.0.1:1472/" + base + "/index.html", {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.fixture);
  await page
    .getByRole("button", { name: /^所有对话/ })
    .first()
    .click();
  const library = page.locator(".library-page");
  await library.waitFor({ state: "visible" });
  await library
    .getByRole("combobox", { name: "搜索范围" })
    .selectOption("body");
  const input = library.getByRole("textbox", {
    name: "搜索标题、Agent、分组或位置",
  });
  const settle = async (text) => {
    await input.fill(text);
    await page.waitForFunction((t) => {
      const p = document.querySelector(".library-page");
      return (
        p?.querySelector(".library-search input")?.value === t &&
        !p
          .querySelector(".loaded-search-summary")
          ?.textContent.includes("正在查找")
      );
    }, text);
  };
  await settle("USER_ONLY");
  check(
    "library actual loaded body found",
    (await library.locator(".loaded-search-hit").count()) === 1,
  );
  const coverage = await library.locator(".loaded-search-summary").innerText();
  check(
    "library scope excludes archived entries",
    coverage.includes("已加载 2 个对话") &&
      coverage.includes("1 个对话尚未加载") &&
      coverage.includes("1 个对话的读取尚未确认"),
    coverage,
  );
  await settle("ARCHIVED_BODY");
  check(
    "archived text excluded by active library filter",
    (await library.locator(".loaded-search-hit").count()) === 0,
  );
  await library.getByRole("tab", { name: /已归档/ }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".library-page .loaded-search-hit")
      ?.textContent.includes("ARCHIVED_BODY"),
  );
  check(
    "explicit archived filter admits its loaded body",
    (await library.locator(".loaded-search-hit").count()) === 1,
  );
  const archived = await library.locator(".loaded-search-summary").innerText();
  check(
    "archived coverage counts only selected set",
    archived.includes("已加载 1 个对话") &&
      archived.includes("0 个对话尚未加载"),
    archived,
  );
  await library.locator(".loaded-search-hit").focus();
  await page.keyboard.press("Enter");
  await page.getByText("已定位到搜索命中的消息", { exact: true }).waitFor();
  check(
    "library keyboard hit selects existing archived conversation",
    await page
      .locator(".workspace-message-agent.search-match")
      .innerText()
      .then((t) => t.includes("ARCHIVED_BODY")),
  );
  const workerPath = process.argv[4];
  if (!workerPath) throw Error("Exact built worker path required");
  const bundle = await page.evaluate(async (workerPath) => {
    const worker = new Worker("/" + workerPath, { type: "module" });
    try {
      const request = (id, text) =>
        new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(Error("built timeout")),
            10000,
          );
          worker.onmessage = (e) => {
            clearTimeout(timeout);
            resolve(e.data);
          };
          worker.onerror = (e) => {
            clearTimeout(timeout);
            reject(Error(e.message));
          };
          worker.postMessage({ id, text });
        });
      const entities = await request(
        1,
        "Entity &amp; &notin; &notit; &semi; &#x1F600;",
      );
      const markdown = await request(
        2,
        "Visible **bold** `code` &amp; [link label](https://invalid.example)",
      );
      return { entities, markdown };
    } finally {
      worker.terminate();
    }
  }, workerPath);
  check(
    "actual production bundle decodes official entities",
    JSON.stringify(bundle.entities) ==
      JSON.stringify({ id: 1, fields: ["Entity & ∉ &notit; ; 😀"] }),
    bundle,
  );
  check(
    "actual production bundle matches visible Markdown",
    JSON.stringify(bundle.markdown) ==
      JSON.stringify({ id: 2, fields: ["Visible bold code & link label"] }),
    bundle,
  );
  result.builtWorker = {
    path: workerPath,
    bytes: fs.statSync(workerPath).size,
    sha256: createHash("sha256")
      .update(fs.readFileSync(workerPath))
      .digest("hex"),
  };
  check(
    "all library actions avoid restore/read/send",
    await page.evaluate(() =>
      window.calls.every(
        (c) =>
          !/session_(open|prompt|new|load)|file_delivery|opener/.test(c.cmd),
      ),
    ),
  );
  check("no browser exception", result.errors.length === 0, result.errors);
  await page.screenshot({
    path: base + "/" + engine + "-" + label + "-library.png",
  });
} catch (e) {
  result.failure = String(e);
  await page
    .screenshot({ path: base + "/" + engine + "-" + label + "-failure.png" })
    .catch(() => {});
} finally {
  clearTimeout(deadline);
  result.after = hashes();
  result.sourceUnchanged =
    JSON.stringify(result.before) === JSON.stringify(result.after);
  await browser.close();
  fs.writeFileSync(
    base + "/" + engine + "-" + label + ".raw.txt",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      checks: result.checks,
      failure: result.failure,
      errors: result.errors,
      sourceUnchanged: result.sourceUnchanged,
    }),
  );
}
