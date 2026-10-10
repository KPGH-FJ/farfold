import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { webkit, chromium } =
  await import("/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const base =
    "docs/evidence/2026-10-09-capability-hardening/workbook-range/independent",
  engine = process.argv[2],
  label = process.argv[3];
const list = (p) =>
  fs
    .readdirSync(p, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? list(path.join(p, e.name)) : [path.join(p, e.name)],
    );
const inputs = [
  ...list("src"),
  ...list(base.replace("/independent", "/fixtures")),
  ...list(base).filter(
    (p) => /\.(tsx?|mjs|html)$/.test(p) || p.endsWith("capture-data.json"),
  ),
];
const hash = () =>
  Object.fromEntries(
    inputs.map((p) => [
      p,
      createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
    ]),
  );
const out = {
  engine,
  label,
  at: new Date().toISOString(),
  before: hash(),
  blocked: [],
  errors: [],
};
const b = await (engine === "webkit" ? webkit : chromium).launch({
  headless: true,
  executablePath:
    engine === "webkit"
      ? path.resolve(
          "output/2026-10-10-text-feedback-webkit/browsers/webkit-2336/pw_run.sh",
        )
      : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const p = await b.newPage();
  await p.route("**/*", (r) =>
    r.request().url().startsWith("http://127.0.0.1:1466/")
      ? r.continue()
      : (out.blocked.push(r.request().url()), r.abort()),
  );
  p.on("pageerror", (e) => out.errors.push(String(e)));
  await p.goto("http://127.0.0.1:1466/" + base + "/worker.html", {
    waitUntil: "networkidle",
  });
  await p.waitForFunction(() => typeof window.probe === "function");
  out.result = await p.evaluate(() => window.probe());
} catch (e) {
  out.error = String(e);
} finally {
  await b.close();
  out.after = hash();
  out.sourceUnchanged =
    JSON.stringify(out.before) === JSON.stringify(out.after);
  out.passed =
    out.result?.passed === true && out.sourceUnchanged && !out.errors.length;
  const raw = JSON.stringify(out, null, 2) + "\n";
  fs.writeFileSync(`${base}/${engine}-${label}.raw.txt`, raw);
  fs.writeFileSync(`${base}/${engine}-${label}.json`, raw);
  console.log(
    JSON.stringify({
      passed: out.passed,
      checks: out.result?.checks.length,
      failure: out.result?.checks.find((x) => !x.pass),
      error: out.error,
      parseError: out.result?.outputs.at(-1)?.error,
    }),
  );
  process.exitCode = out.passed ? 0 : 1;
}
