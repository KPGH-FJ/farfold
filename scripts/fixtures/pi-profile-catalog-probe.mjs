import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ModelRuntime } from "../../src-tauri/capability-bridge/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js";

const packageUrl = new URL(
  "../../src-tauri/capability-bridge/node_modules/@earendil-works/pi-coding-agent/package.json",
  import.meta.url,
);
assert.equal(JSON.parse(await readFile(packageUrl, "utf8")).version, "0.84.3");
const agentDir = process.argv[2];
const providerId = process.argv[3];
assert.ok(agentDir && isAbsolute(agentDir) && providerId);
const deadline = setTimeout(() => process.exit(124), 10_000);
deadline.unref();
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
  modelsStorePath: join(agentDir, "model-store"),
  allowModelNetwork: false,
});
await runtime.refresh({ allowNetwork: false });
process.stdout.write(
  JSON.stringify({
    version: "0.84.3",
    pid: process.pid,
    models: runtime
      .getAvailableSnapshot()
      .filter((model) => model.provider === providerId)
      .map((model) => model.id),
  }) + "\n",
);
clearTimeout(deadline);
