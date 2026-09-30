import assert from "node:assert/strict";
import test from "node:test";
import {
  firstUseAgents,
  firstUseState,
  exampleState,
} from "../src/scene-state.js";
import {
  makePrototypeSnapshot,
  restorePrototypeSnapshot,
} from "../src/prototype-persistence.js";
import { AGENT_CATALOG, catalogState } from "../src/agent-catalog.js";
import { normalizeAgent } from "../src/agent-setup-state.js";
import { TASKS_V2 } from "../src/data-v2.js";

const firstUse = () => ({
  tasks: [],
  services: [],
  groups: [],
  agents: firstUseAgents(),
});

test("fresh opening and reset share an empty baseline, including after a restart", () => {
  const state = firstUseState();
  const restored = restorePrototypeSnapshot(makePrototypeSnapshot(state));
  for (const value of [state, restored]) {
    assert.equal(value.scene, "first");
    assert.equal(value.view, "new");
    assert.equal(value.active, null);
    assert.equal(value.tasks.length, 0);
    assert.equal(value.services.length, 0);
    assert.equal(value.groups.length, 0);
    assert.equal(
      value.agents.filter((agent) => agent.added || agent.connected).length,
      0,
    );
    assert.equal(value.draft.text, "");
    assert.equal(value.draft.choice.agent, "");
    assert.deepEqual(value.authBlocks, {});
    assert.deepEqual(value.workPolicies, {});
  }
  state.agents[0].connected = true;
  state.draft.text = "上一次演示";
  assert.equal(firstUseState().agents[0].connected, false);
  assert.equal(firstUseState().draft.text, "");
});

test("restart retains the selected scene without reloading its fixtures", () => {
  const state = firstUse();
  state.scene = "first";
  state.draft = { text: "保留", files: [], choice: { agent: "Codex" } };
  state.agents[0].added = true;
  state.agents[0].connected = true;
  const restored = restorePrototypeSnapshot(makePrototypeSnapshot(state));
  assert.equal(restored.scene, "first");
  assert.equal(restored.agents[0].connected, true);
  assert.equal(restored.draft.text, "保留");
  assert.equal(restored.tasks.length, 0);
});

test("first-use has no added Agents while retaining discoverable local programs", () => {
  const original = structuredClone(AGENT_CATALOG);
  const agents = firstUseAgents();
  for (const item of AGENT_CATALOG) {
    const entry = normalizeAgent(catalogState(item, agents));
    assert.equal(entry.added, false, item.id);
    assert.equal(entry.registered, false, item.id);
    assert.equal(entry.available, false, item.id);
    assert.equal(entry.connected, false, item.id);
    assert.equal(entry.connectionState, "idle", item.id);
    assert.equal(entry.installed, item.installed, item.id);
    assert.equal(
      entry.discovered,
      Boolean(item.discovered || item.installed),
      item.id,
    );
    if (item.installed || item.discovered)
      assert.ok(
        entry.installations.length > 0,
        "pre-existing programs must still be discoverable",
      );
  }
  agents[0].authMethods[0].label = "only this sample";
  assert.deepEqual(
    AGENT_CATALOG,
    original,
    "review samples must not mutate the catalog",
  );
});

test("explicit examples include current workbench conversations and only their ready Agents", () => {
  const state = exampleState();
  assert.equal(state.view, "conversations");
  assert.equal(state.scene, "examples");
  assert.equal(state.tasks.length, TASKS_V2.length + 4);
  assert.equal(
    new Set(state.tasks.map((task) => task.id)).size,
    state.tasks.length,
  );
  assert.deepEqual(
    state.tasks
      .filter((task) => task.workspaceKind)
      .map((task) => task.workspaceKind),
    ["review", "web", "document", "run"],
  );
  for (const task of state.tasks) {
    assert.ok(
      state.agents.some(
        (agent) => agent.name === task.agent && agent.connected,
      ),
    );
    assert.ok(state.groups.includes(task.group));
    if (task.serviceId)
      assert.ok(
        state.services.some((service) => service.id === task.serviceId),
      );
  }
  assert.equal(state.agents.filter((agent) => agent.connected).length, 3);
  assert.equal(state.agents.length, AGENT_CATALOG.length);
});

test("example data is isolated from fresh opening, subsequent resets and the catalog", () => {
  const catalog = structuredClone(AGENT_CATALOG);
  const sample = exampleState();
  sample.tasks[0].draft = "modified example";
  sample.agents[0].setupDraft = { onboarding: { phase: "account" } };
  sample.services[0].models = [];
  assert.notEqual(exampleState().tasks[0].draft, "modified example");
  assert.deepEqual(AGENT_CATALOG, catalog);
  const first = firstUseState();
  assert.equal(first.tasks.length, 0);
  assert.equal(
    first.agents.filter((agent) => agent.connected || agent.added).length,
    0,
  );
  assert.equal(first.draft.choice.agent, "");
});

for (const [kind, name] of [
  ["browser", "账号注册与登录示例"],
  ["device", "认证交互示例 · 设备码"],
  ["terminal", "认证交互示例 · 终端"],
]) {
  test(`retired ${kind} fixture is not restored as an Agent; draft content survives`, () => {
    const state = firstUseState();
    const fixture = {
      id: `review-auth-${kind}`,
      name,
      description: "独立交互提案，不对应任何真实 Agent 的已接通能力。",
      authenticationEvidence: "仅供交互评审；没有连接真实程序或账号。",
      capabilitiesEvidence: "独立模拟能力，不代表任何品牌已经支持。",
    };
    state.agents.push(fixture, {
      ...fixture,
      id: "custom-agent",
      name: "我的接入",
    });
    state.draft = {
      text: "保留我的内容",
      files: ["说明.md"],
      folder: "~/Work",
      choice: { agentId: fixture.id, agent: name, model: "sample" },
    };
    const restored = restorePrototypeSnapshot(makePrototypeSnapshot(state));
    assert.ok(!restored.agents.some((agent) => agent.id === fixture.id));
    assert.ok(restored.agents.some((agent) => agent.id === "custom-agent"));
    assert.equal(restored.draft.text, "保留我的内容");
    assert.deepEqual(restored.draft.files, ["说明.md"]);
    assert.equal(restored.draft.folder, "~/Work");
    assert.equal(restored.draft.choice.agent, "");
    assert.deepEqual(state.draft.choice.agentId, fixture.id);
  });
}

test("cleanup retains custom entries and unfinished real Agent preparation", () => {
  const state = firstUseState();
  state.agents[0].setupDraft = {
    onboarding: { phase: "account" },
    model: "6 Astra",
    effort: "Low",
  };
  state.agents.push({
    id: "review-auth-browser",
    name: "账号注册与登录示例",
    description: "用户自己的接入",
  });
  state.draft.choice = {
    agentId: "codex",
    agent: "Codex",
    model: "6 Astra",
    effort: "Low",
  };
  const restored = restorePrototypeSnapshot(makePrototypeSnapshot(state));
  assert.deepEqual(restored.agents[0].setupDraft, state.agents[0].setupDraft);
  assert.deepEqual(restored.draft.choice, state.draft.choice);
  assert.equal(restored.agents.length, state.agents.length);
});
