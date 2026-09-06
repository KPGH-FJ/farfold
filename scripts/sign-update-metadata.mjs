import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Sign exact UTF-8 bytes: consumers verify the bytes, then compare the parsed
// document with every externally visible metadata field. No JSON canonicalizer
// or private signing key is needed by the application.
export function signedPayload(metadata, bundleId, arch, expiresAt, now) {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.farfoldMetadata ||
    metadata.farfold ||
    metadata.platforms ||
    typeof metadata.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(metadata.version) ||
    typeof metadata.url !== "string" ||
    new URL(metadata.url).protocol !== "https:" ||
    typeof metadata.signature !== "string" ||
    !metadata.signature.trim() ||
    typeof bundleId !== "string" ||
    !/^[A-Za-z0-9.-]+$/.test(bundleId) ||
    !["aarch64", "x86_64"].includes(arch) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt - now > 31 * 24 * 60 * 60
  ) {
    throw new Error(
      "Invalid release metadata, identity, architecture, or expiry",
    );
  }
  const document = {
    ...metadata,
    farfold: {
      formatVersion: 1,
      bundleId,
      target: "darwin",
      arch,
      expiresAt,
    },
  };
  const payload = Buffer.from(JSON.stringify(document), "utf8");
  if (payload.length > 64 * 1024) {
    throw new Error("Signed metadata exceeds 64 KiB");
  }
  return { document, payload };
}

function main() {
  const [input, output, bundleId, arch, expires] = process.argv.slice(2);
  if (!input || !output || !bundleId || !arch || !expires) {
    throw new Error(
      "Usage: node scripts/sign-update-metadata.mjs INPUT OUTPUT BUNDLE_ID ARCH EXPIRES_UNIX_SECONDS",
    );
  }
  if (
    !process.env.TAURI_SIGNING_PRIVATE_KEY &&
    !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH
  ) {
    throw new Error(
      "Supply the Tauri signing key through its environment variable",
    );
  }
  const inputBytes = readFileSync(input);
  if (inputBytes.length > 64 * 1024) {
    throw new Error("Input metadata exceeds 64 KiB");
  }
  const { document, payload } = signedPayload(
    JSON.parse(inputBytes.toString("utf8")),
    bundleId,
    arch,
    Number(expires),
    Math.floor(Date.now() / 1000),
  );
  const temporary = mkdtempSync(join(tmpdir(), "farfold-metadata-sign-"));
  try {
    const payloadPath = join(temporary, "metadata.json");
    writeFileSync(payloadPath, payload, { mode: 0o600, flag: "wx" });
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const signed = spawnSync(
      join(repository, "node_modules/.bin/tauri"),
      ["signer", "sign", payloadPath],
      { cwd: repository, env: process.env, stdio: "pipe", timeout: 30_000 },
    );
    if (signed.error || signed.status !== 0) {
      // Signing diagnostics may contain environment material. Do not echo them.
      throw new Error("Tauri metadata signing failed");
    }
    const signature = readFileSync(`${payloadPath}.sig`, "utf8").trim();
    if (!signature || signature.length > 4096) {
      throw new Error("Tauri metadata signature is invalid");
    }
    writeFileSync(
      output,
      `${JSON.stringify({ ...document, farfoldMetadata: { payload: payload.toString("base64"), signature } }, null, 2)}\n`,
      { flag: "wx", mode: 0o644 },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
