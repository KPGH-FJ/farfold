import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { stream } from "../src-tauri/capability-bridge/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";

const allowedZhipuRoles = new Set(["system", "user", "assistant", "tool"]);
const servers = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

function model(baseUrl, supportsDeveloperRole) {
  return {
    id: "glm-4.6v",
    name: "GLM-4.6V",
    api: "openai-completions",
    provider: "zai",
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    compat: {
      supportsDeveloperRole,
      supportsReasoningEffort: false,
      thinkingFormat: "zai",
      maxTokensField: "max_tokens",
      zaiToolStream: false,
    },
  };
}

function user(text, timestamp = Date.now()) {
  return { role: "user", content: text, timestamp };
}

async function strictZhipuServer() {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const roles = body.messages.map((message) => message.role);
      requests.push({ path: request.url, roles, body });
      if (roles.some((role) => !allowedZhipuRoles.has(role))) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { code: "1214", message: "角色信息不正确" },
          }),
        );
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
      });
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-zhipu-role-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "glm-4.6v",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "ok" },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-zhipu-role-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "glm-4.6v",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture did not bind TCP");
  return { requests, baseUrl: `http://127.0.0.1:${address.port}/api/paas/v4` };
}

async function run(baseUrl, supportsDeveloperRole, messages) {
  return stream(
    model(baseUrl, supportsDeveloperRole),
    { systemPrompt: "Farfold system fixture", messages },
    { apiKey: "fixture-only", maxRetries: 0, timeoutMs: 2_000 },
  ).result();
}

describe("fixed Pi 0.84.3 ordinary Zhipu role compatibility", () => {
  it("pins the exact Pi SDK and reproduces strict rejection for developer role", async () => {
    const packageJson = JSON.parse(
      await readFile(
        new URL(
          "../src-tauri/capability-bridge/node_modules/@earendil-works/pi-ai/package.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(packageJson.version).toBe("0.84.3");
    const fixture = await strictZhipuServer();
    const result = await run(fixture.baseUrl, true, [user("hello")]);
    expect(result.stopReason).toBe("error");
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].path).toBe("/api/paas/v4/chat/completions");
    expect(fixture.requests[0].roles).toEqual(["developer", "user"]);
  });

  it("sends exactly system and user when developer compatibility is disabled", async () => {
    const fixture = await strictZhipuServer();
    const result = await run(fixture.baseUrl, false, [user("hello")]);
    expect(result.stopReason).toBe("stop");
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].roles).toEqual(["system", "user"]);
    expect(fixture.requests[0].roles).not.toContain("developer");
  });

  it("keeps assistant and tool-result history inside the official Zhipu role set", async () => {
    const fixture = await strictZhipuServer();
    const timestamp = Date.now();
    const result = await run(fixture.baseUrl, false, [
      user("look it up", timestamp),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_fixture",
            name: "lookup",
            arguments: { q: "x" },
          },
        ],
        api: "openai-completions",
        provider: "zai",
        model: "glm-4.6v",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: timestamp + 1,
      },
      {
        role: "toolResult",
        toolCallId: "call_fixture",
        toolName: "lookup",
        content: [{ type: "text", text: "fixture result" }],
        isError: false,
        timestamp: timestamp + 2,
      },
      user("continue", timestamp + 3),
    ]);
    expect(result.stopReason).toBe("stop");
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].roles).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(
      fixture.requests[0].roles.every((role) => allowedZhipuRoles.has(role)),
    ).toBe(true);
  });
});
