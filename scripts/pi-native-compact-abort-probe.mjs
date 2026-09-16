// Fixed Pi diagnostic: one loopback compaction, synthetic persisted history.
// Passing this probe confirms the documented limitation, NOT successful Stop.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../src-tauri/capability-bridge/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const acp = process.argv.includes("--acp");
const adapter = resolve(repo, "src-tauri/pi-acp-adapter/dist/index.js");
const adapterNode = resolve(repo, "src-tauri/capability-bridge/runtime/node");
const pi = resolve(repo, "src-tauri/resources/pi-runtime/pi");
assert.equal(
  createHash("sha256")
    .update(await readFile(pi))
    .digest("hex"),
  "e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac",
);
const root = await mkdtemp(
  resolve(repo, "src-tauri/target/d-stage-pi-candidate-0912/compact-abort-"),
);
const cwd = resolve(root, "project");
const agent = resolve(root, "agent");
const sessions = resolve(root, "sessions");
for (const path of [cwd, agent, sessions]) await mkdir(path);
const manager = SessionManager.create(cwd, sessions);
manager.appendModelChange("local-compact", "fixture");
for (let index = 0; index < 3; index++) {
  manager.appendMessage({
    role: "user",
    content: `SYNTHETIC-${index} ` + "local history ".repeat(200),
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "SYNTHETIC-ANSWER" }],
    api: "openai-completions",
    provider: "local-compact",
    model: "fixture",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1000,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1010,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
}
const sessionFile = manager.getSessionFile();
let heldResponse;
let requests = 0;
const server = createServer(async (request, response) => {
  for await (const _part of request) {
    /* Synthetic content is not logged. */
  }
  requests++;
  if (requests === 1) heldResponse = response;
  else {
    response.writeHead(400);
    response.end("Unexpected local request");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
await writeFile(
  resolve(agent, "models.json"),
  JSON.stringify({
    providers: {
      "local-compact": {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        api: "openai-completions",
        apiKey: "synthetic-local-only",
        models: [{ id: "fixture", contextWindow: 32768, maxTokens: 4096 }],
      },
    },
  }),
);
await writeFile(
  resolve(agent, "settings.json"),
  JSON.stringify({
    defaultProvider: "local-compact",
    defaultModel: "fixture",
    quietStartup: true,
    compaction: { enabled: false, keepRecentTokens: 64, reserveTokens: 64 },
  }),
);
const launch = () =>
  spawn(
    acp ? adapterNode : pi,
    acp
      ? [adapter]
      : ["--mode", "rpc", "--no-themes", "--session", sessionFile],
    {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        HOME: root,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        PI_CODING_AGENT_DIR: agent,
        PI_CODING_AGENT_SESSION_DIR: sessions,
        PI_ACP_PI_COMMAND: pi,
        TMPDIR: root,
        XDG_CONFIG_HOME: resolve(root, "config"),
        XDG_CACHE_HOME: resolve(root, "cache"),
        XDG_DATA_HOME: resolve(root, "data"),
      },
    },
  );
let child = launch();
const frames = [];
const observe = () => {
  child.stderr.on("data", () => {});
  createInterface({ input: child.stdout }).on("line", (line) =>
    frames.push(JSON.parse(line)),
  );
};
observe();
const nativeEvents = () =>
  acp
    ? frames
        .filter((frame) => frame.method === "_pi/event")
        .map((frame) => frame.params.event)
    : frames;
const wait = async (predicate, label) => {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.equal(child.exitCode, null);
    assert.ok(Date.now() < deadline, `Timeout: ${label}`);
    await new Promise((done) => setTimeout(done, 10));
  }
  return predicate();
};
let sequence = 0;
const send = (type, params = {}) => {
  const id = `probe-${++sequence}`;
  if (acp) {
    const sessionId = manager.getSessionId();
    let method = type;
    if (type === "get_state") {
      method = "_pi/workspace";
      params = { sessionId, section: "state" };
    }
    if (type === "compact") {
      method = "session/prompt";
      params = {
        sessionId,
        prompt: [{ type: "text", text: "/compact" }],
        _meta: {
          farfoldPi: {
            hostTurnId: "synthetic-compact",
            expectedModel: {
              version: 1,
              sessionId,
              sessionFile,
              provider: "local-compact",
              modelId: "fixture",
            },
          },
        },
      };
    }
    if (type === "abort") {
      method = "_pi/cancel";
      params = { sessionId };
    }
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  } else child.stdin.write(JSON.stringify({ id, type, ...params }) + "\n");
  return id;
};
const response = async (id) => {
  const frame = await wait(
    () =>
      frames.find(
        (frame) =>
          frame.id === id && (acp ? !frame.method : frame.type === "response"),
      ),
    id,
  );
  return acp
    ? {
        success: !frame.error,
        data: frame.result?.data ?? frame.result,
        error: frame.error,
      }
    : frame;
};
const load = async () => {
  assert.equal(
    (
      await response(
        send("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            elicitation: { form: {} },
            _meta: { farfoldPi: { version: 1 } },
          },
        }),
      )
    ).success,
    true,
  );
  const loaded = await response(
    send("session/load", {
      sessionId: manager.getSessionId(),
      cwd,
      mcpServers: [],
    }),
  );
  assert.equal(loaded.success, true, JSON.stringify(loaded));
};
const close = async () => {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await new Promise((done) =>
    child.exitCode !== null ? done() : child.once("exit", done),
  );
};
try {
  if (acp) await load();
  const before = await response(send("get_state"));
  assert.equal(before.data.isCompacting, false);
  const compactId = send("compact");
  await wait(() => heldResponse, "one local compaction request");
  const active = await response(send("get_state"));
  assert.equal(active.data.isCompacting, true);
  const aborted = await response(send("abort"));
  assert.equal(aborted.success, true);
  if (acp) assert.equal(aborted.data.outcome, "unsupported");
  const afterAbort = await response(send("get_state"));
  assert.equal(
    afterAbort.data.isCompacting,
    true,
    "Update the limitation if native abort begins cancelling compaction",
  );
  assert.ok(!frames.some((frame) => frame.id === compactId));
  assert.ok(!nativeEvents().some((frame) => frame.type === "compaction_end"));
  heldResponse.writeHead(200, { "content-type": "text/event-stream" });
  for (const choice of [
    {
      index: 0,
      delta: { role: "assistant", content: "Synthetic compact summary" },
      finish_reason: null,
    },
    { index: 0, delta: {}, finish_reason: "stop" },
  ]) {
    heldResponse.write(
      `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [choice] })}\n\n`,
    );
  }
  heldResponse.end("data: [DONE]\n\n");
  const compact = await response(compactId);
  assert.equal(compact.success, true);
  if (acp) {
    assert.equal(compact.data.stopReason, "end_turn");
    assert.equal(compact.data._meta?.farfoldPiProviderRequest, undefined);
  }
  const end = await wait(
    () => nativeEvents().find((frame) => frame.type === "compaction_end"),
    "compaction end",
  );
  assert.equal(end.aborted, false);
  const final = await response(send("get_state"));
  assert.equal(final.data.isCompacting, false);
  assert.equal(final.data.sessionId, before.data.sessionId);
  assert.equal(requests, 1);
  if (acp) {
    assert.equal((await response(send("abort"))).data.outcome, "accepted");
    const history = await readFile(sessionFile, "utf8");
    await close();
    frames.length = 0;
    child = launch();
    observe();
    await load();
    const cold = await response(send("get_state"));
    assert.equal(cold.data.sessionId, before.data.sessionId);
    assert.equal(cold.data.sessionFile, before.data.sessionFile);
    assert.deepEqual(cold.data.model, before.data.model);
    assert.equal(cold.data.isCompacting, false);
    assert.equal(await readFile(sessionFile, "utf8"), history);
    assert.equal(requests, 1);
  }
  console.log(
    JSON.stringify({
      mode: acp ? "maintained-acp" : "fixed-pi-rpc",
      limitationConfirmed: !acp,
      stopUnsupportedConfirmed: acp,
      coldRestoreWithoutResend: acp,
      localRequests: requests,
      nativeAbortAck: aborted.success,
      compactingAfterAbortAck: afterAbort.data.isCompacting,
      compactionFinalAborted: end.aborted,
      compactionRpcSuccess: compact.success,
      sameSession: true,
      sessionFile,
    }),
  );
} finally {
  await close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
