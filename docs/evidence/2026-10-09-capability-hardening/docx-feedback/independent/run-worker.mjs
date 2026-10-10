import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  chromium,
  webkit,
} from "/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
const base =
  "docs/evidence/2026-10-09-capability-hardening/docx-feedback/independent";
const engine = process.argv[2];
if (!["webkit", "chromium"].includes(engine)) throw Error("Expected engine");
const sources = [
  "docx_parse",
  "docx_package",
  "docx_types",
  "docx_xml",
  "docx_styles",
  "docx_numbering",
  "docx_table",
  "docx_images",
  "docx_decode",
  "docx_source_position",
  "docx_validation",
  "docx_preview",
  "image_bytes",
]
  .map((n) => "src/runtime/" + n + ".ts")
  .concat([
    "src/workers/docx_preview.worker.ts",
    base + "/worker.html",
    base + "/captures.json",
    base + "/oracle-supplement.json",
  ]);
const snapshot = async () =>
  Object.fromEntries(
    await Promise.all(
      sources.map(async (p) => [
        p,
        createHash("sha256")
          .update(await readFile(p))
          .digest("hex"),
      ]),
    ),
  );
const before = await snapshot();
const browser = await (engine === "webkit"
  ? webkit.launch({
      headless: true,
      executablePath:
        "output/2026-10-10-text-feedback-webkit/browsers/webkit-2336/pw_run.sh",
    })
  : chromium.launch({
      headless: true,
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    }));
const errors = [],
  blocked = [];
let result;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === "http://127.0.0.1:1464")
      return route.continue();
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://127.0.0.1:1464/" + base + "/worker.html");
  await page.waitForFunction(() => !!window.workerResult, undefined, {
    timeout: 45000,
  });
  result = await page.evaluate(() => window.workerResult);
} catch (e) {
  result = { passed: false, error: String(e?.stack ?? e) };
} finally {
  await browser.close();
}
const after = await snapshot();
const record = {
  engine,
  recordedAtUtc: new Date().toISOString(),
  before,
  after,
  sourceUnchanged: JSON.stringify(before) === JSON.stringify(after),
  errors,
  blocked,
  result,
};
record.passed =
  result.passed &&
  record.sourceUnchanged &&
  errors.length === 0 &&
  blocked.length === 0;
const raw = JSON.stringify(record, null, 2) + "\n";
await writeFile(base + "/worker-" + engine + ".raw.txt", raw, { flag: "wx" });
await writeFile(base + "/worker-" + engine + ".json", raw, { flag: "wx" });
console.log(
  JSON.stringify({
    engine,
    passed: record.passed,
    checks: result.checks?.length,
    samples: result.samples?.length,
    sourceUnchanged: record.sourceUnchanged,
  }),
);
process.exitCode = record.passed ? 0 : 1;
