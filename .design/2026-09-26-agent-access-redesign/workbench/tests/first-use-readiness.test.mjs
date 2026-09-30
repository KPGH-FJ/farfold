import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { AGENT_CATALOG, catalogState } from "../src/agent-catalog.js";
import { firstUseAgents } from "../src/scene-state.js";
import { agentCanAttempt, normalizeAgent } from "../src/agent-setup-state.js";
import {
  advanceAgentJobs,
  programAction,
  startAgentJob,
} from "../src/access-jobs.js";
import { canAttempt } from "../src/workbench-state.js";

let server, Hub, NewConversation;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  Hub = (await server.ssrLoadModule("/src/AgentHub.jsx")).default;
  NewConversation = (await server.ssrLoadModule("/src/NewConversationV2.jsx"))
    .default;
});
after(async () => {
  await server?.close();
});

test("first-use directory and draft admission agree for every discovered program", () => {
  const agents = firstUseAgents();
  for (const catalog of AGENT_CATALOG) {
    const agent = normalizeAgent(catalogState(catalog, agents));
    assert.equal(agentCanAttempt(agent), false, catalog.id);
    assert.equal(canAttempt(agent), false, catalog.id);
  }
  const html = renderToStaticMarkup(React.createElement(Hub, { agents }));
  assert.equal((html.match(/>开始新对话</g) || []).length, 0);
  assert.equal((html.match(/>准备使用</g) || []).length, AGENT_CATALOG.length);
});

test("a discovered Agent cannot enable draft sending before addition and connection", () => {
  const agents = firstUseAgents();
  const html = renderToStaticMarkup(
    React.createElement(NewConversation, {
      draft: "保留首次使用的草稿",
      files: [],
      services: [],
      agents,
      choice: { agentId: "codex", agent: "Codex", accessMode: "existing" },
    }),
  );
  assert.ok(html.includes("继续设置"));
  assert.ok(html.includes('aria-label="继续设置 Agent"'));
  assert.ok(!html.includes('aria-label="发送新对话"'));
});

test("local discovery, adding, connecting and a usable connection remain distinct for every local Agent", () => {
  for (const discovered of firstUseAgents()
    .map(normalizeAgent)
    .filter((agent) => agent.installations.length)) {
    assert.equal(canAttempt(discovered), false, discovered.id);
    const added = programAction(discovered, "register");
    assert.equal(added.added, true);
    assert.equal(canAttempt(added), false, discovered.id);
    let connecting = startAgentJob(added, "connect", {}, 0);
    assert.equal(canAttempt(connecting), false, discovered.id);
    for (let now = 1000; now <= 6000; now += 1000)
      connecting = advanceAgentJobs([connecting], now)[0];
    assert.equal(connecting.connected, true);
    assert.equal(connecting.authentication, undefined);
    assert.equal(connecting.setupComplete, false);
    assert.equal(canAttempt(connecting), true, discovered.id);
    assert.equal(
      canAttempt(programAction(connecting, "disconnect")),
      false,
      discovered.id,
    );
  }
});

test("connected catalogue samples and custom Agents need no account claim or mandatory short test", () => {
  const samples = AGENT_CATALOG.filter((agent) => agent.connected);
  samples.push({ ...samples[0], id: "custom", name: "自定义 Agent" });
  for (const agent of samples) {
    assert.equal(canAttempt(agent), true, agent.id);
    for (const change of [
      { registered: false },
      { connected: false },
      { removed: true },
      { dependenciesMissing: true },
      { connectionState: "idle" },
      { connectionState: "connecting" },
      { connectionState: "failed" },
      { connectionState: "unknown" },
    ])
      assert.equal(
        canAttempt({ ...agent, ...change }),
        false,
        JSON.stringify(change),
      );
  }
});
