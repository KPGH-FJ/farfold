import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = resolve(repo, "src-tauri/target/d-stage-pi-candidate-0912");
const pi = resolve(repo, "src-tauri/resources/pi-runtime/pi");
const farfold = process.argv.includes("--farfold");
const adapter = farfold
  ? resolve(repo, "src-tauri/pi-acp-adapter/dist/index.js")
  : resolve(base, "node_modules/pi-acp/dist/index.js");
const expectedPi =
  "e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(digest(await readFile(pi)), expectedPi);
const lock = JSON.parse(
  await readFile(
    resolve(
      farfold ? resolve(repo, "src-tauri/pi-acp-adapter") : base,
      "package-lock.json",
    ),
  ),
);
if (!farfold) {
  assert.equal(lock.packages["node_modules/pi-acp"].version, "0.0.33");
  assert.equal(
    lock.packages["node_modules/pi-acp"].integrity,
    "sha512-vX9kY1tK14E72G4dBAx+RGCk/k7XPjTHls6dLUxA8WSkBav6B6JHuSBv3eusp50LCR/GTRsR2kIKsG0Z5jANzw==",
  );
}
assert.equal(
  lock.packages["node_modules/@agentclientprotocol/sdk"].version,
  "0.26.0",
);
const root = await mkdtemp(resolve(base, "probe-"));
let modelRequests = 0;
const server = createServer((_request, response) => {
  modelRequests += 1;
  response.writeHead(500, { "content-type": "application/json" });
  response.end('{"error":{"message":"Model calls forbidden in this probe"}}');
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;

async function prepare(name) {
  const home = resolve(root, name);
  const agent = resolve(home, "agent");
  const cwd = resolve(home, "project");
  await mkdir(resolve(agent, "extensions"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await copyFile(
    resolve(repo, "scripts/fixtures/pi-acp-capability-probe.ts"),
    resolve(agent, "extensions/probe.ts"),
  );
  await writeFile(
    resolve(agent, "models.json"),
    JSON.stringify({
      providers: {
        "d-local-probe": {
          baseUrl: endpoint,
          api: "openai-completions",
          apiKey: "fixture-not-a-credential",
          models: [{ id: "fixture-only" }],
        },
      },
    }),
  );
  await writeFile(
    resolve(agent, "settings.json"),
    JSON.stringify({
      defaultProvider: "d-local-probe",
      defaultModel: "fixture-only",
      quietStartup: true,
    }),
  );
  return {
    cwd,
    // No inherited provider variables, global authentication, extensions or history.
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      PI_CODING_AGENT_DIR: agent,
      PI_CODING_AGENT_SESSION_DIR: resolve(agent, "sessions"),
      PI_ACP_PI_COMMAND: pi,
      XDG_CONFIG_HOME: resolve(home, "config"),
      XDG_CACHE_HOME: resolve(home, "cache"),
      XDG_DATA_HOME: resolve(home, "data"),
      TMPDIR: home,
      LANG: "en_US.UTF-8",
    },
  };
}

async function probe(name, acp, resume = null) {
  const options = resume?.options ?? (await prepare(name));
  const child = spawn(
    acp ? process.execPath : pi,
    acp ? [adapter] : ["--mode", "rpc", "--no-themes"],
    { ...options, detached: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const frames = [];
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-8192);
  });
  const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  let sequence = 0;
  const heldForms = new Map();
  const wait = async (predicate, label, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = frames.find(predicate);
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`${name} exited: ${stderr}`);
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error(`${name}: timed out waiting for ${label}; ${stderr}`);
  };
  const request = async (method, params = {}) => {
    const id = `${name}-${++sequence}`;
    send(
      acp
        ? { jsonrpc: "2.0", id, method, params }
        : { id, type: method, ...params },
    );
    return wait(
      (frame) =>
        frame.id === id && (acp ? !frame.method : frame.type === "response"),
      method,
    );
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    frames.push(frame);
    if (farfold && frame.method === "_pi/ui_withdrawn") {
      const nativeId = frame.params.nativeRequestId;
      const original = heldForms.get(nativeId);
      assert.ok(
        original,
        "Withdrawal must identify the exact held native form",
      );
      assert.equal(frame.params.sessionId, original.params.sessionId);
      heldForms.delete(nativeId);
      // Simulate an answer already in flight when the Host processes withdrawal.
      send({
        jsonrpc: "2.0",
        id: original.id,
        result: {
          action: "accept",
          content: { value: "late must be ignored" },
        },
      });
    }
    if (farfold && frame.method === "elicitation/create") {
      if (frame.params._meta.farfoldPi.event.title === "D timeout") {
        heldForms.set(frame.params._meta.farfoldPi.event.id, frame);
        return;
      }
      const values = {
        select: "Two",
        confirm: false,
        input: "D input response",
        editor: "D editor response\nSecond line",
      };
      const method = frame.params._meta.farfoldPi.event.method;
      assert.ok(Object.hasOwn(values, method));
      send({
        jsonrpc: "2.0",
        id: frame.id,
        result: { action: "accept", content: { value: values[method] } },
      });
    }
    if (!acp && frame.type === "extension_ui_request") {
      const answers = {
        select: { value: "Two" },
        confirm: { confirmed: false },
        input: { value: "D input response" },
        editor: { value: "D editor response\nSecond line" },
      };
      if (answers[frame.method])
        send({
          type: "extension_ui_response",
          id: frame.id,
          ...answers[frame.method],
        });
    }
    if (acp && frame.method === "session/request_permission") {
      const option = frame.params.options.find(
        (value) => value.name === "Two" || value.optionId === "no",
      );
      assert.ok(option, "Native select/confirm option must be preserved");
      send({
        jsonrpc: "2.0",
        id: frame.id,
        result: { outcome: { outcome: "selected", optionId: option.optionId } },
      });
    }
  });
  try {
    let session;
    if (acp) {
      const initialized = await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          elicitation: { form: {} },
          ...(farfold ? { _meta: { farfoldPi: { version: 1 } } } : {}),
        },
        clientInfo: { name: "farfold-d-probe", version: "1" },
      });
      assert.ok(initialized.result, JSON.stringify(initialized));
      if (resume) {
        const wrongCwd = await request("session/load", {
          sessionId: resume.sessionId,
          cwd: root,
          mcpServers: [],
        });
        assert.equal(wrongCwd.error?.code, -32602);
        const loaded = await request("session/load", {
          sessionId: resume.sessionId,
          cwd: options.cwd,
          mcpServers: [],
        });
        if (resume.expectMissing) {
          assert.equal(loaded.error?.code, -32602);
          return { rejectedMissing: true, frames };
        }
        assert.ok(loaded.result, JSON.stringify(loaded));
        session = { result: { ...loaded.result, sessionId: resume.sessionId } };
        const second = await request("session/new", {
          cwd: options.cwd,
          mcpServers: [],
        });
        assert.ok(second.result?.sessionId);
        assert.notEqual(second.result.sessionId, resume.sessionId);
        const replay = await request("session/load", {
          sessionId: resume.sessionId,
          cwd: options.cwd,
          mcpServers: [],
        });
        assert.ok(replay.result, JSON.stringify(replay));
      } else {
        session = await request("session/new", {
          cwd: options.cwd,
          mcpServers: [],
        });
        assert.ok(session.result?.sessionId, JSON.stringify(session));
      }
      send({
        jsonrpc: "2.0",
        id: "extension-command",
        method: "session/prompt",
        params: {
          sessionId: session.result.sessionId,
          prompt: [{ type: "text", text: "/farfold-d-probe" }],
        },
      });
    } else {
      session = await request("get_state");
      assert.equal(session.success, true);
      const commands = await request("get_commands");
      assert.ok(JSON.stringify(commands).includes("farfold-d-probe"));
      send({
        id: "extension-command",
        type: "prompt",
        message: "/farfold-d-probe",
      });
    }
    const marker = await wait(
      (frame) => JSON.stringify(frame).includes("D-PROBE-RESULT:"),
      "extension result",
    );
    await new Promise((done) => setTimeout(done, 250));
    if (farfold) {
      const response = await wait(
        (frame) => frame.id === "extension-command" && !frame.method,
        "native extension command completion",
      );
      assert.equal(response.result?.stopReason, "end_turn");
      const thinking = session.result.configOptions.find(
        (option) => option.id === "thought_level",
      );
      assert.deepEqual(
        thinking.options.map((option) => option.value),
        ["off"],
      );
      const intervention = await request("_pi/steer", {
        sessionId: session.result.sessionId,
        message: "Must not run while idle",
      });
      assert.ok(intervention.error);
      assert.equal(intervention.error.code, -32600);
      assert.match(JSON.stringify(intervention.error.data), /live active task/);
      if (resume) {
        const timed = await request("session/prompt", {
          sessionId: session.result.sessionId,
          prompt: [{ type: "text", text: "/farfold-d-timeout" }],
        });
        assert.equal(timed.result?.stopReason, "end_turn");
        const notification = await wait(
          (frame) =>
            frame.method === "_pi/ui" &&
            frame.params.event.message?.startsWith("D-TIMEOUT-RESULT:"),
          "native timeout result",
        );
        assert.equal(
          notification.params.event.message,
          "D-TIMEOUT-RESULT:null",
        );
        const withdrawn = await wait(
          (frame) => frame.method === "_pi/ui_withdrawn",
          "Host form withdrawal",
        );
        assert.equal(withdrawn.params.reason, "timeout");
        assert.equal(heldForms.size, 0);
      }
    }
    return {
      options,
      session,
      marker,
      extensionMethods: frames
        .filter((frame) => frame.type === "extension_ui_request")
        .map((frame) => frame.method),
      permissionCount: frames.filter(
        (frame) => frame.method === "session/request_permission",
      ).length,
      unsupportedNotices: frames.filter((frame) =>
        JSON.stringify(frame).includes("not supported in ACP yet"),
      ),
      commandResponse:
        frames.find(
          (frame) => frame.id === "extension-command" && !frame.method,
        ) ?? null,
      frames,
    };
  } finally {
    const closed = new Promise((done) => child.once("close", done));
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    const killTimer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already gone. */
      }
    }, 1500);
    await closed;
    clearTimeout(killTimer);
  }
}

try {
  const native = farfold ? null : await probe("native", false);
  const acp = await probe("acp", true);
  let identity = null;
  if (farfold) {
    const sessionId = acp.session.result.sessionId;
    const sessionMap = resolve(
      acp.options.env.PI_CODING_AGENT_DIR,
      "farfold-acp/session-map.json",
    );
    const binding = acp.session.result._meta.farfoldPi.nativeSession;
    assert.equal(binding.version, 1);
    assert.equal(binding.sessionId, sessionId);
    assert.equal(binding.cwd, acp.options.cwd);
    const missing = await probe("acp-missing", true, {
      options: acp.options,
      sessionId,
      expectMissing: true,
    });
    // A pure extension command has no assistant message, so Pi has not flushed a file.
    // Seed only a valid header for a model-free native load test, not task-history evidence.
    await mkdir(dirname(binding.sessionFile), { recursive: true });
    await writeFile(
      binding.sessionFile,
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        cwd: binding.cwd,
        timestamp: new Date().toISOString(),
      }) + "\n",
      { flag: "wx" },
    );
    const beforeHeader = (await readFile(binding.sessionFile, "utf8")).split(
      "\n",
    )[0];
    const restored = await probe("acp-cold", true, {
      options: acp.options,
      sessionId,
    });
    assert.deepEqual(
      restored.session.result._meta.farfoldPi.nativeSession,
      binding,
    );
    const afterLines = (await readFile(binding.sessionFile, "utf8"))
      .trim()
      .split("\n");
    assert.equal(afterLines[0], beforeHeader);
    const appended = afterLines.slice(1).map((line) => JSON.parse(line));
    assert.deepEqual(
      appended.map((entry) => entry.type),
      ["model_change", "thinking_level_change"],
    );
    assert.equal(appended[0].provider, "d-local-probe");
    assert.equal(appended[0].modelId, "fixture-only");
    assert.equal(appended[1].thinkingLevel, "off");
    const current = JSON.parse(await readFile(sessionMap, "utf8")).sessions[
      sessionId
    ];
    assert.equal(current.sessionFile, binding.sessionFile);
    assert.equal(current.cwd, binding.cwd);
    identity = {
      scope:
        "Real Pi cold load of fixture-seeded header, not model history persistence",
      sessionId,
      sessionFile: binding.sessionFile,
      missingRejected: missing.rejectedMissing,
      restored: restored.commandResponse,
      headerUnchanged: true,
      nativeAppended: appended,
      timeoutWithdrawal: restored.frames.filter(
        (frame) => frame.method === "_pi/ui_withdrawn",
      ),
    };
  }
  assert.equal(modelRequests, 0);
  const markerData = (text) => JSON.parse(text.slice("D-PROBE-RESULT:".length));
  const expected = {
    selected: "Two",
    confirmed: false,
    input: "D input response",
    editor: "D editor response\nSecond line",
  };
  if (native) assert.deepEqual(markerData(native.marker.message), expected);
  assert.deepEqual(
    markerData(
      farfold
        ? acp.marker.params.event.message
        : acp.marker.params.update.content.text,
    ),
    farfold
      ? expected
      : {
          selected: "Two",
          confirmed: false,
          input: null,
          editor: null,
        },
  );
  assert.equal(acp.permissionCount, farfold ? 0 : 2);
  assert.equal(acp.unsupportedNotices.length, farfold ? 0 : 2);
  if (native)
    assert.deepEqual(native.extensionMethods, [
      "select",
      "confirm",
      "input",
      "editor",
      "setStatus",
      "setWidget",
      "setTitle",
      "set_editor_text",
      "notify",
    ]);
  assert.equal(
    acp.frames.some((frame) =>
      /D status|D widget|D title|D draft/.test(JSON.stringify(frame)),
    ),
    farfold,
  );
  if (farfold) {
    assert.equal(
      acp.frames.filter((frame) => frame.method === "elicitation/create")
        .length,
      4,
    );
    assert.deepEqual(
      acp.frames
        .filter((frame) => frame.method === "_pi/ui")
        .map((frame) => frame.params.event.method),
      ["setStatus", "setWidget", "setTitle", "set_editor_text", "notify"],
    );
  }
  const result = {
    scope:
      "Model-free candidate comparison, not product or Provider acceptance",
    piVersion: "0.84.3",
    piSha256: expectedPi,
    adapterVersion: farfold ? "0.0.33-farfold.1" : "0.0.33",
    adapterSha256: digest(await readFile(adapter)),
    sdkVersion: "0.26.0",
    modelRequests,
    identity,
    native,
    acp,
  };
  const output = resolve(root, "result.json");
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        output,
        modelRequests,
        identity,
        native: native?.marker,
        acp: acp.marker,
        nativeMethods: native?.extensionMethods,
        acpPermissions: acp.permissionCount,
        unsupported: acp.unsupportedNotices.length,
        acpCommandResponse: acp.commandResponse,
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise((done) => server.close(done));
}
