import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { AGENT_CATALOG } from "../src/agent-catalog.js";
import { normalizeAgent } from "../src/agent-setup-state.js";
import {
  draftForEntry,
  hasPendingOnboarding,
  pendingOnboardingForEntry,
  preparationIntentEntry,
  preservePendingPreparation,
} from "../src/setup-entry.js";
import {
  onboardingInitial,
  nextOnboarding,
  usesOnboarding,
  initialOnboardingRecord,
} from "../src/onboarding-state.js";
import {
  startAgentJob,
  advanceAgentJobs,
  programAction,
} from "../src/access-jobs.js";
import { firstUseAgents } from "../src/scene-state.js";

const agent = normalizeAgent(structuredClone(AGENT_CATALOG[0]));
const selection = {
  agentId: agent.id,
  agent: agent.name,
  accessMode: "existing",
  model: "6 Astra",
  effort: "High",
};
const context = { view: "new", folder: "/A", intent: "use" };
const service = {
  id: "api-a",
  name: "Service A",
  endpoint: "https://a.invalid/v1",
  format: "responses",
  models: ["Model A"],
  revision: 1,
  secretRevision: 1,
  demoKey: true,
};
const suspended = (intent) => {
  const initial = draftForEntry(agent, [service], selection, context);
  const draft =
    intent === "api"
      ? {
          ...initial,
          access: "api",
          serviceId: service.id,
          serviceSnapshot: service,
          model: "Model A",
        }
      : initial;
  return {
    ...agent,
    setupComplete: false,
    setupDraft: draft,
    onboarding: nextOnboarding(
      onboardingInitial(agent, initial, context),
      { type: "choose", intent },
      { agent, selection: draft, context, services: [service] },
    ),
  };
};

test("explicit preparation uses the unsent draft while retaining its original return page", () => {
  const original = {
    view: "thread",
    active: "old-thread",
    contextView: "thread",
    contextActive: "old-thread",
    folder: "/old",
    choice: { agent: "Other" },
  };
  const draft = {
    text: "Keep this",
    files: ["notes.md"],
    folder: "/A",
    choice: selection,
  };
  const next = preparationIntentEntry(original, "use", draft);
  assert.equal(next.view, "thread");
  assert.equal(next.active, "old-thread");
  assert.equal(next.contextView, "new");
  assert.equal(next.contextActive, null);
  assert.equal(next.folder, "/A");
  assert.deepEqual(next.choice, selection);
  assert.notEqual(next.choice, selection);
  assert.equal(usesOnboarding({ view: "thread", intent: "use" }), true);
  assert.equal(usesOnboarding({ view: "thread", intent: "manage" }), false);
  assert.equal(
    preparationIntentEntry(original, "manage", draft).contextView,
    "thread",
  );
});

test("leaving during the first connection keeps the unfinished guide after that connection finishes", () => {
  const first = normalizeAgent(firstUseAgents()[0]);
  const blank = { agent: "", model: "", accessMode: "existing" };
  const draft = draftForEntry(first, [], blank, context);
  const journey = onboardingInitial(first, draft, context);
  const record = initialOnboardingRecord(first, draft, journey);
  assert.ok(record);
  let current = startAgentJob(
    programAction({ ...first, ...record }, "register"),
    "connect",
    {},
    0,
  );
  for (let now = 1000; now <= 6000; now += 1000)
    current = advanceAgentJobs([current], now)[0];
  assert.equal(current.connected, true);
  assert.equal(hasPendingOnboarding(current), true);
  const resumed = pendingOnboardingForEntry(current, blank, {
    view: "agents",
    folder: "/A",
    intent: "manage",
  });
  assert.ok(resumed);
  assert.equal(
    onboardingInitial(
      current,
      draftForEntry(current, [], blank, resumed),
      resumed,
    ).step,
    "program",
  );
  assert.equal(initialOnboardingRecord(current, draft, null), null);
});

test("unfinished account and API preparation resume from use, management and account repair without changing the chosen source", () => {
  for (const intent of ["account", "api"]) {
    const current = suspended(intent);
    for (const entry of [
      { ...context, intent: "use" },
      { ...context, intent: "manage" },
      { view: "agents", folder: "/A", intent: "manage" },
      { ...context, repair: "account" },
    ]) {
      const resumed = pendingOnboardingForEntry(current, selection, entry);
      assert.ok(resumed);
      assert.equal(usesOnboarding(resumed), true);
      const draft = draftForEntry(current, [service], selection, resumed);
      assert.deepEqual(draft, current.setupDraft);
      const journey = onboardingInitial(current, draft, resumed);
      assert.equal(journey.step, intent === "api" ? "api" : "account");
      assert.equal(journey.intent, intent);
    }
  }
});

test("another location, changed choice, fixed history and ordinary management cannot inherit unfinished preparation", () => {
  const current = suspended("api");
  for (const [chosen, entry] of [
    [selection, { ...context, folder: "/B" }],
    [selection, { ...context, view: "agents", intent: "import" }],
    [{ ...selection, model: "Different" }, context],
    [
      selection,
      { ...context, view: "thread", active: "history", intent: "manage" },
    ],
  ])
    assert.equal(pendingOnboardingForEntry(current, chosen, entry), null);
  assert.equal(
    pendingOnboardingForEntry(
      { ...current, setupComplete: true },
      selection,
      context,
    ),
    null,
  );
  assert.equal(hasPendingOnboarding({ ...current, onboarding: null }), false);
  const other = draftForEntry(current, [service], undefined, {
    view: "agents",
    folder: "/B",
  });
  assert.equal(other.folder, "/B");
  assert.equal(other.access, "existing");
  assert.equal(other.serviceId, "");
  assert.equal(other.model, agent.model || agent.models[0]);
});

test("history or import changes preserve another entry's unfinished preparation throughout editing and completion", () => {
  const original = suspended("api");
  const protectedOwner = structuredClone(original);
  for (const changes of [
    {
      setupDraft: {
        folder: "/history",
        access: "existing",
        model: "History model",
      },
      setupComplete: false,
    },
    {
      setupDraft: { folder: "/history" },
      onboarding: null,
      setupComplete: true,
      setupEvidence: { folder: "/history" },
    },
    {
      accessJob: { id: "other-operation" },
      connected: true,
      setupDraft: { test: "idle" },
    },
  ]) {
    const result = preservePendingPreparation(changes, protectedOwner);
    assert.deepEqual(result.setupDraft, original.setupDraft);
    assert.deepEqual(result.onboarding, original.onboarding);
    assert.equal(result.setupComplete, false);
    if (changes.accessJob)
      assert.deepEqual(result.accessJob, changes.accessJob);
  }
  const completed = { ...original, setupComplete: true, onboarding: null };
  const change = { setupDraft: { model: "New preference" } };
  assert.equal(preservePendingPreparation(change, completed), change);
  assert.deepEqual(original, protectedOwner);
});

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
const render = (current, initialContext = { ...context, intent: "manage" }) =>
  renderToStaticMarkup(
    React.createElement(Setup, {
      agent: current,
      services: [service],
      initialSelection: selection,
      initialContext,
      onChange() {},
      onClose() {},
    }),
  );

test("reopening an unfinished account from management retains the three stages and exact active login job", () => {
  const method = {
    id: "browser",
    type: "agent",
    presentation: "browser",
    label: "登录账号",
  };
  const pending = { ...suspended("account"), authMethods: [method] };
  const waiting = startAgentJob(
    pending,
    "auth",
    { authMethod: method, selection: pending.setupDraft },
    0,
  );
  const snapshot = structuredClone(waiting);
  const html = render(waiting);
  assert.ok(html.includes('aria-label="接入进度"'));
  assert.ok(!html.includes('aria-label="Agent 设置类别"'));
  assert.ok(html.includes("取消登录，重新选择"));
  assert.deepEqual(waiting, snapshot);
  assert.equal(waiting.accessJob.id, snapshot.accessJob.id);
  const completed = render({
    ...pending,
    setupComplete: true,
    onboarding: null,
  });
  assert.ok(!completed.includes('aria-label="接入进度"'));
  assert.ok(completed.includes("保存设置"));
});

test("the directory offers continuation for an unfinished guide instead of bypassing its selected API", () => {
  const current = suspended("api");
  const html = renderToStaticMarkup(
    React.createElement(Hub, {
      agents: [current],
      services: [service],
      initialSelection: selection,
      initialContext: context,
    }),
  );
  const card = html.split("<strong>Codex</strong>")[1].split("</article>")[0];
  assert.ok(card.includes("继续准备"));
  assert.ok(!card.includes("开始新对话"));
  const reopened = render(current);
  assert.ok(reopened.includes('aria-label="接入进度"'));
  assert.ok(reopened.includes("选择 API 服务"));
  assert.ok(reopened.includes('value="api-a" selected=""'));
});

test("the original new draft continues unfinished preparation while another location remains independent", () => {
  const current = suspended("account");
  const display = (folder) =>
    renderToStaticMarkup(
      React.createElement(NewConversation, {
        agents: [current],
        services: [service],
        choice: selection,
        folder,
        draft: "Preserve this draft",
        files: ["notes.md"],
      }),
    );
  const original = display("/A");
  assert.ok(original.includes('aria-label="继续设置 Agent"'));
  assert.ok(!original.includes('aria-label="发送新对话"'));
  assert.ok(original.includes("Preserve this draft"));
  assert.ok(original.includes("notes.md"));
  assert.ok(display("/B").includes('aria-label="发送新对话"'));
});

test("an empty initial choice renders a clear Agent picker without inventing a selected Agent", () => {
  const choice = { agent: "", model: "", accessMode: "existing" };
  const html = renderToStaticMarkup(
    React.createElement(NewConversation, {
      agents: [],
      services: [],
      choice,
      folder: "",
      draft: "",
      files: [],
    }),
  );
  assert.match(html, /aria-label="选择 Agent"[^>]*>选择 Agent</);
  assert.ok(html.includes('aria-label="挑选 Agent"'));
  assert.equal(choice.agent, "");
});
