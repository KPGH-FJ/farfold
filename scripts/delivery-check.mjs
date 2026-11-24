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

// Run named, source-backed controls instead of letting a successful empty
// Cargo filter stand in for Windows worktree coverage.
export const windowsAffectedTests = [
  "worktrees::tests::existing_branch_and_checkout_transforms_modes_links_are_preserved",
  "worktrees::create::windows::tests::public_create_materializes_selected_old_oid_and_source_profile_without_touching_source",
  "worktrees::create::windows::tests::selected_custom_filter_is_rejected_before_target_or_branch_creation",
  "worktrees::windows_tests::expired_or_missing_conditions_refuse_before_retirement_or_durable_intent",
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

export function requiredAffectedCommands(
  { frontend, native, macNative = native },
  base,
  head,
) {
  return [
    ["git", "diff", "--check", base, head],
    pnpm("docs:check"),
    ...(frontend ? stableChecks.slice(1, 4) : [pnpm("test", "scripts")]),
    ...(macNative ? stableChecks.slice(4) : []),
  ];
}

export function requiredWindowsAffectedCommands(base, head) {
  return [
    ["git", "diff", "--check", base, head],
    cargo("fmt"),
    cargo("clippy", "--locked", "--all-targets", "--", "-D", "warnings"),
    cargo("build", "--locked", "--example", "windows_process_fixture"),
    ...windowsAffectedTests.map((name) =>
      cargo("test", "--locked", "--lib", name, "--", "--exact", "--nocapture"),
    ),
    cargo("test", "--locked", "--", "--nocapture"),
  ];
}

export function parseWindowsTestResult(output) {
  const runs = [...output.matchAll(/^running (\d+) tests?\r?$/gm)];
  const summaries = [
    ...output.matchAll(
      /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm,
    ),
  ];
  if (runs.length !== 1 || runs[0][1] !== "1" || summaries.length !== 1)
    return null;
  const [passed, failed, ignored] = summaries[0].slice(1).map(Number);
  return { passed, failed, ignored };
}

function checksFor(mode, base, head) {
  if (mode === "stable" && base === undefined) return stableChecks;
  if (mode === "affected-windows") {
    if (process.platform !== "win32" || process.arch !== "x64")
      throw new Error("Windows affected evidence requires Windows x64.");
    if (!changeScope(base, head).windowsNative)
      throw new Error(
        "Windows affected evidence requires a matching Windows change.",
      );
    return requiredWindowsAffectedCommands(base, head);
  }
  if (mode !== "affected")
    throw new Error(
      "Use stable <new-report.json> or affected[-windows] <new-report.json> <base-SHA>.",
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
  const windows = mode === "affected-windows";
  const availableBytesBefore = windows ? null : freeBytes();
  const tests = [];
  const results = [];
  const commandFailed = ({ exitCode, signal, error }) =>
    exitCode !== 0 || signal !== null || error !== null;
  const exactTestFailed = ({ passed, failed, ignored }) =>
    passed !== 1 || failed !== 0 || ignored !== 0;
  const fullWindowsSuite = windows ? checks.at(-1) : null;
  for (const command of checks) {
    if (
      command === fullWindowsSuite &&
      (results.some(commandFailed) || tests.some(exactTestFailed))
    ) {
      console.log(
        "[delivery] Full Windows suite deferred because earlier required checks failed.",
      );
      break;
    }
    const [program, ...args] = command;
    console.log(`[delivery] ${[program, ...args].join(" ")}`);
    const start = performance.now();
    const testName =
      windows &&
      program === "cargo" &&
      args[0] === "test" &&
      windowsAffectedTests.includes(args.at(-4))
        ? args.at(-4)
        : undefined;
    const result = spawnSync(
      program,
      args,
      testName
        ? {
            stdio: ["ignore", "pipe", "inherit"],
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024,
          }
        : { stdio: "inherit" },
    );
    if (testName) {
      const stdout = result.stdout ?? "";
      process.stdout.write(stdout);
      const counts = parseWindowsTestResult(stdout);
      tests.push({
        name: testName,
        passed: counts?.passed ?? null,
        failed: counts?.failed ?? null,
        ignored: counts?.ignored ?? null,
      });
    }
    results.push({
      command,
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.code ?? null,
      elapsedMs: Math.round(performance.now() - start),
    });
  }
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
        availableBytesAfter: windows ? null : freeBytes(),
        inputsStable,
        results,
        ...(windows ? { tests } : {}),
      },
      null,
      2,
    )}\n`,
  );
  if (
    !inputsStable ||
    results.some(commandFailed) ||
    tests.some(exactTestFailed)
  )
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
