// Fixed-version, unauthenticated E entry probe. No login, turns or model calls.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

const binary = realpathSync(process.argv[2]);
const sha = createHash("sha256").update(readFileSync(binary)).digest("hex");
assert.equal(
  sha,
  "9070e47d422129106bc41ca651a9998b06a6c55bd42a7c3362b48f1d2850766f",
);
const base = mkdtempSync(resolve("src-tauri/target/codex-e-boundary-"));
for (const name of ["home", "codex", "project"])
  mkdirSync(join(base, name), { mode: 0o700 });
const env = {
  HOME: join(base, "home"),
  CODEX_HOME: join(base, "codex"),
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  // Refuse outbound HTTP even if a native startup component attempts it.
  HTTPS_PROXY: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "",
};
function command(args) {
  const result = spawnSync(binary, args, {
    env,
    cwd: join(base, "project"),
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `native command failed: ${args[0]}`);
  return result.stdout.trim();
}
assert.equal(command(["--version"]), "codex-cli 0.143.0");
for (const experimental of [false, true]) {
  command([
    "app-server",
    "generate-json-schema",
    "--out",
    join(base, experimental ? "experimental" : "stable"),
    ...(experimental ? ["--experimental"] : []),
  ]);
}
command([
  "app-server",
  "generate-ts",
  "--out",
  join(base, "types"),
  "--experimental",
]);
const child = spawn(
  binary,
  [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    'cli_auth_credentials_store="file"',
    "-c",
    "features.default_mode_request_user_input=false",
    "-c",
    "check_for_update_on_startup=false",
  ],
  {
    env,
    cwd: join(base, "project"),
    stdio: ["pipe", "pipe", "ignore"],
  },
);
const pending = new Map();
let sequence = 0;
const methods = [];
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method) methods.push(frame.method);
  else {
    const waiter = pending.get(frame.id);
    if (waiter) {
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  }
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 10000);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
let passed = false;
try {
  const before = await request("account/read", { refreshToken: false });
  assert.ok(before.error, "must reject requests before initialize");
  const init = await request("initialize", {
    clientInfo: { name: "farfold_e_boundary", version: "0.1.7" },
    capabilities: { experimentalApi: true },
  });
  assert.equal(init.result?.codexHome, join(base, "codex"));
  assert.equal(init.result?.platformOs, "macos");
  child.stdin.write(
    JSON.stringify({ method: "initialized", params: {} }) + "\n",
  );
  const account = await request("account/read", { refreshToken: false });
  assert.deepEqual(account.result, { account: null, requiresOpenaiAuth: true });
  const list = await request("thread/list", { limit: 10 });
  assert.deepEqual(list.result?.data, []);
  const duplicate = await request("initialize", {
    clientInfo: { name: "farfold_e_boundary", version: "0.1.7" },
  });
  assert.ok(duplicate.error, "must reject second initialization");
  passed = true;
  console.log(
    JSON.stringify({
      evidence: "fixed native unauthenticated protocol only",
      binary,
      sha,
      base,
      account: "unauthenticated",
      threadCount: 0,
      beforeInitRejected: true,
      duplicateInitRejected: true,
      notificationMethods: methods,
      loginCalls: 0,
      turnCalls: 0,
      passed,
    }),
  );
} finally {
  const exit = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exit;
  clearTimeout(timer);
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  lines.close();
  if (!passed) process.exitCode = 1;
}
