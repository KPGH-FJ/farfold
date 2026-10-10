import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export const base =
  "docs/evidence/2026-10-09-capability-hardening/docx-reading-position-repair/browser";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const files = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? files(path.join(dir, e.name))
        : [path.join(dir, e.name)],
    );
export async function suite(engine, label, scenarios, candidate = false) {
  const inputs = [
    ...files("src"),
    ...["fixture.tsx", "index.html", "app-captures.json"].map(
      (p) => base + "/" + p,
    ),
    ...fs
      .readdirSync(base)
      .filter((p) => p.endsWith(".mjs"))
      .map((p) => base + "/" + p),
    ...files(base + "/baseline"),
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
    candidate,
    sourceOverlay: label.startsWith("baseline")
      ? JSON.parse(fs.readFileSync(base + "/baseline/inputs.json"))
      : null,
    at: new Date().toISOString(),
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
  try {
    for (const scenario of scenarios) {
      const viewport = scenario.viewport ?? { width: 1280, height: 820 };
      const record = {
        name: scenario.name,
        file: scenario.file,
        viewport,
        checks: [],
        errors: [],
        blocked: [],
        metrics: [],
      };
      result.cases.push(record);
      const page = await browser.newPage({ viewport });
      page.setDefaultTimeout(10000);
      page.on("pageerror", (e) => record.errors.push(String(e)));
      await page.route("**/*", (route) => {
        if (!route.request().url().startsWith("http://127.0.0.1:1467/")) {
          record.blocked.push(route.request().url());
          return route.abort();
        }
        return route.continue();
      });
      const check = (name, pass, detail) => {
        record.checks.push({ name, pass, detail });
        if (!pass) throw new Error(name);
      };
      const feedback = () =>
        page.evaluate(() => Object.values(window.fixture.feedback()));
      const latest = async () => (await feedback()).at(-1);
      const root = async (name) => {
        const m = await page.evaluate(() => window.fixture.metrics());
        record.metrics.push({ name, ...m });
        check(
          name + " root bounded",
          m.windowY === 0 &&
            m.elements[".app"].y === 0 &&
            m.elements.html.scrollHeight <= viewport.height,
          {
            windowY: m.windowY,
            appY: m.elements[".app"].y,
            height: m.elements.html.scrollHeight,
          },
        );
      };
      const confirm = async (type = "paragraph", locator = page) => {
        await locator
          .getByRole("button", {
            name: type === "paragraph" ? "对此段落提意见" : "对此表格提意见",
            exact: true,
          })
          .click();
        await page.getByLabel("补充给 Agent 的意见", { exact: true }).waitFor();
      };
      const anchor = async (name, expected) =>
        check(
          name,
          JSON.stringify((await latest())?.anchor) ===
            JSON.stringify({ kind: "docx-block", ...expected }),
          await latest(),
        );
      try {
        await page.goto(
          `http://127.0.0.1:1467/${base}/index.html?fixture=${scenario.file}&length=640`,
          { waitUntil: "networkidle" },
        );
        if (candidate)
          await page.addStyleTag({
            content: ".document-preview { min-height:0; overflow:auto; }",
          });
        await page
          .getByText("CONTROLLED_DOCX_READING", { exact: true })
          .first()
          .click();
        const original = await page.evaluate(
          () => window.fixture.composer().text,
        );
        await page
          .getByRole("button", { name: "文档样本", exact: true })
          .click();
        await page.locator(".document-preview").waitFor();
        await page
          .locator(".document-paragraph")
          .first()
          .getByRole("button", { name: "下一部分", exact: true })
          .waitFor();
        await scenario.run({
          page,
          engine,
          check,
          feedback,
          latest,
          root,
          confirm,
          anchor,
          original,
          record,
        });
        check(
          "no unintended Agent or external call",
          await page.evaluate(
            () =>
              !window.calls.some((x) =>
                [
                  "session_prompt",
                  "session_send",
                  "file_delivery_open",
                  "file_delivery_reveal",
                ].includes(x.cmd),
              ),
          ),
        );
        check(
          "no unexpected IPC",
          await page.evaluate(() => window.unexpected.length === 0),
          await page.evaluate(() => window.unexpected),
        );
        check("no page errors", record.errors.length === 0, record.errors);
        record.screenshot = `${base}/${engine}-${label}-${scenario.name}.png`;
        await page.screenshot({ path: record.screenshot });
      } catch (error) {
        record.failure = String(error);
        record.body = await page.locator("body").innerText();
        record.calls = await page.evaluate(() => window.calls);
        record.feedback = await feedback();
        record.metrics.push({
          name: "failure",
          ...(await page.evaluate(() => window.fixture.metrics())),
        });
        record.screenshot = `${base}/${engine}-${label}-${scenario.name}-failure.png`;
        await page.screenshot({ path: record.screenshot });
      }
      await page.close();
    }
  } finally {
    await browser.close();
    result.after = hashes();
    result.sourceUnchanged =
      JSON.stringify(result.before) === JSON.stringify(result.after);
    result.passed =
      result.sourceUnchanged && result.cases.every((c) => !c.failure);
    process.exitCode = result.passed ? 0 : 1;
    const raw = JSON.stringify(result, null, 2) + "\n";
    fs.writeFileSync(`${base}/${engine}-${label}.raw.txt`, raw);
    fs.writeFileSync(`${base}/${engine}-${label}.json`, raw);
    console.log(
      JSON.stringify({
        passed: result.passed,
        sourceUnchanged: result.sourceUnchanged,
        cases: result.cases.map((c) => ({
          name: c.name,
          pass: c.checks.filter((x) => x.pass).length,
          failure: c.failure,
        })),
      }),
    );
  }
}
