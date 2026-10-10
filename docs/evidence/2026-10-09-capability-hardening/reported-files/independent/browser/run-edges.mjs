import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base =
  "docs/evidence/2026-10-09-capability-hardening/reported-files/independent/browser";
const engine = process.argv[2] ?? "webkit",
  label = process.argv[3] ?? "edges";
const walk = (d) =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
    );
const inputs = [
  ...walk("src"),
  ...["fixture.tsx", "index.html", "serve.mjs", "run-edges.mjs"].map(
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
    "Actual complete App, controlled failed/delayed IPC; no real filesystem/native/Agent.",
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
async function scenario(name, body) {
  const record = { name, checks: [], errors: [], blocked: [] };
  result.cases.push(record);
  const context = await browser.newContext({
      viewport: { width: 1280, height: 820 },
    }),
    p = await context.newPage();
  p.setDefaultTimeout(10000);
  p.on("pageerror", (e) => record.errors.push(String(e)));
  await p.route("**/*", (r) =>
    r.request().url().startsWith("http://127.0.0.1:1470/")
      ? r.continue()
      : (record.blocked.push(r.request().url()), r.abort()),
  );
  const btn = (name) => p.getByRole("button", { name, exact: true });
  const check = (name, pass, detail) => {
    record.checks.push({ name, pass, detail });
    if (!pass) throw Error(name);
  };
  try {
    await p.goto("http://127.0.0.1:1470/" + base + "/index.html", {
      waitUntil: "networkidle",
    });
    await btn("CONTROLLED_P19_REPORTED_FILES").click();
    await btn("查看对话内容").click();
    await p.getByRole("region", { name: "报告的文件", exact: true }).waitFor();
    await body(p, btn, check);
    check(
      "no unexpected IPC/browser error",
      (await p.evaluate(() => window.unexpected)).length === 0 &&
        record.errors.length === 0 &&
        record.blocked.length === 0,
      { errors: record.errors, blocked: record.blocked },
    );
  } catch (error) {
    record.failure = String(error);
    record.diagnostic = await p
      .locator("body")
      .innerText()
      .catch(() => "");
    await p
      .screenshot({
        path: base + "/" + engine + "-" + label + "-" + name + "-failure.png",
      })
      .catch(() => {});
  } finally {
    await context.close();
  }
}
try {
  await scenario("missing", async (p, btn, check) => {
    await btn("查看文件 /controlled/report one.md").click();
    await p.getByText("Controlled report V1", { exact: true }).waitFor();
    await btn("修改意见").click();
    await p
      .getByRole("textbox", { name: "补充给 Agent 的意见", exact: true })
      .fill("P19_FAILURE_RETAINS_ORIGINAL");
    const draft = await p.evaluate(() =>
      JSON.stringify(window.fixture.feedback()),
    );
    await btn("返回文件与输出").click();
    await p.evaluate(() => window.fixture.setInspection("missing"));
    await btn("查看文件 /controlled/location-only.md").click();
    await p
      .getByText("未能打开文件，请检查位置后重试。", { exact: true })
      .waitFor();
    check(
      "failed reported location has no stale success preview",
      (await p.getByText("Controlled report V1", { exact: true }).count()) ===
        0,
    );
    check(
      "failed opening preserves exact old feedback",
      (await p.evaluate(() => JSON.stringify(window.fixture.feedback()))) ===
        draft,
    );
    check(
      "failure keeps explicit retry and location fallback",
      (await btn("重新打开").isEnabled()) &&
        (await btn("打开所选位置").isEnabled()),
    );
    const calls = await p.evaluate(() => window.fixture.fileCalls());
    check(
      "failure does not read or search a substitute",
      calls.filter((c) => c.cmd === "file_delivery_read_text").length === 1 &&
        calls
          .filter((c) => c.cmd === "file_delivery_inspect_selected")
          .every((c) =>
            [
              "/controlled/report one.md",
              "/controlled/location-only.md",
            ].includes(c.args.path),
          ),
      calls,
    );
    await p.screenshot({
      path: base + "/" + engine + "-" + label + "-missing.png",
    });
  });
  await scenario("hidden-late", async (p, btn, check) => {
    await p.evaluate(() => {
      const original = window.testInvoke;
      let release;
      const hold = new Promise((r) => (release = r));
      window.releaseOwnedHold = release;
      window.testInvoke = async (cmd, args) => {
        const result = await original(cmd, args);
        if (cmd === "file_delivery_inspect_selected") await hold;
        return result;
      };
    });
    await btn("查看文件 /controlled/report one.md").click();
    await p.getByText("正在打开文件…", { exact: true }).waitFor();
    check(
      "pending inspection has not read content",
      (await p.evaluate(() => window.fixture.fileCalls())).every(
        (c) => c.cmd !== "file_delivery_read_text",
      ),
    );
    await p.locator(".artifact-pane .a-close").click();
    await p.evaluate(() => window.releaseOwnedHold());
    await p.waitForTimeout(150);
    check(
      "hidden original selection discards late inspection before content read",
      (await p.evaluate(() => window.fixture.fileCalls())).every(
        (c) => c.cmd !== "file_delivery_read_text",
      ),
    );
    await btn("查看对话内容").click();
    await p.getByText("此次打开已暂停。", { exact: true }).waitFor();
    check(
      "reopen does not silently retry late file selection",
      (await p.evaluate(() => window.fixture.fileCalls())).every(
        (c) => c.cmd !== "file_delivery_read_text",
      ),
    );
    await btn("返回文件与输出").click();
    await btn("查看文件 /controlled/location-only.md").click();
    await p.getByText("Controlled report V1", { exact: true }).waitFor();
    const reads = await p.evaluate(() =>
      window.fixture
        .fileCalls()
        .filter((c) => c.cmd === "file_delivery_read_text"),
    );
    check(
      "next explicit file reads only its own exact selected path",
      reads.length === 1 &&
        reads[0].args.file.path === "/controlled/location-only.md",
      reads,
    );
    check(
      "no Agent dispatch in delayed open path",
      !(await p.evaluate(() => window.calls)).some(
        (c) => c.cmd === "session_prompt",
      ),
    );
  });
} finally {
  result.after = hashes();
  result.sourceUnchanged =
    JSON.stringify(result.before) === JSON.stringify(result.after);
  result.passed = result.cases.every(
    (c) => !c.failure && c.checks.every((x) => x.pass),
  );
  await browser.close();
  fs.writeFileSync(
    base + "/" + engine + "-" + label + ".raw.txt",
    JSON.stringify(result, null, 2) + "\n",
  );
  fs.writeFileSync(
    base + "/" + engine + "-" + label + ".json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      engine,
      label,
      passed: result.passed,
      checks: result.cases.reduce((n, c) => n + c.checks.length, 0),
      sourceUnchanged: result.sourceUnchanged,
      failures: result.cases.flatMap((c) =>
        c.failure ? [{ name: c.name, error: c.failure }] : [],
      ),
    }),
  );
}
