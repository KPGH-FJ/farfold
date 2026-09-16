// Explicit fixed-runtime integration probe. Only loopback HTTP and synthetic auth.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pi = resolve(repo, "src-tauri/resources/pi-runtime/pi");
const adapter = resolve(repo, "src-tauri/pi-acp-adapter/dist/index.js");
assert.equal(
  createHash("sha256")
    .update(await readFile(pi))
    .digest("hex"),
  "e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac",
);
const base = resolve(repo, "src-tauri/target/d-stage-pi-candidate-0912");
await mkdir(base, { recursive: true });
const root = await mkdtemp(resolve(base, "native-workflow-"));

async function run(acp) {
  const home = resolve(root, acp ? "acp" : "rpc");
  const agent = resolve(home, "agent");
  const cwd = resolve(home, "project");
  await mkdir(agent, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const requests = [];
  let firstResponse;
  const reply = (response, tool = false, label = "") => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: "local-write",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  path: "result.txt",
                  content: "LOCAL-TOOL-OK\n",
                }),
              },
            },
          ],
        }
      : { content: label };
    for (const chunk of [
      {
        choices: [
          {
            index: 0,
            delta: { role: "assistant", ...delta },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      },
    ])
      response.write(
        `data: ${JSON.stringify({ id: "local-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-only", ...chunk })}\n\n`,
      );
    response.end("data: [DONE]\n\n");
  };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    requests.push(JSON.parse(body));
    if (requests.length === 1) firstResponse = response;
    else if (requests.length <= 3)
      reply(
        response,
        false,
        requests.length === 2 ? "STEER-DONE" : "FOLLOWUP-DONE",
      );
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
        "d-local-workflow": {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          api: "openai-completions",
          apiKey: "synthetic-local-only",
          models: [
            { id: "fixture-only", contextWindow: 16384, maxTokens: 4096 },
          ],
        },
      },
    }),
  );
  await writeFile(
    resolve(agent, "settings.json"),
    JSON.stringify({
      defaultProvider: "d-local-workflow",
      defaultModel: "fixture-only",
      quietStartup: true,
    }),
  );
  const child = spawn(
    acp ? process.execPath : pi,
    acp ? [adapter] : ["--mode", "rpc", "--no-themes"],
    {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        HOME: home,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        PI_CODING_AGENT_DIR: agent,
        PI_CODING_AGENT_SESSION_DIR: resolve(agent, "sessions"),
        PI_ACP_PI_COMMAND: pi,
        TMPDIR: home,
        XDG_CONFIG_HOME: resolve(home, "config"),
        XDG_CACHE_HOME: resolve(home, "cache"),
        XDG_DATA_HOME: resolve(home, "data"),
        LANG: "en_US.UTF-8",
      },
    },
  );
  const frames = [];
  let stderrBytes = 0;
  child.stderr.on("data", (data) => {
    stderrBytes += data.length;
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    frames.push(JSON.parse(line));
  });
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      assert.equal(
        child.exitCode,
        null,
        `Runtime exited during ${label}; stderr bytes=${stderrBytes}`,
      );
      assert.ok(Date.now() < deadline, `Timeout: ${label}`);
      await new Promise((done) => setTimeout(done, 10));
    }
    return predicate();
  };
  let sequence = 0;
  const send = (method, params) => {
    const id = `fixture-${++sequence}`;
    child.stdin.write(
      JSON.stringify(
        acp
          ? { jsonrpc: "2.0", id, method, params }
          : { id, type: method, ...params },
      ) + "\n",
    );
    return id;
  };
  const request = async (method, params = {}) => {
    const id = send(method, params);
    const frame = await wait(
      () => frames.find((item) => item.id === id && !item.method),
      method,
    );
    assert.ok(
      !frame.error && (acp || frame.success === true),
      JSON.stringify(frame),
    );
    return acp ? frame.result : frame.data;
  };
  const nativeEvents = () =>
    acp
      ? frames
          .filter((frame) => frame.method === "_pi/event")
          .map((frame) => frame.params.event)
      : frames;
  try {
    let sessionId;
    if (acp) {
      await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          elicitation: { form: {} },
          _meta: { farfoldPi: { version: 1 } },
        },
      });
      sessionId = (await request("session/new", { cwd, mcpServers: [] }))
        .sessionId;
    } else {
      sessionId = (await request("get_state")).sessionId;
    }
    const promptId = send(
      acp ? "session/prompt" : "prompt",
      acp
        ? { sessionId, prompt: [{ type: "text", text: "BASE-WORK" }] }
        : { message: "BASE-WORK" },
    );
    await wait(() => firstResponse, "first local model request");
    await request(acp ? "_pi/steer" : "steer", {
      ...(acp ? { sessionId } : {}),
      message: "STEER-WORK",
    });
    await request(acp ? "_pi/follow_up" : "follow_up", {
      ...(acp ? { sessionId } : {}),
      message: "FOLLOWUP-WORK",
    });
    if (acp)
      assert.ok(
        !frames.some((frame) => frame.id === promptId),
        "ACP task cannot settle before queued work",
      );
    reply(firstResponse, true);
    await wait(
      () => nativeEvents().some((event) => event.type === "agent_settled"),
      "native settlement after queued work",
    );
    if (acp) {
      const result = await wait(
        () => frames.find((frame) => frame.id === promptId),
        "ACP terminal result",
      );
      assert.equal(result.result?.stopReason, "end_turn");
    }
    assert.equal(requests.length, 3);
    const users = requests.map((body) =>
      body.messages
        .filter((message) => message.role === "user")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) => part.text ?? "").join(""),
        ),
    );
    assert.deepEqual(users, [
      ["BASE-WORK"],
      ["BASE-WORK", "STEER-WORK"],
      ["BASE-WORK", "STEER-WORK", "FOLLOWUP-WORK"],
    ]);
    assert.equal(
      await readFile(resolve(cwd, "result.txt"), "utf8"),
      "LOCAL-TOOL-OK\n",
    );
    assert.ok(
      nativeEvents().some(
        (event) =>
          event.type === "tool_execution_end" &&
          event.toolName === "write" &&
          !event.isError,
      ),
    );
    if (acp)
      assert.ok(
        frames.some(
          (frame) =>
            frame.method === "session/update" &&
            frame.params.update.content?.some?.((item) => item.type === "diff"),
        ),
        "ACP file diff missing",
      );
    const data = acp
      ? (await request("_pi/workspace", { sessionId, section: "messages" }))
          .data
      : await request("get_messages");
    const messages = data.messages;
    assert.equal(
      messages.filter((message) => message.role === "user").length,
      3,
    );
    console.log(
      JSON.stringify({
        mode: acp ? "maintained-acp" : "fixed-pi-rpc",
        localRequests: requests.length,
        userOrder: users.at(-1),
        nativeWrite: true,
        nativeSettlement: true,
        sessionId,
        artifact: resolve(cwd, "result.txt"),
      }),
    );
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    await new Promise((done) =>
      child.exitCode !== null ? done() : child.once("exit", done),
    );
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

await run(false);
await run(true);
