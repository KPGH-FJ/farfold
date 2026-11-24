import { execFileSync, spawnSync } from "node:child_process";
import { statfsSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { classifyDeliveryPaths } from "./delivery-scope.mjs";

const pnpm = (...args) => ["corepack", "pnpm", ...args];
const cargo = (subcommand, ...args) => [
  "cargo",
  subcommand,
  ...(subcommand === "fmt" ? ["--check"] : []),
  "--manifest-path",
  "src-tauri/Cargo.toml",
  ...args,
];
export const stableChecks = [
  pnpm("format:check"),
  pnpm("typecheck"),
  pnpm("test"),
  pnpm("build"),
  cargo("fmt"),
  cargo("clippy", "--locked", "--", "-D", "warnings"),
  cargo("test", "--locked"),
];

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function freeBytes() {
  const { bavail, bsize } = statfsSync(".");
  return bavail * bsize;
}

function changeScope(base, head) {
  if (!/^[a-f0-9]{40}$/.test(base ?? ""))
    throw new Error("Supply the full base SHA.");
  const paths = git("diff", "--name-only", "--no-renames", "-z", base, head)
    .split("\0")
    .filter(Boolean);
  return classifyDeliveryPaths(paths);
}

export function requiredAffectedCommands({ frontend, native }, base, head) {
  return [
    ["git", "diff", "--check", base, head],
    pnpm("docs:check"),
    ...(frontend ? stableChecks.slice(1, 4) : [pnpm("test", "scripts")]),
    ...(native ? stableChecks.slice(4) : []),
  ];
}

function checksFor(mode, base, head) {
  if (mode === "stable" && base === undefined) return stableChecks;
  if (mode !== "affected")
    throw new Error(
      "Use stable <new-report.json> or affected <new-report.json> <base-SHA>.",
    );
  const [whitespace, ...required] = requiredAffectedCommands(
    changeScope(base, head),
    base,
    head,
  );
  const changedText = git(
    "diff",
    "--name-only",
    "--diff-filter=ACMRT",
    "-z",
    base,
    head,
  )
    .split("\0")
    .filter((file) =>
      /^(src\/|scripts\/|docs\/|\.github\/workflows\/).*\.(?:[cm]?[jt]sx?|md|ya?ml)$/.test(
        file,
      ),
    );
  return [
    whitespace,
    ...(changedText.length
      ? [pnpm("exec", "prettier", "--check", ...changedText)]
      : []),
    ...required,
  ];
}

function main([mode, output, base, ...extra]) {
  const head = git("rev-parse", "HEAD").trim();
  if (mode === "scope" && base === undefined && !extra.length) {
    console.log(JSON.stringify(changeScope(output, head)));
    return;
  }
  if (!output || extra.length) throw new Error("Supply an unused report path.");
  // The report describes committed inputs. Work in progress can still use the
  // underlying commands directly. Untracked files can affect format and tests.
  const status = () => git("status", "--porcelain", "--untracked-files=normal");
  if (status())
    throw new Error("Committed check reports require a clean checkout.");
  const checks = checksFor(mode, base, head);
  const rust = checks.some(([program]) => program === "cargo")
    ? execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim()
    : null;
  writeFileSync(output, "", { flag: "wx", mode: 0o600 });
  const startedAt = new Date().toISOString();
  const availableBytesBefore = freeBytes();
  const results = checks.map(([program, ...args]) => {
    console.log(`[delivery] ${[program, ...args].join(" ")}`);
    const start = performance.now();
    const result = spawnSync(program, args, { stdio: "inherit" });
    return {
      command: [program, ...args],
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.code ?? null,
      elapsedMs: Math.round(performance.now() - start),
    };
  });
  const inputsStable = !status() && git("rev-parse", "HEAD").trim() === head;
  writeFileSync(
    output,
    `${JSON.stringify(
      {
        mode,
        head,
        base: base ?? null,
        startedAt,
        finishedAt: new Date().toISOString(),
        platform: `${process.platform}-${process.arch}`,
        node: process.version,
        rust,
        availableBytesBefore,
        availableBytesAfter: freeBytes(),
        inputsStable,
        results,
      },
      null,
      2,
    )}\n`,
  );
  if (!inputsStable || results.some(({ exitCode }) => exitCode !== 0))
    process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
