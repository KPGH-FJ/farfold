import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const OPENCODE_ACP_SHA256 =
  "2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62";
const ACP_SDK_VERSION = "1.4.0";
const MAX_FRAME_BYTES = 1024 * 1024;
const binary = process.env.OPENCODE_ACP_TEST_BINARY;

if (!binary) {
  throw new Error(
    "Set OPENCODE_ACP_TEST_BINARY to the fixed OpenCode 1.18.30 binary.",
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, label, timeout = 30_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), timeout),
    ),
  ]);
}

function sse(chunks) {
  return (
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

function messagesText(messages) {
  return JSON.stringify(messages ?? []);
}

function readJsonRequest(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_FRAME_BYTES) {
        request.destroy(new Error("request body too large"));
      }
    });
    request.on("end", () => resolve(body ? JSON.parse(body) : {}));
    request.on("error", reject);
  });
}

async function sha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return hash.digest("hex");
}

async function loadOfficialAcpSchema() {
  const sdkDir = process.env.ACP_SDK_DIR;
  if (!sdkDir) {
    throw new Error(
      `Set ACP_SDK_DIR to @agentclientprotocol/sdk@${ACP_SDK_VERSION} package root for schema validation.`,
    );
  }
  return import(pathToFileURL(join(sdkDir, "dist/schema/zod.gen.js")).href);
}

async function startFixtureProvider() {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const body = await readJsonRequest(request);
      const bodyText = messagesText(body.messages);
      const lastMessageText = messagesText(
        Array.isArray(body.messages) ? body.messages.slice(-1) : [],
      );
      requests.push({
        path: request.url,
        model: body.model,
        toolNames: Array.isArray(body.tools)
          ? body.tools.map(
              (tool) => tool.function?.name ?? tool.name ?? "<unknown>",
            )
          : [],
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        sawQuestionResult: bodyText.includes(
          "User has answered your questions",
        ),
        sawAcpBridgeAnswer:
          bodyText.includes("User has answered your questions") &&
          bodyText.includes("ACP bridge"),
        sawPermissionPrompt: bodyText.includes("permission probe"),
        sawComboPrompt: bodyText.includes("combo same prompt"),
        sawCatCommand: bodyText.includes("cat /etc/hosts"),
        sawAfterCancelPrompt: bodyText.includes("after cancel"),
      });
      if (process.env.FARFOLD_SPIKE_DEBUG === "1") {
        process.stderr.write(`[fixture] ${JSON.stringify(requests.at(-1))}\n`);
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "close",
      });
      const hasQuestionResult = bodyText.includes(
        "User has answered your questions",
      );
      const questionTool = Array.isArray(body.tools)
        ? body.tools.find(
            (tool) =>
              tool.function?.name === "question" || tool.name === "question",
          )
        : null;
      const bashTool = Array.isArray(body.tools)
        ? body.tools.find(
            (tool) => tool.function?.name === "bash" || tool.name === "bash",
          )
        : null;
      if (lastMessageText.includes("after cancel")) {
        if (lastMessageText.includes("delayed incremental")) await wait(800);
        if (process.env.FARFOLD_SPIKE_DEBUG === "1") {
          process.stderr.write("[fixture-branch] after-cancel\n");
        }
        response.end(
          sse([
            {
              id: "after-cancel-final",
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "after cancel ok" },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "after-cancel-final",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
          ]),
        );
        return;
      }
      if (
        bashTool &&
        (lastMessageText.includes("permission probe") ||
          (bodyText.includes("combo permission same prompt") &&
            hasQuestionResult)) &&
        !bodyText.includes("cat /etc/hosts")
      ) {
        if (process.env.FARFOLD_SPIKE_DEBUG === "1") {
          process.stderr.write("[fixture-branch] bash-permission\n");
        }
        response.end(
          sse([
            {
              id: "permission-step",
              object: "chat.completion.chunk",
              choices: [
                { index: 0, delta: { role: "assistant" }, finish_reason: null },
              ],
            },
            {
              id: "permission-step",
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_bash_1",
                        type: "function",
                        function: {
                          name: "bash",
                          arguments: '{"command":"cat /etc/hosts"}',
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "permission-step",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            },
          ]),
        );
        return;
      }
      const comboQuestionText = !bodyText.includes("Combo first path")
        ? "Combo first path"
        : !bodyText.includes("Combo second path")
          ? "Combo second path"
          : null;
      const questionText = bodyText.includes("combo same prompt")
        ? comboQuestionText
        : "Choose the spike path";
      const wantsQuestion =
        questionTool &&
        ((bodyText.includes("combo same prompt") && Boolean(questionText)) ||
          !hasQuestionResult ||
          lastMessageText.includes("reject coverage") ||
          lastMessageText.includes("cancel coverage") ||
          lastMessageText.includes("recovery coverage"));
      if (wantsQuestion) {
        if (process.env.FARFOLD_SPIKE_DEBUG === "1") {
          process.stderr.write("[fixture-branch] question\n");
        }
        response.end(
          sse([
            {
              id: "question-step",
              object: "chat.completion.chunk",
              choices: [
                { index: 0, delta: { role: "assistant" }, finish_reason: null },
              ],
            },
            {
              id: "question-step",
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_question_1",
                        type: "function",
                        function: {
                          name: "question",
                          arguments: JSON.stringify({
                            questions: [
                              {
                                question: questionText,
                                header: "Route",
                                custom: false,
                                options: [
                                  {
                                    label: "ACP bridge",
                                    description: "Use adapter-contained bridge",
                                  },
                                  {
                                    label: "Stop",
                                    description: "Do not continue",
                                  },
                                ],
                              },
                            ],
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "question-step",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            },
          ]),
        );
        return;
      }
      if (process.env.FARFOLD_SPIKE_DEBUG === "1") {
        process.stderr.write("[fixture-branch] final\n");
      }
      response.end(
        sse([
          {
            id: "final-step",
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "question answered" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "final-step",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ]),
      );
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: String(error?.message ?? error) } }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function requestJson(base, method, path, body) {
  const response = await fetch(new URL(path, base), {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${method} ${path} failed ${response.status}: ${text.slice(0, 1000)}`,
    );
  }
  return text ? JSON.parse(text) : null;
}

class JsonRpcPeer {
  constructor(input, output, onRequest) {
    this.output = output;
    this.nextId = 1;
    this.pending = new Map();
    this.onRequest = onRequest;
    this.lines = createInterface({ input });
    this.lines.on("line", (line) => void this.receiveLine(line));
    this.lines.on("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("stdio closed"));
      }
      this.pending.clear();
    });
  }

  async receiveLine(line) {
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
      throw new Error("oversized JSON-RPC frame");
    }
    const message = JSON.parse(line);
    if (message.id !== undefined && !message.method) {
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (pending) {
        this.pending.delete(key);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (this.onRequest) {
        await this.onRequest(message, this);
      }
      return;
    }
    if (message.method && this.onRequest) {
      await this.onRequest(message, this);
    }
  }

  write(message) {
    const text = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
      throw new Error("oversized JSON-RPC frame");
    }
    this.output.write(text);
  }

  request(method, params, id = `driver-${this.nextId++}`) {
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id, result) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  error(id, code, message) {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }
}

class DriverPeer extends JsonRpcPeer {
  constructor(input, output) {
    super(input, output, async (message) => this.handleServerRequest(message));
    this.serverRequests = [];
  }

  async handleServerRequest(message) {
    this.serverRequests.push(message);
  }

  async waitRequest(method, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const index = this.serverRequests.findIndex(
        (item) => item.method === method,
      );
      if (index >= 0) return this.serverRequests.splice(index, 1)[0];
      await wait(20);
    }
    throw new Error(`timed out waiting for ${method}`);
  }
}

async function startOpenCodeServe(root, fixtureEndpoint) {
  const workspace = join(root, "workspace");
  const configRoot = join(root, "config-root");
  const home = join(root, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(configRoot, "config"), { recursive: true });
  await mkdir(join(configRoot, "xdg-config", "opencode"), { recursive: true });
  await mkdir(home, { recursive: true });
  const config = {
    model: "farfold-spike/spike-model",
    provider: {
      "farfold-spike": {
        name: "Farfold Question Spike",
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: fixtureEndpoint,
          apiKey: "local-fixture-placeholder",
        },
        models: {
          "spike-model": {
            name: "spike-model",
            limit: { context: 200000, output: 16000 },
          },
        },
      },
    },
  };
  await writeFile(
    join(configRoot, "config", "opencode.json"),
    JSON.stringify(config),
  );
  await writeFile(
    join(configRoot, "xdg-config", "opencode", "opencode.json"),
    JSON.stringify(config),
  );

  const child = spawn(
    binary,
    ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: workspace,
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        OPENCODE_CONFIG_DIR: join(configRoot, "config"),
        XDG_CONFIG_HOME: join(configRoot, "xdg-config"),
        XDG_DATA_HOME: join(root, "xdg-data"),
        XDG_CACHE_HOME: join(root, "xdg-cache"),
        XDG_STATE_HOME: join(root, "xdg-state"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 15_000;
  let base;
  while (Date.now() < deadline) {
    const match = stdout.match(
      /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/,
    );
    if (match) {
      base = match[1];
      break;
    }
    if (child.exitCode !== null) {
      throw new Error(`OpenCode exited early: ${stderr || stdout}`);
    }
    await wait(50);
  }
  if (!base) {
    throw new Error(
      `OpenCode serve did not report a port. stdout=${stdout} stderr=${stderr}`,
    );
  }
  const events = [];
  const eventStop = { stopped: false };
  void startNativeEventStream(base, events, eventStop);
  return { base, workspace, child, events, eventStop };
}

async function startNativeEventStream(base, events, stop) {
  try {
    const response = await fetch(new URL("/global/event", base));
    if (!response.ok || !response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!stop.stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator;
      while ((separator = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          events.push(JSON.parse(data));
        } catch {
          events.push({ type: "farfold.spike.invalid_sse_json" });
        }
      }
    }
    reader.releaseLock();
  } catch {
    events.push({ type: "farfold.spike.sse_closed" });
  }
}

async function runAdapter() {
  const providedRoot = process.env.FARFOLD_SPIKE_ADAPTER_ROOT;
  const root =
    providedRoot ??
    (await mkdtemp(join(tmpdir(), "farfold-opencode-acp-adapter-")));
  const ownsRoot = !providedRoot;
  let opencode = externalOpenCodeFromEnv();
  const pendingNative = new Map();
  const peer = new JsonRpcPeer(
    process.stdin,
    process.stdout,
    async (message) => {
      try {
        if (message.method === "initialize") {
          peer.respond(message.id, {
            protocolVersion: 1,
            agentInfo: {
              name: "Farfold OpenCode HTTP Question Bridge Spike",
              version: "0.0.0-spike",
            },
            agentCapabilities: { loadSession: true },
          });
        } else if (message.method === "initialized") {
          return;
        } else if (message.method === "session/new") {
          opencode ??= await startOpenCodeServe(
            root,
            process.env.FARFOLD_SPIKE_PROVIDER_ENDPOINT,
          );
          const session = await requestJson(
            opencode.base,
            "POST",
            `/session?directory=${encodeURIComponent(opencode.workspace)}`,
            {},
          );
          peer.respond(message.id, {
            sessionId: session.id,
            _meta: adapterProcessMeta(opencode),
          });
        } else if (message.method === "session/load") {
          opencode ??= await startOpenCodeServe(
            root,
            process.env.FARFOLD_SPIKE_PROVIDER_ENDPOINT,
          );
          const sessionId = message.params?.sessionId;
          await requestJson(opencode.base, "GET", `/session/${sessionId}`);
          peer.respond(message.id, {
            sessionId,
            _meta: adapterProcessMeta(opencode),
          });
          void emitPendingQuestion(peer, opencode, sessionId, pendingNative);
        } else if (message.method === "session/prompt") {
          void handleAdapterPrompt(peer, opencode, message, pendingNative);
        } else if (message.method === "session/cancel") {
          const sessionId = message.params?.sessionId;
          for (const [requestId, request] of pendingNative) {
            if (request.sessionId === sessionId) {
              await request.cancel();
              pendingNative.delete(requestId);
            }
          }
          await abortNativeSession(opencode, sessionId);
        } else if (message.id !== undefined) {
          const request = pendingNative.get(String(message.id));
          if (request) {
            pendingNative.delete(String(message.id));
            await request.handleResult(message.result);
          }
        }
      } catch (error) {
        if (message.id !== undefined) {
          peer.error(message.id, -32000, String(error?.message ?? error));
        } else {
          throw error;
        }
      }
    },
  );
  async function cleanup() {
    if (
      !opencode?.external &&
      opencode?.child &&
      opencode.child.exitCode === null
    ) {
      if (opencode.eventStop) opencode.eventStop.stopped = true;
      opencode.child.kill("SIGKILL");
    }
    if (ownsRoot) await rm(root, { recursive: true, force: true });
  }
  process.on("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.on("exit", () => {
    if (ownsRoot) void rm(root, { recursive: true, force: true });
  });
}

function externalOpenCodeFromEnv() {
  const base = process.env.FARFOLD_SPIKE_OPENCODE_BASE;
  const workspace = process.env.FARFOLD_SPIKE_OPENCODE_WORKSPACE;
  const pid = Number(process.env.FARFOLD_SPIKE_OPENCODE_PID);
  if (!base || !workspace || !Number.isFinite(pid)) return null;
  return {
    base,
    workspace,
    external: true,
    events: [],
    child: {
      pid,
      exitCode: null,
    },
  };
}

async function emitPendingQuestion(peer, opencode, sessionId, pendingNative) {
  const question = await nativeMaybe(opencode, sessionId, "/question");
  if (!question) return;
  const requestId = `elicitation-${question.id}`;
  pendingNative.set(requestId, {
    sessionId,
    cancel: () =>
      requestJson(
        opencode.base,
        "POST",
        `/question/${question.id}/reject?directory=${encodeURIComponent(opencode.workspace)}`,
      ),
    handleResult: async (result) => {
      await respondToNativeQuestion(opencode, question.id, result);
    },
  });
  peer.write({
    jsonrpc: "2.0",
    id: requestId,
    method: "elicitation/create",
    params: formElicitationParams(sessionId, question),
  });
}

async function handleAdapterPrompt(peer, opencode, message, pendingNative) {
  if (!opencode) throw new Error("session/new must run before session/prompt");
  const sessionId = message.params?.sessionId;
  const text = message.params?.prompt?.[0]?.text ?? "";
  await requestJson(
    opencode.base,
    "POST",
    `/session/${sessionId}/prompt_async?directory=${encodeURIComponent(opencode.workspace)}`,
    { agent: "build", parts: [{ type: "text", text }] },
  );
  if (process.env.FARFOLD_SPIKE_DEBUG === "1") {
    process.stderr.write(
      `[adapter] prompt submitted ${JSON.stringify({ sessionId, text })}\n`,
    );
  }
  const startedAt = Date.now();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const question = await nativeMaybe(opencode, sessionId, "/question");
    if (question) {
      const requestId = `elicitation-${question.id}`;
      pendingNative.set(requestId, {
        sessionId,
        cancel: () =>
          requestJson(
            opencode.base,
            "POST",
            `/question/${question.id}/reject?directory=${encodeURIComponent(opencode.workspace)}`,
          ),
        handleResult: async (result) => {
          const action = result?.action ?? result?.outcome;
          await respondToNativeQuestion(opencode, question.id, result);
          const terminal = await waitSessionIdle(opencode, sessionId, 15_000);
          peer.respond(message.id, {
            stopReason: terminal.idle ? "end_turn" : "max_turn_requests",
            nativeRequestId: question.id,
            _meta: { ...nativeEventMeta(opencode, sessionId), terminal },
          });
        },
      });
      peer.write({
        jsonrpc: "2.0",
        id: requestId,
        method: "elicitation/create",
        params: formElicitationParams(sessionId, question),
      });
      return;
    }
    const permission = await nativeMaybe(opencode, sessionId, "/permission");
    if (permission) {
      const requestId = `permission-${permission.id}`;
      const rejectPermission = () =>
        requestJson(
          opencode.base,
          "POST",
          `/session/${sessionId}/permissions/${permission.id}`,
          { response: "reject" },
        );
      pendingNative.set(requestId, {
        sessionId,
        cancel: rejectPermission,
        handleResult: async () => {
          await rejectPermission();
          const terminal = await waitSessionIdle(opencode, sessionId, 15_000);
          peer.respond(message.id, {
            stopReason: "cancelled",
            nativeRequestId: permission.id,
            _meta: { ...nativeEventMeta(opencode, sessionId), terminal },
          });
        },
      });
      peer.write({
        jsonrpc: "2.0",
        id: requestId,
        method: "session/request_permission",
        params: {
          sessionId,
          requestId: permission.id,
          toolCall: permission.call ?? { toolCallId: permission.id },
          options: [
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
          nativeEnvelope: permission,
        },
      });
      return;
    }
    if (Date.now() - startedAt > 500) {
      const idle = await sessionIdle(opencode, sessionId);
      if (idle) {
        peer.respond(message.id, {
          stopReason: "end_turn",
          _meta: nativeEventMeta(opencode, sessionId),
        });
        return;
      }
    }
    await wait(100);
  }
  peer.error(message.id, -32000, "prompt did not reach a native request");
}

function adapterProcessMeta(opencode) {
  return {
    adapterPid: process.pid,
    opencodePid: opencode.child.pid,
    opencodeBase: opencode.base,
    opencodeWorkspace: opencode.workspace,
  };
}

async function respondToNativeQuestion(opencode, questionId, result) {
  const action = result?.action ?? result?.outcome;
  if (action === "accept") {
    await requestJson(
      opencode.base,
      "POST",
      `/question/${questionId}/reply?directory=${encodeURIComponent(opencode.workspace)}`,
      { answers: [[result.content?.choice ?? "ACP bridge"]] },
    );
    return;
  }
  await requestJson(
    opencode.base,
    "POST",
    `/question/${questionId}/reject?directory=${encodeURIComponent(opencode.workspace)}`,
  );
}

async function nativeMaybe(opencode, sessionId, path) {
  const value = await requestJson(
    opencode.base,
    "GET",
    `${path}?directory=${encodeURIComponent(opencode.workspace)}`,
  );
  const list = Array.isArray(value) ? value : value?.data;
  return list?.find(
    (item) => item.sessionID === sessionId || item.sessionId === sessionId,
  );
}

async function sessionIdle(opencode, sessionId) {
  const value = await requestJson(opencode.base, "GET", "/session/status");
  const status = value?.[sessionId];
  if (!status) return true;
  if (status.type === "idle") return true;
  if (status.type === "busy" || status.type === "retry") return false;
  return false;
}

async function waitSessionIdle(opencode, sessionId, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await sessionIdle(opencode, sessionId)) {
      return { idle: true };
    }
    await wait(100);
  }
  return { idle: false };
}

async function abortNativeSession(opencode, sessionId) {
  if (!opencode) return false;
  return requestJson(
    opencode.base,
    "POST",
    `/session/${sessionId}/abort?directory=${encodeURIComponent(opencode.workspace)}`,
  ).catch(() => false);
}

function nativeEventMeta(opencode, sessionId) {
  const matching = (opencode?.events ?? []).filter(
    (event) => event?.properties?.sessionID === sessionId,
  );
  return {
    nativeEventTypes: Array.from(new Set(matching.map((event) => event.type))),
    nativeEventCount: matching.length,
  };
}

function formElicitationParams(sessionId, question) {
  return {
    sessionId,
    mode: "form",
    message: question.questions?.[0]?.question ?? "Question",
    requestedSchema: {
      type: "object",
      properties: {
        choice: {
          type: "string",
          enum: ["ACP bridge", "Stop"],
        },
      },
      required: ["choice"],
    },
    _meta: {
      farfoldNativeQuestionId: question.id,
    },
  };
}

function validateFormElicitation(request, sessionId) {
  if (request.params?.sessionId !== sessionId) {
    throw new Error("elicitation request used a different session");
  }
  if (request.params?.mode !== "form") {
    throw new Error("elicitation request did not use form mode");
  }
  const schema = request.params?.requestedSchema;
  if (
    schema?.type !== "object" ||
    schema?.properties?.choice?.type !== "string" ||
    !Array.isArray(schema?.properties?.choice?.enum) ||
    !schema.required?.includes("choice")
  ) {
    throw new Error(
      "elicitation request did not include the expected form schema",
    );
  }
}

async function runRecoveryScenario({
  acpSchema,
  adapter,
  peer,
  adapterRoot,
  fixture,
  fixtureEndpoint,
  initializeParams,
  sessionId,
  driverWorkspace,
  sharedOpenCode,
}) {
  const originalProcess = adapterProcessMeta(sharedOpenCode);
  const recoveryPrompt = peer.request("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text: "Use the question tool and leave it pending for recovery coverage.",
      },
    ],
  });
  recoveryPrompt.catch(() => undefined);
  const recoveryOriginal = await withTimeout(
    peer.waitRequest("elicitation/create"),
    "recovery original elicitation/create",
  );
  acpSchema.zCreateElicitationRequest.parse(recoveryOriginal.params);
  validateFormElicitation(recoveryOriginal, sessionId);
  const recoveryOriginalNativeId =
    recoveryOriginal.params._meta.farfoldNativeQuestionId;
  const oldPeer = peer;
  adapter.stdin.destroy();
  adapter.kill("SIGKILL");
  await Promise.race([
    new Promise((resolve) => adapter.once("close", resolve)),
    wait(1_000),
  ]);

  const started = startAdapter(adapterRoot, fixtureEndpoint, sharedOpenCode);
  adapter = started.adapter;
  peer = started.peer;
  const recoveredInitialize = await withTimeout(
    peer.request("initialize", initializeParams),
    "recovery initialize",
  );
  acpSchema.zInitializeResponse.parse(recoveredInitialize);
  peer.notify("initialized", {});
  const loadSessionRequest = {
    sessionId,
    cwd: driverWorkspace,
    mcpServers: [],
  };
  acpSchema.zLoadSessionRequest.parse(loadSessionRequest);
  const loaded = await withTimeout(
    peer.request("session/load", loadSessionRequest),
    "session/load",
  );
  acpSchema.zLoadSessionResponse.parse(loaded);
  const recoveredRequest = await Promise.race([
    peer.waitRequest("elicitation/create", 5_000).then((request) => request),
    wait(5_000).then(() => null),
  ]);

  const providerCountBeforeOldConnectionResponse = fixture.requests.length;
  let oldConnectionWrite = "not_attempted";
  if (recoveredRequest) {
    try {
      oldPeer.respond(recoveredRequest.id, {
        action: "accept",
        content: { choice: "old connection answer" },
      });
      oldConnectionWrite = oldPeer.output.destroyed
        ? "destroyed_stdio_write_attempted"
        : "write_attempted";
    } catch (error) {
      oldConnectionWrite = `write_error:${String(error?.message ?? error)}`;
    }
    await wait(200);
  }
  const providerCountAfterOldConnectionResponse = fixture.requests.length;
  const providerCountBeforeRecoveredResponse = fixture.requests.length;
  let recoveredTerminal = { idle: false };
  if (recoveredRequest) {
    acpSchema.zCreateElicitationRequest.parse(recoveredRequest.params);
    validateFormElicitation(recoveredRequest, sessionId);
    const recoveredAcceptResponse = {
      action: "accept",
      content: { choice: "ACP bridge" },
    };
    acpSchema.zCreateElicitationResponse.parse(recoveredAcceptResponse);
    peer.respond(recoveredRequest.id, recoveredAcceptResponse);
    recoveredTerminal = await waitSessionIdle(
      sharedOpenCode,
      sessionId,
      10_000,
    );
  }
  const recoveredResponseDeadline = Date.now() + 10_000;
  while (
    recoveredRequest &&
    Date.now() < recoveredResponseDeadline &&
    fixture.requests.length === providerCountBeforeRecoveredResponse
  ) {
    await wait(100);
  }
  const providerCountAfterRecoveredResponse = fixture.requests.length;
  const recoveredProviderRequests = fixture.requests.slice(
    providerCountBeforeRecoveredResponse,
  );
  const recoveredProviderSawThisAnswer = recoveredProviderRequests.some(
    (request) => request.sawAcpBridgeAnswer,
  );
  const sameRecoveredNativeQuestion =
    recoveredRequest?.params?._meta?.farfoldNativeQuestionId ===
    recoveryOriginalNativeId;
  const loadedProcess = loaded._meta;
  const adapterRestarted =
    originalProcess?.adapterPid !== loadedProcess?.adapterPid;
  const opencodeServeRestarted =
    originalProcess?.opencodePid !== loadedProcess?.opencodePid ||
    originalProcess?.opencodeBase !== loadedProcess?.opencodeBase;
  const sameOpenCodeService =
    !opencodeServeRestarted &&
    originalProcess?.opencodeWorkspace === loadedProcess?.opencodeWorkspace;
  const recoverySatisfied = Boolean(
    recoveredRequest &&
    adapterRestarted &&
    sameOpenCodeService &&
    loaded.sessionId === sessionId &&
    sameRecoveredNativeQuestion &&
    providerCountAfterOldConnectionResponse -
      providerCountBeforeOldConnectionResponse ===
      0 &&
    recoveredProviderSawThisAnswer &&
    recoveredTerminal.idle,
  );

  return {
    adapter,
    peer,
    recoverySatisfied,
    recovery: {
      status: recoverySatisfied ? "verified" : "failed",
      originalJsonRpcId: recoveryOriginal.id,
      originalNativeRequestId: recoveryOriginalNativeId,
      loadedSessionId: loaded.sessionId,
      recoveredJsonRpcId: recoveredRequest?.id ?? null,
      recoveredNativeRequestId:
        recoveredRequest?.params?._meta?.farfoldNativeQuestionId ?? null,
      sameRecoveredNativeQuestion,
      adapterRestarted,
      opencodeServeRestarted,
      sameOpenCodeService,
      originalProcess,
      loadedProcess,
      oldConnectionResponse: {
        write: oldConnectionWrite,
        providerSideEffect:
          providerCountAfterOldConnectionResponse -
          providerCountBeforeOldConnectionResponse,
        boundary:
          "old stdio was destroyed; this proves no side effect from that closed pipe, not full Host generation isolation",
      },
      recoveredTerminal,
      recoveredProviderSawThisAnswer,
      recoveredAcceptProviderSideEffect:
        providerCountAfterRecoveredResponse -
        providerCountBeforeRecoveredResponse,
      reason: recoveredRequest
        ? "same native Session was loaded after adapter restart and exposed a pending question"
        : "same native Session loaded after adapter restart but did not expose the pending question",
    },
  };
}

async function runDriver() {
  const root = await mkdtemp(
    join(tmpdir(), "farfold-opencode-question-spike-"),
  );
  let fixture;
  let adapter;
  let sharedOpenCode;
  try {
    const digest = await sha256(binary);
    if (digest !== OPENCODE_ACP_SHA256) {
      throw new Error(`unexpected OpenCode binary digest ${digest}`);
    }
    const acpSchema = await loadOfficialAcpSchema();
    fixture = await startFixtureProvider();
    sharedOpenCode = await startOpenCodeServe(
      join(root, "shared-opencode"),
      fixture.endpoint,
    );
    const adapterRoot = join(root, "adapter-root");
    await mkdir(adapterRoot, { recursive: true });
    let started = startAdapter(adapterRoot, fixture.endpoint, sharedOpenCode);
    adapter = started.adapter;
    let peer = started.peer;
    const initializeParams = {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
    };
    acpSchema.zInitializeRequest.parse(initializeParams);
    const initialize = await withTimeout(
      peer.request("initialize", initializeParams),
      "initialize",
    );
    acpSchema.zInitializeResponse.parse(initialize);
    if (
      initialize.protocolVersion !== 1 ||
      initialize.agentCapabilities?.loadSession !== true
    ) {
      throw new Error(
        `invalid initialize response ${JSON.stringify(initialize)}`,
      );
    }
    peer.notify("initialized", {});

    const driverWorkspace = join(root, "driver-workspace");
    const newSessionRequest = {
      cwd: driverWorkspace,
      mcpServers: [],
    };
    acpSchema.zNewSessionRequest.parse(newSessionRequest);
    const created = await withTimeout(
      peer.request("session/new", newSessionRequest),
      "session/new",
    );
    acpSchema.zNewSessionResponse.parse(created);
    const sessionId = created.sessionId;
    if (!sessionId) throw new Error("adapter did not create a session");
    const originalProcess = created._meta;
    if (process.argv.includes("--adapter-incremental")) {
      if (!process.env.FARFOLD_RUST_ADAPTER_BINARY)
        throw new Error("incremental mode requires the Rust adapter");
      const prompt = (text) =>
        peer.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text }],
        });
      const first = await withTimeout(
        prompt("after cancel baseline"),
        "baseline prompt",
      );
      if (first.stopReason !== "end_turn")
        throw new Error("baseline did not complete");
      for (const [configId, value] of [
        ["model", "farfold-spike/spike-model-two"],
        ["mode", "plan"],
        ["effort", "high"],
      ]) {
        const changed = await peer.request("session/set_config_option", {
          sessionId,
          configId,
          value,
        });
        if (
          !changed.configOptions.some(
            (option) => option.id === configId && option.currentValue === value,
          )
        )
          throw new Error(`selection not confirmed: ${configId}`);
      }
      const startedAt = Date.now();
      const second = await withTimeout(
        prompt("after cancel delayed incremental"),
        "delayed prompt",
      );
      const elapsed = Date.now() - startedAt;
      if (second.stopReason !== "end_turn" || elapsed < 800)
        throw new Error("delayed prompt ended before its response");
      if (
        !fixture.requests.some((request) => request.model === "spike-model-two")
      )
        throw new Error("selected model did not reach Provider");
      const userUpdates = peer.serverRequests.filter(
        (event) => event.params?.update?.sessionUpdate === "user_message_chunk",
      );
      if (
        userUpdates.length !== 2 ||
        new Set(userUpdates.map((event) => event.params.update.messageId))
          .size !== 2
      )
        throw new Error("native user messages were duplicated");
      await peer.request("session/set_config_option", {
        sessionId,
        configId: "mode",
        value: "build",
      });
      const questionPrompt = prompt(
        "Use the question tool once, then continue after the answer.",
      );
      questionPrompt.catch(() => undefined);
      const question = await withTimeout(
        peer.waitRequest("elicitation/create"),
        "pending question",
      );
      acpSchema.zCreateElicitationRequest.parse(question.params);
      const oldAdapter = adapter;
      const closed = new Promise((resolve) =>
        oldAdapter.once("close", resolve),
      );
      oldAdapter.stdin.end();
      await withTimeout(closed, "adapter shutdown", 5000);
      started = startAdapter(adapterRoot, fixture.endpoint, sharedOpenCode);
      adapter = started.adapter;
      peer = started.peer;
      await peer.request("initialize", initializeParams);
      const loaded = await withTimeout(
        peer.request("session/load", {
          sessionId,
          cwd: driverWorkspace,
          mcpServers: [],
        }),
        "cold load",
      );
      const recovery = await withTimeout(
        peer.waitRequest("_farfold/session_recovery"),
        "question invalidation",
      );
      if (!recovery.params.unavailableQuestions.length)
        throw new Error("missing unavailable question evidence");
      if (
        !loaded.configOptions.some(
          (option) =>
            option.id === "model" &&
            option.currentValue === "farfold-spike/spike-model-two",
        )
      )
        throw new Error("cold load lost native model selection");
      const next = await withTimeout(
        prompt("after cancel recovered incremental"),
        "recovered next prompt",
      );
      if (next.stopReason !== "end_turn")
        throw new Error("recovered prompt did not complete");
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: "adapter-incremental",
            sessionId,
            elapsed,
            selectedModelReachedProvider: true,
            nativeUserMessageCountBeforeRestart: userUpdates.length,
            unavailableQuestions: recovery.params.unavailableQuestions,
            restoredConfigOptions: loaded.configOptions
              .filter((option) => option.id !== "model")
              .map(({ id, currentValue }) => ({ id, currentValue })),
            recoveredNextPrompt: next.stopReason,
            evidence:
              "fixed OpenCode 1.18.30 and fixture Provider; no installed-app claim",
          },
          null,
          2,
        ),
      );
      return;
    }
    if (process.argv.includes("--recovery-only")) {
      const recoveryOnly = await runRecoveryScenario({
        acpSchema,
        adapter,
        peer,
        adapterRoot,
        fixture,
        fixtureEndpoint: fixture.endpoint,
        initializeParams,
        sessionId,
        driverWorkspace,
        sharedOpenCode,
      });
      adapter = recoveryOnly.adapter;
      peer = recoveryOnly.peer;
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: "recovery-only-real-stdio-json-rpc-driver-to-independent-adapter",
            binary: {
              path: binary,
              name: basename(binary),
              sha256: digest,
            },
            initialize,
            officialSchema: {
              package: `@agentclientprotocol/sdk@${ACP_SDK_VERSION}`,
              sdkDir: process.env.ACP_SDK_DIR,
              validated:
                "InitializeRequest, InitializeResponse, NewSessionRequest, NewSessionResponse, LoadSessionRequest, LoadSessionResponse, CreateElicitationRequest, CreateElicitationResponse, PromptResponse",
            },
            sessionId,
            recovery: recoveryOnly.recovery,
            providerRequestCount: fixture.requests.length,
            overallC3SpikeSatisfied: recoveryOnly.recoverySatisfied,
          },
          null,
          2,
        ),
      );
      return;
    }

    const questionPrompt = peer.request("session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "Use the question tool once, then continue after the answer.",
        },
      ],
    });
    const elicitation = await withTimeout(
      peer.waitRequest("elicitation/create"),
      "elicitation/create",
    );
    acpSchema.zCreateElicitationRequest.parse(elicitation.params);
    validateFormElicitation(elicitation, sessionId);
    const acceptedElicitationResponse = {
      action: "accept",
      content: { choice: "ACP bridge" },
    };
    acpSchema.zCreateElicitationResponse.parse(acceptedElicitationResponse);
    peer.respond(elicitation.id, acceptedElicitationResponse);
    const questionResult = await withTimeout(questionPrompt, "question prompt");
    acpSchema.zPromptResponse.parse(questionResult);
    if (questionResult.stopReason !== "end_turn") {
      throw new Error(
        `question prompt did not close: ${questionResult.status}`,
      );
    }

    const rejectPrompt = peer.request("session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "Use the question tool for reject coverage." },
      ],
    });
    const rejectedElicitation = await withTimeout(
      peer.waitRequest("elicitation/create"),
      "reject elicitation/create",
    );
    acpSchema.zCreateElicitationRequest.parse(rejectedElicitation.params);
    validateFormElicitation(rejectedElicitation, sessionId);
    const declinedElicitationResponse = { action: "decline" };
    acpSchema.zCreateElicitationResponse.parse(declinedElicitationResponse);
    peer.respond(rejectedElicitation.id, declinedElicitationResponse);
    const rejectResult = await withTimeout(rejectPrompt, "reject prompt");
    acpSchema.zPromptResponse.parse(rejectResult);
    if (rejectResult.stopReason !== "end_turn") {
      throw new Error(`reject prompt did not close: ${rejectResult.status}`);
    }

    const cancelQuestionPrompt = peer.request("session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "Use the question tool for cancel coverage." },
      ],
    });
    const cancelledElicitation = await withTimeout(
      peer.waitRequest("elicitation/create"),
      "cancel elicitation/create",
    );
    acpSchema.zCreateElicitationRequest.parse(cancelledElicitation.params);
    validateFormElicitation(cancelledElicitation, sessionId);
    const cancelledElicitationResponse = { action: "cancel" };
    acpSchema.zCreateElicitationResponse.parse(cancelledElicitationResponse);
    peer.respond(cancelledElicitation.id, cancelledElicitationResponse);
    const cancelQuestionResult = await withTimeout(
      cancelQuestionPrompt,
      "cancel question prompt",
    );
    acpSchema.zPromptResponse.parse(cancelQuestionResult);
    if (cancelQuestionResult.stopReason !== "end_turn") {
      throw new Error(
        `cancel question prompt did not close: ${cancelQuestionResult.status}`,
      );
    }

    const comboPrompt = peer.request("session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "combo same prompt: ask a question first, then use bash once.",
        },
      ],
    });
    const comboElicitation = await withTimeout(
      peer.waitRequest("elicitation/create"),
      "combo elicitation/create",
    );
    acpSchema.zCreateElicitationRequest.parse(comboElicitation.params);
    validateFormElicitation(comboElicitation, sessionId);
    peer.respond(comboElicitation.id, acceptedElicitationResponse);
    const comboSecondElicitation = await withTimeout(
      peer.waitRequest("elicitation/create"),
      "combo second elicitation/create",
    );
    acpSchema.zCreateElicitationRequest.parse(comboSecondElicitation.params);
    validateFormElicitation(comboSecondElicitation, sessionId);
    if (comboSecondElicitation.id === comboElicitation.id) {
      throw new Error("combo question request IDs were reused");
    }
    peer.respond(comboSecondElicitation.id, acceptedElicitationResponse);
    const comboResult = await withTimeout(comboPrompt, "combo prompt");
    acpSchema.zPromptResponse.parse(comboResult);
    if (comboResult.stopReason !== "end_turn") {
      throw new Error(`combo prompt did not close: ${comboResult.stopReason}`);
    }

    const permissionPrompt = peer.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "permission probe: use bash once." }],
    });
    const permission = await withTimeout(
      peer.waitRequest("session/request_permission"),
      "session/request_permission",
    );
    acpSchema.zRequestPermissionRequest.parse(permission.params);
    if (permission.params.sessionId !== sessionId) {
      throw new Error("permission request used a different session");
    }
    if (permission.id === elicitation.id) {
      throw new Error("permission and elicitation request IDs were mixed");
    }
    const permissionResponse = { outcome: { outcome: "cancelled" } };
    acpSchema.zRequestPermissionResponse.parse(permissionResponse);
    peer.respond(permission.id, permissionResponse);
    peer.notify("session/cancel", { sessionId });
    const permissionResult = await withTimeout(
      permissionPrompt,
      "permission prompt",
    );
    acpSchema.zPromptResponse.parse(permissionResult);
    if (permissionResult.stopReason !== "cancelled") {
      throw new Error(
        `permission prompt did not close: ${permissionResult.status}`,
      );
    }

    const nextPrompt = await withTimeout(
      peer.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "after cancel, answer normally." }],
      }),
      "next prompt",
    );
    acpSchema.zPromptResponse.parse(nextPrompt);
    if (nextPrompt.stopReason !== "end_turn") {
      throw new Error(`next turn was not usable: ${nextPrompt.stopReason}`);
    }
    const nextTurnDeadline = Date.now() + 10_000;
    while (
      Date.now() < nextTurnDeadline &&
      !fixture.requests.some((request) => request.sawAfterCancelPrompt)
    ) {
      await wait(100);
    }
    const providerSawNextTurn = fixture.requests.some(
      (request) => request.sawAfterCancelPrompt,
    );

    const providerCountBeforeLateResponse = fixture.requests.length;
    peer.respond(elicitation.id, {
      action: "accept",
      content: { choice: "late answer" },
    });
    await wait(200);
    const providerCountAfterLateResponse = fixture.requests.length;

    if (process.env.FARFOLD_RUST_ADAPTER_BINARY) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            adapter: "rust",
            binaryDigest: digest,
            sessionId,
            elicitation: {
              jsonRpcId: elicitation.id,
              nativeRequestId: elicitation.params._meta.farfoldNativeQuestionId,
              method: elicitation.method,
            },
            rejectedElicitation: {
              jsonRpcId: rejectedElicitation.id,
              nativeRequestId:
                rejectedElicitation.params._meta.farfoldNativeQuestionId,
              method: rejectedElicitation.method,
            },
            cancelledElicitation: {
              jsonRpcId: cancelledElicitation.id,
              nativeRequestId:
                cancelledElicitation.params._meta.farfoldNativeQuestionId,
              method: cancelledElicitation.method,
            },
            permission: {
              jsonRpcId: permission.id,
              nativeRequestId: permission.params.requestId,
              method: permission.method,
            },
            combo: {
              elicitation: {
                jsonRpcId: comboElicitation.id,
                nativeRequestId:
                  comboElicitation.params._meta.farfoldNativeQuestionId,
              },
              secondElicitation: {
                jsonRpcId: comboSecondElicitation.id,
                nativeRequestId:
                  comboSecondElicitation.params._meta.farfoldNativeQuestionId,
              },
              prompt: comboResult,
              questionThenPermissionStatus:
                "blocked: OpenCode did not expose /permission after a question-triggered bash tool call in this fixture",
            },
            promptResponses: {
              accept: questionResult,
              decline: rejectResult,
              cancel: cancelQuestionResult,
              combo: comboResult,
              permissionCancel: permissionResult,
              nextAfterPermissionCancel: nextPrompt,
            },
            sameNativeSessionCovered:
              permission.params.sessionId === sessionId &&
              comboSecondElicitation.params.sessionId === sessionId &&
              comboElicitation.params.sessionId === sessionId &&
              elicitation.params.sessionId === sessionId &&
              rejectedElicitation.params.sessionId === sessionId &&
              cancelledElicitation.params.sessionId === sessionId,
            lateElicitationResponse: {
              ignoredWithoutAdapterExit: adapter.exitCode === null,
              providerSideEffect:
                providerCountAfterLateResponse -
                providerCountBeforeLateResponse,
            },
            nextAfterPermissionCancel: {
              status: providerSawNextTurn ? "verified" : "failed",
              providerReached: providerSawNextTurn,
            },
            recovery: {
              status: "skipped",
              reason:
                "Rust adapter currently owns its OpenCode serve child; adapter-restart pending question recovery is not implemented in this driver",
            },
            providerRequestCount: fixture.requests.length,
            providerSawQuestionAnswer: fixture.requests.some(
              (request) => request.sawQuestionResult,
            ),
            providerSawPermissionPrompt: fixture.requests.some(
              (request) => request.sawPermissionPrompt,
            ),
            providerSawComboPrompt: fixture.requests.some(
              (request) => request.sawComboPrompt,
            ),
            providerSawNextTurn: fixture.requests.some(
              (request) => request.sawAfterCancelPrompt,
            ),
            overallRustAdapterMainFlowSatisfied: Boolean(
              providerSawNextTurn &&
              fixture.requests.some((request) => request.sawComboPrompt) &&
              providerCountAfterLateResponse ===
                providerCountBeforeLateResponse,
            ),
          },
          null,
          2,
        ),
      );
      return;
    }

    const recoveryPrompt = peer.request("session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "Use the question tool and leave it pending for recovery coverage.",
        },
      ],
    });
    recoveryPrompt.catch(() => undefined);
    const recoveryOriginal = await withTimeout(
      peer.waitRequest("elicitation/create"),
      "recovery original elicitation/create",
    );
    validateFormElicitation(recoveryOriginal, sessionId);
    const recoveryOriginalNativeId =
      recoveryOriginal.params._meta.farfoldNativeQuestionId;
    const oldPeer = peer;
    adapter.stdin.destroy();
    adapter.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => adapter.once("close", resolve)),
      wait(1_000),
    ]);
    started = startAdapter(adapterRoot, fixture.endpoint, sharedOpenCode);
    adapter = started.adapter;
    peer = started.peer;
    const recoveredInitialize = await withTimeout(
      peer.request("initialize", initializeParams),
      "recovery initialize",
    );
    acpSchema.zInitializeResponse.parse(recoveredInitialize);
    peer.notify("initialized", {});
    const loadSessionRequest = {
      sessionId,
      cwd: driverWorkspace,
      mcpServers: [],
    };
    acpSchema.zLoadSessionRequest.parse(loadSessionRequest);
    const loaded = await withTimeout(
      peer.request("session/load", loadSessionRequest),
      "session/load",
    );
    acpSchema.zLoadSessionResponse.parse(loaded);
    const recoveredRequest = await Promise.race([
      peer.waitRequest("elicitation/create", 5_000).then((request) => request),
      wait(5_000).then(() => null),
    ]);
    const providerCountBeforeOldConnectionResponse = fixture.requests.length;
    let oldConnectionWrite = "not_attempted";
    if (recoveredRequest) {
      try {
        oldPeer.respond(recoveredRequest.id, {
          action: "accept",
          content: { choice: "old connection answer" },
        });
        oldConnectionWrite = oldPeer.output.destroyed
          ? "destroyed_stdio_write_attempted"
          : "write_attempted";
      } catch (error) {
        oldConnectionWrite = `write_error:${String(error?.message ?? error)}`;
      }
      await wait(200);
    }
    const providerCountAfterOldConnectionResponse = fixture.requests.length;
    const providerCountBeforeRecoveredResponse = fixture.requests.length;
    let recoveredTerminal = { idle: false };
    if (recoveredRequest) {
      acpSchema.zCreateElicitationRequest.parse(recoveredRequest.params);
      validateFormElicitation(recoveredRequest, sessionId);
      const recoveredAcceptResponse = {
        action: "accept",
        content: { choice: "ACP bridge" },
      };
      acpSchema.zCreateElicitationResponse.parse(recoveredAcceptResponse);
      peer.respond(recoveredRequest.id, recoveredAcceptResponse);
      recoveredTerminal = await waitSessionIdle(
        sharedOpenCode,
        sessionId,
        10_000,
      );
    }
    const recoveredResponseDeadline = Date.now() + 10_000;
    while (
      recoveredRequest &&
      Date.now() < recoveredResponseDeadline &&
      fixture.requests.length === providerCountBeforeRecoveredResponse
    ) {
      await wait(100);
    }
    const providerCountAfterRecoveredResponse = fixture.requests.length;
    const recoveredProviderRequests = fixture.requests.slice(
      providerCountBeforeRecoveredResponse,
    );
    const recoveredProviderSawThisAnswer = recoveredProviderRequests.some(
      (request) => request.sawAcpBridgeAnswer,
    );
    const sameRecoveredNativeQuestion =
      recoveredRequest?.params?._meta?.farfoldNativeQuestionId ===
      recoveryOriginalNativeId;
    const adapterRestarted =
      originalProcess?.adapterPid !== loaded._meta?.adapterPid;
    const opencodeServeRestarted =
      originalProcess?.opencodePid !== loaded._meta?.opencodePid ||
      originalProcess?.opencodeBase !== loaded._meta?.opencodeBase;
    const sameOpenCodeService =
      !opencodeServeRestarted &&
      originalProcess?.opencodeWorkspace === loaded._meta?.opencodeWorkspace;
    const recoverySatisfied = Boolean(
      recoveredRequest &&
      adapterRestarted &&
      sameOpenCodeService &&
      loaded.sessionId === sessionId &&
      sameRecoveredNativeQuestion &&
      providerCountAfterOldConnectionResponse -
        providerCountBeforeOldConnectionResponse ===
        0 &&
      recoveredProviderSawThisAnswer &&
      recoveredTerminal.idle,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "real-stdio-json-rpc-driver-to-independent-adapter",
          binary: {
            path: binary,
            name: basename(binary),
            sha256: digest,
          },
          initialize,
          officialSchema: {
            package: `@agentclientprotocol/sdk@${ACP_SDK_VERSION}`,
            sdkDir: process.env.ACP_SDK_DIR,
            validated:
              "InitializeRequest, InitializeResponse, NewSessionRequest, NewSessionResponse, LoadSessionRequest, LoadSessionResponse, CreateElicitationRequest, CreateElicitationResponse, RequestPermissionRequest, RequestPermissionResponse, PromptResponse",
          },
          sessionId,
          elicitation: {
            jsonRpcId: elicitation.id,
            nativeRequestId: elicitation.params._meta.farfoldNativeQuestionId,
            method: elicitation.method,
          },
          rejectedElicitation: {
            jsonRpcId: rejectedElicitation.id,
            nativeRequestId:
              rejectedElicitation.params._meta.farfoldNativeQuestionId,
            method: rejectedElicitation.method,
          },
          cancelledElicitation: {
            jsonRpcId: cancelledElicitation.id,
            nativeRequestId:
              cancelledElicitation.params._meta.farfoldNativeQuestionId,
            method: cancelledElicitation.method,
          },
          permission: {
            jsonRpcId: permission.id,
            nativeRequestId: permission.params.requestId,
            method: permission.method,
          },
          promptResponses: {
            accept: questionResult,
            decline: rejectResult,
            cancel: cancelQuestionResult,
            permissionCancel: permissionResult,
            nextAfterPermissionCancel: nextPrompt,
          },
          sameNativeSessionCovered:
            permission.params.sessionId === sessionId &&
            elicitation.params.sessionId === sessionId &&
            rejectedElicitation.params.sessionId === sessionId &&
            cancelledElicitation.params.sessionId === sessionId,
          lateElicitationResponse: {
            ignoredWithoutAdapterExit: adapter.exitCode === null,
            providerSideEffect:
              providerCountAfterLateResponse - providerCountBeforeLateResponse,
          },
          nextAfterPermissionCancel: {
            status: providerSawNextTurn ? "verified" : "failed",
            providerReached: providerSawNextTurn,
          },
          recovery: {
            status: recoverySatisfied ? "verified" : "failed",
            originalJsonRpcId: recoveryOriginal.id,
            originalNativeRequestId: recoveryOriginalNativeId,
            loadedSessionId: loaded.sessionId,
            recoveredJsonRpcId: recoveredRequest?.id ?? null,
            recoveredNativeRequestId:
              recoveredRequest?.params?._meta?.farfoldNativeQuestionId ?? null,
            sameRecoveredNativeQuestion,
            adapterRestarted,
            opencodeServeRestarted,
            sameOpenCodeService,
            originalProcess,
            loadedProcess: loaded._meta,
            oldConnectionResponse: {
              write: oldConnectionWrite,
              providerSideEffect:
                providerCountAfterOldConnectionResponse -
                providerCountBeforeOldConnectionResponse,
              boundary:
                "old stdio was destroyed; this proves no side effect from that closed pipe, not full Host generation isolation",
            },
            recoveredTerminal,
            recoveredProviderSawThisAnswer,
            recoveredAcceptProviderSideEffect:
              providerCountAfterRecoveredResponse -
              providerCountBeforeRecoveredResponse,
            reason: recoveredRequest
              ? "same native Session was loaded after adapter restart and exposed a pending question"
              : "same native Session loaded after adapter restart but did not expose the pending question",
          },
          providerRequestCount: fixture.requests.length,
          providerSawQuestionAnswer: fixture.requests.some(
            (request) => request.sawQuestionResult,
          ),
          providerSawPermissionPrompt: fixture.requests.some(
            (request) => request.sawPermissionPrompt,
          ),
          providerSawNextTurn: fixture.requests.some(
            (request) => request.sawAfterCancelPrompt,
          ),
          overallC3SpikeSatisfied: Boolean(
            providerSawNextTurn && recoverySatisfied,
          ),
        },
        null,
        2,
      ),
    );
  } finally {
    if (adapter && adapter.exitCode === null) {
      adapter.stdin.end();
      await Promise.race([
        new Promise((resolve) => adapter.once("close", resolve)),
        wait(3_000),
      ]);
      if (adapter.exitCode === null) adapter.kill("SIGKILL");
    }
    if (sharedOpenCode?.child && sharedOpenCode.child.exitCode === null) {
      if (sharedOpenCode.eventStop) sharedOpenCode.eventStop.stopped = true;
      sharedOpenCode.child.kill("SIGKILL");
      await Promise.race([
        new Promise((resolve) => sharedOpenCode.child.once("close", resolve)),
        wait(1_000),
      ]);
    }
    if (fixture) await fixture.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

function startAdapter(adapterRoot, fixtureEndpoint, opencode) {
  const rustAdapter = process.env.FARFOLD_RUST_ADAPTER_BINARY;
  if (rustAdapter) {
    const adapter = spawn(
      rustAdapter,
      ["--farfold-opencode-question-acp-adapter-v1"],
      {
        env: {
          ...process.env,
          HOME: join(adapterRoot, "home"),
          OPENCODE_CONFIG_DIR: join(adapterRoot, "config"),
          XDG_CONFIG_HOME: join(adapterRoot, "xdg-config"),
          XDG_DATA_HOME: join(adapterRoot, "xdg-data"),
          XDG_CACHE_HOME: join(adapterRoot, "xdg-cache"),
          XDG_STATE_HOME: join(adapterRoot, "xdg-state"),
          FARFOLD_OPENCODE_BINARY: binary,
          FARFOLD_OPENCODE_CWD: opencode?.workspace ?? adapterRoot,
          FARFOLD_OPENCODE_FIXTURE_PROVIDER_ENDPOINT: fixtureEndpoint,
        },
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    return {
      adapter,
      peer: new DriverPeer(adapter.stdout, adapter.stdin),
    };
  }
  const adapter = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--adapter"],
    {
      env: {
        ...process.env,
        FARFOLD_SPIKE_ADAPTER_ROOT: adapterRoot,
        FARFOLD_SPIKE_PROVIDER_ENDPOINT: fixtureEndpoint,
        ...(opencode
          ? {
              FARFOLD_SPIKE_OPENCODE_BASE: opencode.base,
              FARFOLD_SPIKE_OPENCODE_WORKSPACE: opencode.workspace,
              FARFOLD_SPIKE_OPENCODE_PID: String(opencode.child.pid),
            }
          : {}),
      },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  return {
    adapter,
    peer: new DriverPeer(adapter.stdout, adapter.stdin),
  };
}

if (process.argv[2] === "--adapter") {
  await runAdapter();
} else {
  await runDriver();
}
