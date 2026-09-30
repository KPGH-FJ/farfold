import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { firstUseState } from "../src/scene-state.js";
import * as setup from "../src/agent-setup-state.js";
import {
  advanceAgentJobs,
  programAction,
  startAgentJob,
} from "../src/access-jobs.js";
import {
  initialOnboardingRecord,
  nextOnboarding,
  onboardingInitial,
  usesOnboarding,
} from "../src/onboarding-state.js";
import { draftForEntry, hasPendingOnboarding } from "../src/setup-entry.js";
import {
  makePrototypeSnapshot,
  restorePrototypeSnapshot,
} from "../src/prototype-persistence.js";

let server, Setup, Hub, NewConversation;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  Setup = (await server.ssrLoadModule("/src/AgentSetup.jsx")).default;
  Hub = (await server.ssrLoadModule("/src/AgentHub.jsx")).default;
  NewConversation = (await server.ssrLoadModule("/src/NewConversationV2.jsx"))
    .default;
});
after(async () => {
  await server?.close();
});

test("fresh Codex gear opens the same first preparation guide as prepare-use", () => {
  const fresh = firstUseState();
  const agent = fresh.agents.find((entry) => entry.id === "codex");
  for (const intent of ["use", "manage"]) {
    const html = renderToStaticMarkup(
      React.createElement(Setup, {
        agent,
        services: fresh.services,
        initialSelection: fresh.draft.choice,
        initialContext: { view: "agents", intent },
        onChange() {},
        onClose() {},
      }),
    );
    assert.ok(html.includes('aria-label="接入进度"'), intent);
    assert.ok(html.includes("接入 Codex"), intent);
  }
});

const render = (Component, props) =>
  renderToStaticMarkup(React.createElement(Component, props));
const prepareContext = (intent) => ({ view: "agents", folder: "", intent });
const renderSetup = (agent, intent, overrides = {}) =>
  render(Setup, {
    agent,
    services: [],
    initialSelection: firstUseState().draft.choice,
    initialContext: prepareContext(intent),
    onChange() {},
    onClose() {},
    ...overrides,
  });

// Exercise the prototype's installation/connection lifecycle, without marking
// an Agent connected or prepared directly. These jobs perform no real Agent I/O.
function finishJob(agent, type) {
  let current = startAgentJob(agent, type, {}, 0);
  assert.equal(current.accessJob?.type, type, `${agent.id}: ${type} started`);
  for (let now = 1000; now <= 12000 && current.accessJob; now += 1000)
    current = advanceAgentJobs([current], now)[0];
  assert.equal(current.accessJob, null, `${agent.id}: ${type} finished`);
  assert.equal(current.lastAccessResult?.status, "passed", agent.id);
  return current;
}

function connectFirst(agent) {
  let current = setup.normalizeAgent(structuredClone(agent));
  if (!current.installed) current = finishJob(current, "install");
  current = programAction(current, "register");
  assert.equal(current.registered, true, agent.id);
  return finishJob(current, "connect");
}

function finishPreparation(agent) {
  const context = prepareContext("use");
  const draft = draftForEntry(agent, [], firstUseState().draft.choice, context);
  const initial = onboardingInitial(agent, draft, context);
  assert.equal(initial?.step, "method", agent.id);
  const review = nextOnboarding(
    initial,
    { type: "choose", intent: "existing" },
    { agent, selection: draft, context, services: [] },
  );
  assert.equal(review?.step, "review", agent.id);
  assert.equal(setup.setupCompletionIssue(agent, draft, []), null, agent.id);
  assert.equal(draft.test, "idle", "a paid short test is not required");
  return setup.preparedAgent(agent, draft, []);
}

function roundTrip(agent) {
  const state = firstUseState();
  state.agents = state.agents.map((entry) =>
    entry.id === agent.id ? agent : entry,
  );
  state.draft.text = "保留未发送内容";
  state.draft.files = ["notes.md"];
  const restored = restorePrototypeSnapshot(makePrototypeSnapshot(state));
  assert.deepEqual(restored.draft, state.draft);
  return setup.normalizeAgent(
    restored.agents.find((entry) => entry.id === agent.id),
  );
}

const catalogue = firstUseState().agents;
test("the first-entry matrix covers all ten catalogue Agents", () => {
  assert.deepEqual(
    catalogue.map((agent) => agent.id),
    [
      "codex",
      "opencode",
      "pi",
      "cline",
      "qwen-code",
      "claude-agent",
      "gemini-cli",
      "goose",
      "kimi-cli",
      "fast-agent",
    ],
  );
});

for (const fresh of catalogue) {
  test(`${fresh.name}: fresh gear and prepare-use share the initial guide`, () => {
    assert.equal(setup.agentNeedsInitialPreparation(fresh), true);
    assert.equal(setup.agentCanStartConversation(fresh), false);
    assert.equal(fresh.onboardingComplete, false);
    for (const intent of ["use", "manage"]) {
      const context = prepareContext(intent);
      assert.equal(usesOnboarding(context, fresh), true, intent);
      const draft = draftForEntry(
        fresh,
        [],
        firstUseState().draft.choice,
        context,
      );
      assert.equal(onboardingInitial(fresh, draft, context)?.step, "program");
      const html = renderSetup(fresh, intent);
      assert.ok(html.includes('aria-label="接入进度"'), intent);
      assert.ok(html.includes(`接入 ${fresh.name}`), intent);
      assert.ok(!html.includes(">保存设置</button>"), intent);
    }
  });

  test(`${fresh.name}: connection alone does not complete the first preparation`, () => {
    const connected = connectFirst(fresh);
    assert.equal(connected.connected, true);
    assert.equal(connected.setupComplete, false);
    assert.ok(!connected.onboarding);
    assert.equal(hasPendingOnboarding(connected), false);
    assert.equal(
      setup.agentCanAttempt(connected),
      true,
      "existing work may attempt its connection",
    );
    assert.equal(setup.agentNeedsInitialPreparation(connected), true);
    assert.equal(setup.agentCanStartConversation(connected), false);
    for (const intent of ["use", "manage"]) {
      const context = prepareContext(intent);
      const draft = draftForEntry(
        connected,
        [],
        firstUseState().draft.choice,
        context,
      );
      assert.equal(usesOnboarding(context, connected), true, intent);
      assert.equal(
        onboardingInitial(connected, draft, context)?.step,
        "method",
      );
      const html = renderSetup(connected, intent);
      assert.ok(html.includes('aria-label="接入进度"'), intent);
      assert.ok(html.includes('aria-label="选择使用方式"'), intent);
    }
    const state = firstUseState();
    const agents = state.agents.map((entry) =>
      entry.id === connected.id ? connected : entry,
    );
    const directory = render(Hub, { agents });
    const card = directory
      .split(`<strong>${fresh.name}</strong>`)[1]
      ?.split("</article>")[0];
    assert.ok(card?.includes("继续准备"), fresh.name);
    assert.ok(!card.includes("开始新对话"));
    const composer = render(NewConversation, {
      agents,
      services: [],
      choice: { agentId: fresh.id, agent: fresh.name, accessMode: "existing" },
      draft: "保留草稿",
      files: [],
    });
    assert.ok(composer.includes('aria-label="继续设置 Agent"'));
    assert.ok(!composer.includes('aria-label="发送新对话"'));
  });

  test(`${fresh.name}: explicit completion enables use and keeps gear in daily settings after reconnect`, () => {
    const completed = finishPreparation(connectFirst(fresh));
    assert.equal(completed.onboardingComplete, true);
    assert.equal(setup.agentNeedsInitialPreparation(completed), false);
    assert.equal(setup.agentCanStartConversation(completed), true);
    assert.equal(usesOnboarding(prepareContext("manage"), completed), false);
    const html = renderSetup(completed, "manage");
    assert.ok(!html.includes('aria-label="接入进度"'));
    assert.ok(html.includes("保存设置"));
    const disconnected = programAction(completed, "disconnect");
    assert.equal(setup.agentCanStartConversation(disconnected), false);
    const reconnected = finishJob(disconnected, "connect");
    assert.equal(reconnected.setupComplete, false);
    assert.equal(reconnected.onboardingComplete, true);
    assert.equal(setup.agentNeedsInitialPreparation(reconnected), false);
    assert.equal(setup.agentCanStartConversation(reconnected), true);
    assert.equal(usesOnboarding(prepareContext("manage"), reconnected), false);
    const legacy = { ...completed, onboardingComplete: undefined };
    assert.equal(setup.normalizeAgent(legacy).onboardingComplete, true);
    assert.equal(setup.agentNeedsInitialPreparation(legacy), false);
  });

  test(`${fresh.name}: restart preserves incomplete and completed preparation separately`, () => {
    const connected = connectFirst(fresh);
    const context = prepareContext("use");
    const draft = draftForEntry(
      connected,
      [],
      firstUseState().draft.choice,
      context,
    );
    const record = initialOnboardingRecord(
      connected,
      draft,
      onboardingInitial(connected, draft, context),
    );
    assert.ok(record);
    for (const candidate of [fresh, connected, { ...connected, ...record }]) {
      const restored = roundTrip(candidate);
      assert.equal(setup.agentNeedsInitialPreparation(restored), true);
      assert.equal(setup.agentCanStartConversation(restored), false);
      assert.equal(usesOnboarding(prepareContext("manage"), restored), true);
      assert.deepEqual(restored.onboarding, candidate.onboarding);
      assert.deepEqual(restored.setupDraft, candidate.setupDraft);
    }
    const prepared = roundTrip(finishPreparation(connected));
    assert.equal(prepared.onboardingComplete, true);
    assert.equal(setup.agentCanStartConversation(prepared), true);
    assert.equal(usesOnboarding(prepareContext("manage"), prepared), false);
  });

  test(`${fresh.name}: history import and fixed conversation repair do not force global first preparation`, () => {
    const connected = connectFirst(fresh);
    const selection = {
      agentId: fresh.id,
      agent: fresh.name,
      accessMode: "existing",
    };
    for (const context of [
      { view: "agents", intent: "import" },
      { view: "new", import: true },
      { view: "thread", active: "existing-thread", intent: "manage" },
      {
        view: "thread",
        active: "existing-thread",
        repair: "account",
        fixedConversation: true,
      },
    ]) {
      assert.equal(
        usesOnboarding(context, connected),
        false,
        JSON.stringify(context),
      );
      const draft = draftForEntry(connected, [], selection, context);
      assert.equal(onboardingInitial(connected, draft, context), null);
      const html = renderSetup(connected, "manage", {
        initialSelection: selection,
        initialContext: context,
      });
      assert.ok(
        !html.includes('aria-label="接入进度"'),
        JSON.stringify(context),
      );
      assert.equal(setup.agentCanAttempt(connected), true);
    }
  });
}
