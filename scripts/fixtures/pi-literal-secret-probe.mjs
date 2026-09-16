import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  getConfigValueEnvVarNames,
  isCommandConfigValue,
  resolveConfigValue,
} from "../../src-tauri/capability-bridge/node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js";

const version = JSON.parse(
  await readFile(
    new URL(
      "../../src-tauri/capability-bridge/node_modules/@earendil-works/pi-coding-agent/package.json",
      import.meta.url,
    ),
    "utf8",
  ),
).version;
assert.equal(version, "0.84.3");
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const cases = JSON.parse(Buffer.concat(chunks).toString("utf8"));
for (const { encoded, original } of cases) {
  assert.equal(isCommandConfigValue(encoded), false);
  assert.equal(getConfigValueEnvVarNames(encoded).length, 0);
  assert.ok(
    resolveConfigValue(encoded, {}) === original,
    "literal round trip failed",
  );
}
process.stdout.write(JSON.stringify({ version, checked: cases.length }) + "\n");
