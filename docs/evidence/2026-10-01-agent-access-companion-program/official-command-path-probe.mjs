import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

// Run only after review. This loads the audited pure parser, never the Agent entry.
const UTILS =
  "/Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:autohand/install-DmctEe/node_modules/@autohandai/autohand-acp/dist/utils.js";
const UTILS_SHA256 =
  "8496c0d013fd21e479b89453886830ca78f9b5d9b0075779d2c73eed4906b3c9";
const UTILS_BYTES = 2561;
const COMMAND = "launch-program";
const MAX_OUTPUT = 2048;
const MAX_REPORT = 32768;
const TOTAL_MS = 30000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const under = (root, target) => {
  const relative = path.relative(root, target);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
};

function groupAbsent(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH" ? true : null;
  }
}

// Preflight prevents a failed controlled search from executing a user program.
async function dispatchAllowed(root, command, searchPath) {
  if (command.includes("/")) {
    const target = path.resolve(root, command);
    if (!under(root, target)) return false;
    try {
      return under(root, await realpath(target));
    } catch (error) {
      return error?.code === "ENOENT";
    }
  }
  for (const entry of searchPath.split(path.delimiter)) {
    const target = path.resolve(root, entry || ".", command);
    try {
      await access(target, constants.X_OK);
      return under(root, await realpath(target));
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error?.code)) return false;
    }
    if (!under(root, target)) return false;
  }
  return true;
}

async function runCase(root, parseEnvArgs, spec, remainingMs) {
  const tokens = spec.parsed ? parseEnvArgs(spec.value) : [spec.value];
  const command = tokens[0];
  const args = [...tokens.slice(1), ...spec.args];
  const row = {
    name: spec.name,
    expected: spec.expected,
    parsed: spec.parsed,
    parseTokenCount: tokens.length,
    parserCommandMatchesSelected:
      command === spec.target || command === COMMAND,
    dispatchBlocked: false,
    spawned: false,
    pid: null,
    spawnError: null,
    exitObserved: false,
    exitCode: null,
    signal: null,
    timedOut: false,
    termRequested: false,
    killRequested: false,
    closeObserved: false,
    reaped: false,
    groupAbsent: null,
    stdoutWithinLimit: true,
    stderrBytes: 0,
    controlledOutputMatched: false,
    cleanupSafe: true,
    expectedMatched: false,
  };
  if (!(await dispatchAllowed(root, command, spec.searchPath))) {
    row.dispatchBlocked = true;
    return row;
  }
  const environment = { ...process.env, PATH: spec.searchPath };
  // A preload would defeat this fake-program-only probe. No persistent env is changed.
  delete environment.NODE_OPTIONS;
  let stdout = "";
  let stdoutBytes = 0;
  let child;
  await new Promise((resolve) => {
    let finished = false;
    let timeout;
    let escalation;
    let bound;
    const send = (signal) => {
      if (!child?.pid) return;
      try {
        process.kill(-child.pid, signal);
        if (signal === "SIGTERM") row.termRequested = true;
        if (signal === "SIGKILL") row.killRequested = true;
      } catch {
        // No arbitrary OS text is retained; group absence is checked separately.
      }
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(escalation);
      clearTimeout(bound);
      if (!row.closeObserved && row.spawned) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      resolve();
    };
    child = spawn(command, args, {
      cwd: root,
      env: environment,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("spawn", () => {
      row.spawned = true;
      row.pid = child.pid;
    });
    child.on("error", (error) => {
      row.spawnError = ["ENOENT", "EACCES"].includes(error?.code)
        ? error.code
        : "OTHER";
    });
    child.on("exit", (code, signal) => {
      row.exitObserved = true;
      row.exitCode = Number.isInteger(code) ? code : null;
      row.signal = ["SIGTERM", "SIGKILL"].includes(signal) ? signal : null;
    });
    child.on("close", () => {
      row.closeObserved = true;
      finish();
    });
    child.stdout.on("data", (data) => {
      stdoutBytes += data.length;
      if (stdoutBytes <= MAX_OUTPUT) stdout += data.toString("utf8");
      else {
        row.stdoutWithinLimit = false;
        send("SIGTERM");
      }
    });
    child.stderr.on("data", (data) => {
      row.stderrBytes += data.length;
      if (row.stderrBytes > MAX_OUTPUT) send("SIGTERM");
    });
    timeout = setTimeout(
      () => {
        row.timedOut = true;
        send("SIGTERM");
        escalation = setTimeout(() => send("SIGKILL"), 250);
      },
      Math.min(spec.expected === "timeout" ? 400 : 1800, remainingMs),
    );
    bound = setTimeout(
      () => {
        row.timedOut = true;
        send("SIGKILL");
        finish();
      },
      Math.min(3300, remainingMs + 1000),
    );
  });
  if (row.spawned) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      row.groupAbsent = groupAbsent(row.pid);
      if (row.groupAbsent === true) break;
      await pause(20);
    }
    row.reaped = row.exitObserved && row.closeObserved;
    row.cleanupSafe = row.reaped && row.groupAbsent === true;
  } else {
    row.cleanupSafe = row.closeObserved && row.spawnError !== null;
  }
  try {
    const value = JSON.parse(stdout);
    row.controlledOutputMatched =
      value?.mode === spec.mode && value?.argumentMatch === true;
  } catch {
    // Only fixed match booleans are exported, never stdout or stderr.
  }
  const clean =
    row.cleanupSafe && row.stdoutWithinLimit && row.stderrBytes === 0;
  if (spec.expected === "success") {
    row.expectedMatched =
      clean &&
      row.spawned &&
      row.exitCode === 0 &&
      !row.timedOut &&
      row.controlledOutputMatched;
  } else if (spec.expected === "enoent") {
    row.expectedMatched = clean && !row.spawned && row.spawnError === "ENOENT";
  } else {
    row.expectedMatched =
      clean &&
      row.spawned &&
      row.timedOut &&
      row.termRequested &&
      row.controlledOutputMatched;
  }
  return row;
}

async function main() {
  const report = {
    schema: 1,
    scope: "official_parser_and_controlled_node_processes",
    actualAgentExecuted: false,
    networkUsed: false,
    userConfigRead: false,
    persistentEnvironmentChanged: false,
    parserHashVerified: false,
    parserLoaded: false,
    temporaryRootCreated: false,
    cleanupAttempted: false,
    temporaryRootRemoved: false,
    cleanupResidualPath: null,
    failure: null,
    rows: [],
    passed: false,
  };
  let root;
  try {
    const stat = await lstat(UTILS);
    if (!stat.isFile() || stat.size !== UTILS_BYTES) throw new Error("PARSER");
    const source = await readFile(UTILS);
    if (createHash("sha256").update(source).digest("hex") !== UTILS_SHA256) {
      throw new Error("PARSER");
    }
    report.parserHashVerified = true;
    const { parseEnvArgs } = await import(
      `data:text/javascript;base64,${source.toString("base64")}`
    );
    if (typeof parseEnvArgs !== "function") throw new Error("PARSER");
    report.parserLoaded = true;
    root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "farfold-autohand-command-probe-")),
    );
    report.temporaryRootCreated = true;
    if (root.includes(path.delimiter)) throw new Error("TEMPORARY_ROOT");
    const goodDirectory = path.join(
      root,
      "Application Support",
      "agent-registry%3Aautohand",
      "candidate",
    );
    const colonDirectory = path.join(
      root,
      "Application Support",
      "registry:autohand",
      "candidate",
    );
    const emptyDirectory = path.join(root, "empty-path");
    await mkdir(goodDirectory, { recursive: true });
    await mkdir(colonDirectory, { recursive: true });
    await mkdir(emptyDirectory);
    const fake = path.join(root, "fake-cli.mjs");
    await writeFile(
      fake,
      `const [mode, ...args] = process.argv.slice(2);
const argumentMatch = mode === "--version" ? args.length === 0
  : mode === "resume" ? args.length === 1 && args[0] === "FARFOLD-CONTROLLED-SESSION"
  : mode === "--prompt" ? args.length === 3 && args[0] === "FARFOLD-CONTROLLED-PROMPT" && args[1] === "--path" && args[2] === process.cwd()
  : mode === "--hang" && args.length === 0;
const publicMode = mode === "--version" ? "version" : mode === "--prompt" ? "prompt" : mode === "--hang" ? "hang" : "resume";
process.stdout.write(JSON.stringify({mode: publicMode, argumentMatch}) + "\\n");
if (mode === "--hang") setInterval(() => {}, 1000);
else process.exitCode = argumentMatch ? 0 : 2;
`,
    );
    const wrapper = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`;
    const good = path.join(goodDirectory, COMMAND);
    const colon = path.join(colonDirectory, COMMAND);
    for (const target of [good, colon]) {
      await writeFile(target, wrapper, { mode: 0o700, flag: "wx" });
      await chmod(target, 0o700);
    }
    const inheritedPath = process.env.PATH ?? "";
    const goodPath = `${goodDirectory}${path.delimiter}${inheritedPath}`;
    // All search pieces here resolve within this task; never try a user fallback.
    const colonPath = `${colonDirectory}${path.delimiter}${emptyDirectory}`;
    const modes = [
      {
        suffix: "version",
        mode: "version",
        args: ["--version"],
        parsed: false,
      },
      {
        suffix: "resume",
        mode: "resume",
        args: ["resume", "FARFOLD-CONTROLLED-SESSION"],
        parsed: false,
      },
      {
        suffix: "prompt",
        mode: "prompt",
        args: ["--prompt", "FARFOLD-CONTROLLED-PROMPT", "--path", root],
        parsed: true,
      },
    ];
    const specs = [];
    for (const mode of modes) {
      for (const shape of ["name", "bare", "quoted", "colon_path"]) {
        const expected =
          (shape === "bare" && mode.parsed) ||
          (shape === "quoted" && !mode.parsed) ||
          shape === "colon_path"
            ? "enoent"
            : "success";
        specs.push({
          ...mode,
          name: `${shape}_${mode.suffix}`,
          target: shape === "colon_path" ? colon : good,
          value:
            shape === "name" || shape === "colon_path"
              ? COMMAND
              : shape === "quoted"
                ? `"${good}"`
                : good,
          searchPath: shape === "colon_path" ? colonPath : goodPath,
          expected,
        });
      }
    }
    specs.push({
      name: "bounded_timeout",
      mode: "hang",
      parsed: false,
      value: COMMAND,
      target: good,
      args: ["--hang"],
      searchPath: goodPath,
      expected: "timeout",
    });
    const deadline = performance.now() + TOTAL_MS;
    for (const spec of specs) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("TOTAL_DEADLINE");
      const row = await runCase(root, parseEnvArgs, spec, remaining);
      report.rows.push(row);
      if (!row.cleanupSafe) throw new Error("PROCESS_CLEANUP_UNKNOWN");
    }
    report.passed =
      report.rows.length === 13 &&
      report.rows.every((row) => row.expectedMatched);
  } catch (error) {
    report.failure = [
      "PARSER",
      "TEMPORARY_ROOT",
      "TOTAL_DEADLINE",
      "PROCESS_CLEANUP_UNKNOWN",
    ].includes(error?.message)
      ? error.message
      : "LOCAL_PROBE_FAILED";
  } finally {
    if (root && report.rows.every((row) => row.cleanupSafe)) {
      report.cleanupAttempted = true;
      try {
        await rm(root, { recursive: true, force: false });
        try {
          await lstat(root);
        } catch (error) {
          report.temporaryRootRemoved = error?.code === "ENOENT";
        }
      } catch {
        report.failure ??= "TEMPORARY_CLEANUP_FAILED";
      }
    }
    if (root && !report.temporaryRootRemoved) report.cleanupResidualPath = root;
    report.passed &&= report.failure === null && report.temporaryRootRemoved;
  }
  const output = JSON.stringify(report, null, 2);
  if (Buffer.byteLength(output) > MAX_REPORT) {
    process.stdout.write('{"passed":false,"failure":"REPORT_LIMIT"}\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(`${output}\n`);
    process.exitCode = report.passed ? 0 : 1;
  }
}

await main();
