import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const runner = ["corepack", "pnpm", "tauri", "build", "--ci"];
const target = "aarch64-apple-darwin";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const stamp = ({ dev, ino, size, mtimeMs, ctimeMs }) => [
  dev,
  ino,
  size,
  mtimeMs,
  ctimeMs,
];

function sourceIdentity() {
  assert.ok(
    !git("status", "--porcelain", "--untracked-files=normal"),
    "Build evidence needs a clean committed source checkout.",
  );
  return {
    sourceCommit: git("rev-parse", "HEAD"),
    sourceTree: git("rev-parse", "HEAD^{tree}"),
  };
}

async function main([output, ...extra]) {
  assert.ok(
    output && !extra.length,
    "Use record-delivery-build.mjs <new-build-report.json>.",
  );
  assert.ok(
    process.platform === "darwin" && process.arch === "arm64",
    "This build recorder packages the macOS arm64 candidate.",
  );
  const report = resolve(output);
  assert.ok(!existsSync(report), "Build report already exists.");
  const source = sourceIdentity();
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version=1",
        "--no-deps",
        "--locked",
        "--manifest-path",
        "src-tauri/Cargo.toml",
      ],
      { encoding: "utf8" },
    ),
  );
  const bundle = join(
    metadata.target_directory,
    target,
    "release",
    "bundle",
    "macos",
    "Farfold.app",
  );
  const executable = join(bundle, "Contents", "MacOS", "farfold");
  const previous = existsSync(executable) ? stamp(lstatSync(executable)) : null;
  const [program, ...args] = runner;
  execFileSync(
    program,
    [...args, "--target", target, "--bundles", "app", "--", "--locked"],
    { stdio: "inherit" },
  );
  const packaged = lstatSync(executable);
  assert.ok(
    packaged.isFile() && packaged.size > 0,
    "Packaged Farfold executable unavailable.",
  );
  assert.notDeepEqual(
    stamp(packaged),
    previous,
    "Build did not refresh the expected packaged executable.",
  );
  const bundleId = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print CFBundleIdentifier", join(bundle, "Contents", "Info.plist")],
    { encoding: "utf8" },
  ).trim();
  assert.equal(
    bundleId,
    "ai.farfold.desktop",
    "Unexpected Farfold bundle identity.",
  );
  execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--strict", "--deep", bundle],
    { stdio: "inherit" },
  );
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(executable)) hash.update(bytes);
  assert.deepEqual(
    stamp(lstatSync(executable)),
    stamp(packaged),
    "Packaged executable changed while recording evidence.",
  );
  assert.deepEqual(
    sourceIdentity(),
    source,
    "Committed source changed during the build.",
  );
  const result = {
    schemaVersion: 1,
    ...source,
    binarySha256: hash.digest("hex"),
    platform: "macos-arm64",
    builtAt: new Date().toISOString(),
  };
  writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify({ executable, report, ...result }, null, 2));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
