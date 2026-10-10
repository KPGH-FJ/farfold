import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base =
  "docs/evidence/2026-10-09-capability-hardening/visual-area/independent/browser";
const engine = process.argv[2] ?? "webkit";
const label = process.argv[3] ?? "renderer-first";
const files = (d) =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)],
    );
// Transpilation drops type-only imports. Follow actual local JavaScript imports
// and owned Worker URLs rather than unrelated tests or concurrently edited App.
const closure = new Set();
function includeModule(file) {
  if (closure.has(file)) return;
  closure.add(file);
  const javascript = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  for (const match of javascript.matchAll(
    /(?:from\s*|import\s*\(?\s*|new URL\s*\(\s*)["'](\.[^"']+)["']/g,
  )) {
    const raw = path.normalize(path.join(path.dirname(file), match[1]));
    const found = [raw, raw + ".ts", raw + ".tsx", raw + ".js"].find(
      (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
    );
    if (!found) throw new Error("Unresolved dependency " + raw);
    if (/\.[cm]?[jt]sx?$/.test(found)) includeModule(found);
    else closure.add(found);
  }
}
includeModule("src/runtime/pdf_preview.ts");
includeModule("src/runtime/draft_images.ts");
const inputs = [
  ...new Set([
    ...closure,
    "package.json",
    "pnpm-lock.yaml",
    "vite.config.ts",
    "node_modules/pdfjs-dist/legacy/build/pdf.mjs",
    "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    ...files(base.replace("/independent/browser", "/fixtures")),
    ...[
      "renderer.ts",
      "renderer.html",
      "capture-data.json",
      "serve.mjs",
      "run-renderer.mjs",
    ].map((n) => base + "/" + n),
  ]),
].sort();
const hashes = () =>
  Object.fromEntries(
    inputs.map((p) => [
      p,
      createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
    ]),
  );
const result = {
  scope:
    "Actual production renderPdfPage worker + validateDraftImage and browser Image decoder; no App/IPC or area confirmation",
  engine,
  label,
  inputScope:
    "Production local import/Worker closure plus PDF.js implementation, lock/config, immutable fixture inputs and dedicated harness; type-only dependencies and unrelated tests excluded. Font-free synthetic PDFs do not request package font/cmap resources.",
  before: hashes(),
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
try {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 800 },
  });
  page.on("pageerror", (e) => result.errors.push(String(e)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith("http://127.0.0.1:1468/")
      ? route.continue()
      : (result.blocked.push(route.request().url()), route.abort()),
  );
  await page.goto(`http://127.0.0.1:1468/${base}/renderer.html`);
  await page.waitForFunction(() => window.result?.done, {}, { timeout: 60000 });
  result.result = await page.evaluate(() => window.result);
  result.screenshot = `${base}/${engine}-${label}.png`;
  await page.screenshot({ path: result.screenshot });
} catch (error) {
  result.failure = String(error);
} finally {
  await browser.close();
  result.after = hashes();
  result.sourceUnchanged =
    JSON.stringify(result.before) === JSON.stringify(result.after);
  result.passed =
    result.sourceUnchanged &&
    result.result?.passed &&
    !result.errors.length &&
    !result.blocked.length &&
    !result.failure;
  const raw = JSON.stringify(result, null, 2) + "\n";
  fs.writeFileSync(`${base}/${engine}-${label}.raw.txt`, raw);
  fs.writeFileSync(`${base}/${engine}-${label}.json`, raw);
  console.log(
    JSON.stringify({
      passed: result.passed,
      checks: result.result?.checks?.length,
      failure: result.failure ?? result.result?.error,
      sourceUnchanged: result.sourceUnchanged,
      errors: result.errors,
      blocked: result.blocked,
    }),
  );
  process.exitCode = result.passed ? 0 : 1;
}
