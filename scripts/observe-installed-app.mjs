import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, release } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const app = "/Applications/Farfold.app";
const executable = `${app}/Contents/MacOS/farfold`;
const bundleId = "ai.farfold.desktop";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const statFields = ["dev", "ino", "size", "mtimeMs", "ctimeMs"];
const sameFile = (left, right) =>
  statFields.every((key) => left[key] === right[key]);

async function readStable(file, maxBytes, onChunk = () => {}) {
  const before = statSync(file);
  if (!before.isFile() || before.size > maxBytes)
    throw new Error("Unexpected evidence file type or size.");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Evidence exceeded its size bound.");
    hash.update(chunk);
    onChunk(chunk);
  }
  const after = statSync(file);
  if (!sameFile(before, after) || size !== before.size)
    throw new Error("Evidence changed while being read.");
  return { stat: after, sha256: hash.digest("hex") };
}

function text(program, args) {
  return execFileSync(program, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function processIdentity(inode) {
  const rows = text("/bin/ps", ["-axo", "pid=,comm="]).split("\n");
  const match = rows
    .map((row) => row.trim().match(/^(\d+)\s+(.+)$/))
    .filter((row) => row?.[2] === executable);
  if (match.length !== 1)
    throw new Error("Expected one running formal Farfold process.");
  const pid = Number(match[0][1]);
  const loaded = text("/usr/sbin/lsof", [
    "-w",
    "-nP",
    "-a",
    "-p",
    String(pid),
    "-d",
    "txt",
    "-Ffin",
  ]);
  const matches = loaded.split("\nf").filter((record) => {
    const fields = record.split("\n");
    return fields.includes(`n${executable}`) && fields.includes(`i${inode}`);
  });
  if (matches.length !== 1)
    throw new Error("Running Farfold does not match the installed executable.");
  return {
    pid,
    started: text("/bin/ps", ["-p", String(pid), "-o", "lstart="]),
  };
}

async function observeRollout(threadDigest) {
  const vault = path.join(
    homedir(),
    "Library/Application Support",
    bundleId,
    "codex-app-server/sessions",
  );
  const matches = readdirSync(vault, {
    recursive: true,
    withFileTypes: true,
  }).flatMap((entry) => {
    if (!entry.isFile()) return [];
    const match =
      /^rollout-.*-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/.exec(
        entry.name,
      );
    if (!match || sha256(match[1]) !== threadDigest) return [];
    return [{ file: path.join(entry.parentPath, entry.name), id: match[1] }];
  });
  if (matches.length !== 1 || realpathSync(matches[0].file) !== matches[0].file)
    throw new Error("Exact owned rollout missing, ambiguous, or linked.");
  const { file, id } = matches[0];
  let firstLine = Buffer.alloc(0);
  let complete = false;
  const result = await readStable(file, 16 * 1024 * 1024, (chunk) => {
    if (complete) return;
    const end = chunk.indexOf(10);
    firstLine = Buffer.concat([
      firstLine,
      end < 0 ? chunk : chunk.subarray(0, end),
    ]);
    if (firstLine.length > 64 * 1024)
      throw new Error("Rollout metadata exceeded its size bound.");
    complete = end >= 0;
  });
  const meta = JSON.parse(firstLine.toString("utf8"));
  if (
    !complete ||
    meta.type !== "session_meta" ||
    meta.payload?.id !== id ||
    !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(meta.payload.cli_version ?? "")
  )
    throw new Error(
      "Rollout metadata does not identify the selected thread and program version.",
    );
  return {
    threadSha256: threadDigest,
    sha256: result.sha256,
    agentVersion: meta.payload.cli_version,
  };
}

export async function observeInstalledApp(threadDigest) {
  if (
    process.platform !== "darwin" ||
    (threadDigest !== undefined && !/^[a-f0-9]{64}$/.test(threadDigest))
  )
    throw new Error(
      "Use observe-installed-app.mjs [owned-Codex-thread-SHA256] on macOS.",
    );
  const exe = await readStable(executable, 1024 * 1024 * 1024);
  const running = processIdentity(exe.stat.ino);
  const signature = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", app], {
    encoding: "utf8",
  });
  const cdHash = /^CDHash=([a-f0-9]{40})$/m.exec(signature.stderr ?? "")?.[1];
  if (
    signature.status !== 0 ||
    !cdHash ||
    !/^Identifier=ai\.farfold\.desktop$/m.test(signature.stderr)
  )
    throw new Error("Installed bundle signature identity unavailable.");
  const version = text("/usr/libexec/PlistBuddy", [
    "-c",
    "Print CFBundleShortVersionString",
    `${app}/Contents/Info.plist`,
  ]);
  const rollout =
    threadDigest === undefined ? null : await observeRollout(threadDigest);
  if (
    !sameFile(statSync(executable), exe.stat) ||
    JSON.stringify(processIdentity(exe.stat.ino)) !== JSON.stringify(running)
  )
    throw new Error("Formal application changed during observation.");
  return {
    observedAt: new Date().toISOString(),
    platform: `macos-${process.arch}`,
    kernel: release(),
    app: { bundleId, version, binarySha256: exe.sha256, installedPath: app },
    cdHash,
    running,
    rollout,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length > 3)
      throw new Error("Supply at most one owned thread SHA-256.");
    console.log(
      JSON.stringify(await observeInstalledApp(process.argv[2]), null, 2),
    );
  } catch (error) {
    // Do not print child-process output, rollout JSON, or account paths.
    console.error(
      error instanceof SyntaxError
        ? "Invalid evidence JSON."
        : error.code
          ? "Could not safely observe local evidence."
          : error.message,
    );
    process.exitCode = 1;
  }
}
