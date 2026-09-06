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

async function fixture() {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const command = JSON.parse(body);
    calls.push(command.model);
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
  cleanup.push(() => new Promise((done) => server.close(done)));
  const directory = await mkdtemp(join(tmpdir(), "farfold-probe-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "models.json"),
    JSON.stringify({
      providers: {
        "probe-fixture": {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
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
  async function probe(modelId) {
    const child = spawn(
      resolve("src-tauri/capability-bridge/runtime/node"),
      [resolve("src-tauri/capability-bridge/bridge.mjs")],
      { env: { ...process.env, FARFOLD_PI_AGENT_DIR: directory } },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.resume();
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdin.end(
      JSON.stringify({
        id: "probe",
        type: "test_connection",
        providerId: "probe-fixture",
        modelId,
      }) + "\n",
    );
    await new Promise((done, fail) => {
      child.on("error", fail);
      child.on("close", done);
    }).finally(() => clearTimeout(timer));
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((event) => event.id === "probe");
  }
  return { calls, probe };
}

describe("Pi connection probe through the native SDK", () => {
  it("requests the chosen model even when a cheaper model rejects this account", async () => {
    const { calls, probe } = await fixture();
    const result = await probe("chosen");
    expect(result?.success).toBe(true);
    expect(result.data.model.id).toBe("chosen");
    expect(calls).toEqual(["chosen"]);
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
});
