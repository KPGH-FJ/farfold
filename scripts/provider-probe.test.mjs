import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// Test-only JSONL reader: stdout chunks are not message boundaries.
class BridgeEventLines {
  remainder = "";
  parsed = [];
  failure = null;
  push(chunk) {
    if (this.failure) return;
    this.remainder += chunk;
    let newline;
    while ((newline = this.remainder.indexOf("\n")) !== -1) {
      const line = this.remainder.slice(0, newline);
      this.remainder = this.remainder.slice(newline + 1);
      if (!line) continue;
      try {
        this.parsed.push(JSON.parse(line));
      } catch (error) {
        // Keep the first error for the test's read/close boundary, not an
        // uncaught EventEmitter callback; it must never become a skipped frame.
        this.failure = error;
        return;
      }
    }
  }
  events() {
    if (this.failure) throw this.failure;
    return this.parsed;
  }
  finish() {
    this.events();
    if (this.remainder.length !== 0) {
      throw new Error("Pi SDK bridge closed with an incomplete JSONL frame");
    }
    return this.parsed;
  }
}

describe("Pi probe fixture JSONL framing", () => {
  it("retains a large catalog tail until its terminating newline", () => {
    const reader = new BridgeEventLines();
    const catalog = {
      id: "large-catalog",
      models: Array.from({ length: 12000 }, (_, index) => ({
        id: `model-${index}`,
        name: "synthetic catalog entry",
      })),
    };
    const json = JSON.stringify(catalog);
    expect(json.length).toBeGreaterThan(458752);
    for (let start = 0; start < json.length; start += 65536) {
      reader.push(json.slice(start, start + 65536));
      expect(reader.events()).toEqual([]);
    }
    reader.push("\n");
    expect(reader.events()).toEqual([catalog]);
    expect(reader.finish()).toEqual([catalog]);
  });
  it("keeps complete messages while retaining the next chunk's remainder", () => {
    const reader = new BridgeEventLines();
    reader.push('{"id":"first"}\n{"id":');
    expect(reader.events()).toEqual([{ id: "first" }]);
    reader.push('"second"}\n\n');
    expect(reader.finish()).toEqual([{ id: "first" }, { id: "second" }]);
  });
  it("fails on every nonempty EOF remainder, even valid JSON without newline", () => {
    for (const tail of ['{"id":', '{"id":"complete-but-unframed"}', " "]) {
      const reader = new BridgeEventLines();
      reader.push(tail);
      expect(reader.events()).toEqual([]);
      expect(() => reader.finish()).toThrow("incomplete JSONL frame");
    }
  });
  it("preserves malformed complete-frame failure at read and process close", () => {
    const reader = new BridgeEventLines();
    reader.push('{"id":}\n');
    expect(() => reader.events()).toThrow(SyntaxError);
    reader.push('{"id":"later-valid"}\n');
    expect(() => reader.finish()).toThrow(SyntaxError);
  });
});

async function fixture() {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const command = JSON.parse(body);
    calls.push({
      model: command.model,
      authorization: request.headers.authorization,
    });
    if (command.model !== "chosen") {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Model access denied" } }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", model: "chosen", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  cleanup.push(() => new Promise((done) => server.close(done)));
  const directory = await mkdtemp(join(tmpdir(), "farfold-probe-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "models.json"),
    JSON.stringify({
      providers: {
        "probe-fixture": {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "local-fixture-placeholder",
          models: [
            {
              id: "cheap-denied",
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
            {
              id: "chosen",
              cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  async function withBridge(run) {
    const child = spawn(
      resolve("src-tauri/capability-bridge/runtime/node"),
      [resolve("src-tauri/capability-bridge/bridge.mjs")],
      { env: { ...process.env, FARFOLD_PI_AGENT_DIR: directory } },
    );
    const reader = new BridgeEventLines();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => reader.push(chunk));
    child.stderr.resume();
    try {
      return await run(child, () => reader.events());
    } finally {
      child.kill();
      await new Promise((done) => child.on("close", done));
      reader.finish();
    }
  }

  async function sendBridgeCommand(child, events, command) {
    child.stdin.write(`${JSON.stringify(command)}\n`);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const event = events().find((entry) => entry.id === command.id);
      if (event) return event;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error(`Pi SDK bridge did not answer ${command.type}.`);
  }

  async function probe(modelId) {
    let timedOut = false;
    const startedAt = Date.now();
    return withBridge(async (child, events) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 10_000);
      try {
        const result = await sendBridgeCommand(child, events, {
          id: "probe",
          type: "test_connection",
          providerId: "probe-fixture",
          modelId,
        });
        if (!result)
          throw new Error("Pi SDK exited without a correlated probe response.");
        return result;
      } finally {
        clearTimeout(timer);
        if (timedOut) {
          throw new Error(
            `Pi SDK probe exceeded 10000ms before process exit (${Date.now() - startedAt}ms elapsed).`,
          );
        }
      }
    });
  }
  return { calls, port, probe, withBridge, sendBridgeCommand };
}

describe("Pi connection probe through the native SDK", () => {
  it("requests the chosen model even when a cheaper model rejects this account", async () => {
    const { calls, probe } = await fixture();
    const result = await probe("chosen");
    expect(result?.success).toBe(true);
    expect(result.data.model.id).toBe("chosen");
    expect(result.data.dispatches[0]).toMatchObject({
      url: {
        protocol: "http",
        path: "/v1/chat/completions",
        hasQuery: false,
        hasUserInfo: false,
      },
      method: "POST",
      hasAuthorization: true,
      body: {
        model: "chosen",
        messageCount: 2,
        messageRoles: ["system", "user"],
        hasPrompt: false,
      },
    });
    expect(result.data.dispatches[0]).not.toHaveProperty("messages");
    expect(result.data.dispatches[0]).not.toHaveProperty("input");
    expect(result.data.dispatches[0]).not.toHaveProperty("prompt");
    expect(JSON.stringify(result.data.dispatches)).not.toContain("Reply OK");
    expect(calls.map((call) => call.model)).toEqual(["chosen"]);
  }, 15_000);

  it.each([undefined, "missing"])(
    "rejects unspecified or unavailable model %s before sending a request",
    async (modelId) => {
      const { calls, probe } = await fixture();
      expect((await probe(modelId))?.success).toBe(false);
      expect(calls).toEqual([]);
    },
    15_000,
  );

  it("reuses a managed saved connection through bridge upsert, login, and probe", async () => {
    const { calls, port, withBridge, sendBridgeCommand } = await fixture();
    await withBridge(async (child, events) => {
      const upsert = await sendBridgeCommand(child, events, {
        id: "upsert-managed",
        type: "upsert_custom_provider",
        providerId: "managed-provider-fixture",
        providerName: "Managed Fixture",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        modelId: "chosen",
        modelName: "chosen",
        contextWindow: 200000,
        maxTokens: 16000,
        reasoning: false,
        imageInput: false,
        localKeyless: false,
        supportsDeveloperRole: true,
        supportsReasoningEffort: false,
        projectPath: null,
      });
      expect(upsert.success).toBe(true);
      const login = await sendBridgeCommand(child, events, {
        id: "login-managed",
        type: "login_api_key",
        providerId: "managed-provider-fixture",
        apiKey: "sk-managed-fixture",
      });
      expect(login.success).toBe(true);
      const probe = await sendBridgeCommand(child, events, {
        id: "probe-managed",
        type: "test_connection",
        providerId: "managed-provider-fixture",
        modelId: "chosen",
      });
      expect(probe.success).toBe(true);
    });
    expect(calls).toContainEqual({
      model: "chosen",
      authorization: "Bearer sk-managed-fixture",
    });
  }, 15_000);
});
