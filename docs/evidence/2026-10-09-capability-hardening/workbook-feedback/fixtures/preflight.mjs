// Bounded pure-parser preflight over the exact ZIP bytes. No product IPC,
// Worker, user files, formula evaluation, config changes, or Agent process.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../../..");
const name = process.argv[2] ?? "parser-preflight-red";
if (
  !/^[a-z0-9-]+$/.test(name) ||
  fs.existsSync(path.join(here, `${name}.json`))
)
  throw new Error("Use a fresh bounded output name");
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sourcePaths = fs
  .readdirSync(path.join(repo, "src/runtime"))
  .filter((name) => /^xlsx_.*\.ts$/.test(name) && !name.includes(".test."))
  .map((name) => `src/runtime/${name}`);
const hashes = () =>
  Object.fromEntries(
    sourcePaths.map((file) => [file, hash(path.join(repo, file))]),
  );
const before = hashes();
const bundle = await build({
  configFile: false,
  envDir: false,
  publicDir: false,
  logLevel: "error",
  build: {
    write: false,
    minify: false,
    target: "es2022",
    lib: {
      entry: path.join(repo, "src/runtime/xlsx_parse.ts"),
      formats: ["es"],
    },
  },
});
const output = (Array.isArray(bundle) ? bundle[0] : bundle).output;
if (output.length !== 1 || output[0].type !== "chunk")
  throw new Error("Unexpected parser-only bundle");
fs.writeFileSync(path.join(here, "parser-bundle.raw.txt"), output[0].code);
const { parseWorkbook } = await import(
  `data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`
);
const oracle = JSON.parse(
  fs.readFileSync(path.join(here, "oracle.json"), "utf8"),
);
const results = [];
for (const file of [
  "positions-v1.xlsx",
  "positions-v2.xlsx",
  "positions-v1-nonordinal-ids.xlsx",
]) {
  const python = spawnSync(
    "/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3",
    [
      "-c",
      "import zipfile,json,base64,sys\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n print(json.dumps({'entries':z.namelist(),'parts':[{'name':n,'data':base64.b64encode(z.read(n)).decode()} for n in z.namelist() if n.endswith(('.xml','.rels'))]}))",
      path.join(here, file),
    ],
    { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 },
  );
  if (python.status !== 0)
    throw new Error(`Fixture ZIP extraction failed: ${python.status}`);
  const actualHash = hash(path.join(here, file));
  if (actualHash !== oracle[file].fileSha256)
    throw new Error("Fixture changed from oracle");
  const input = JSON.parse(python.stdout);
  const started = performance.now();
  try {
    const preview = parseWorkbook(input);
    results.push({
      file,
      sha256: actualHash,
      status: "accepted",
      elapsedMs: performance.now() - started,
      sheetId: preview.sheet?.id,
      warnings: preview.warnings,
      selectedCells: preview.sheet?.cells.filter((c) =>
        ["A2", "B2", "C2", "E2", "F2"].includes(c.reference),
      ),
    });
  } catch (error) {
    results.push({
      file,
      sha256: actualHash,
      status: "rejected",
      elapsedMs: performance.now() - started,
      code: typeof error?.code === "string" ? error.code : null,
      stack: String(error?.stack ?? error)
        .split("\n")
        .slice(0, 7)
        .map((line) =>
          line.replace(
            /data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,
            "controlled-parser-bundle",
          ),
        ),
    });
  }
}
const after = hashes();
const receipt = {
  kind: "Exact ordinary-writer bytes through current pure parser; no Worker/native/UI/feedback acceptance",
  before,
  after,
  sourceUnchanged: JSON.stringify(before) === JSON.stringify(after),
  results,
};
fs.writeFileSync(
  path.join(here, `${name}.json`),
  JSON.stringify(receipt, null, 2) + "\n",
);
console.log(JSON.stringify(receipt, null, 2));
process.exitCode =
  receipt.sourceUnchanged && results.every((r) => r.status === "accepted")
    ? 0
    : 1;
