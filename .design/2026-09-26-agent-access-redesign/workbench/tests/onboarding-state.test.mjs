import assert from "node:assert/strict";
import test from "node:test";
import {
  onboardingInitial,
  nextOnboarding,
  onboardingStepIssue,
  usesOnboarding,
} from "../src/onboarding-state.js";
import {
  markAuthenticationForRetry,
  rememberAgentAuthenticationRequirement,
} from "../src/authentication-state.js";
import { preparationEntryKey } from "../src/setup-entry.js";
import {
  advanceAgentJobs,
  cancelAgentJob,
  confirmAgentJobStopped,
  continueAgentJob,
  startAgentJob,
} from "../src/access-jobs.js";

const agent = {
  id: "sample",
  name: "示例 Agent",
  installed: true,
  registered: true,
  connected: true,
  connectionState: "connected",
  selectedInstallationId: "program-a",
  models: ["Model A", "Model B"],
  authMethods: [{ id: "account", type: "agent", label: "登录账号" }],
  serviceCapabilities: { status: "implemented", formats: ["responses"] },
};
const selection = {
  agentId: "sample",
  access: "existing",
  folder: "/A",
  model: "Model A",
  effort: "high",
};
const context = { view: "new", folder: "/A" };
const service = {
  id: "api-a",
  name: "服务 A",
  endpoint: "https://a.example.invalid/v1",
  format: "responses",
  models: ["Model A", "Model B"],
  revision: 1,
  secretRevision: 1,
};
const apiSelection = {
  ...selection,
  access: "api",
  serviceId: service.id,
  serviceSnapshot: { ...service },
};
test("a failed request opens account repair directly and keeps its selected source", () => {
  for (const selected of [selection, apiSelection]) {
    const required = rememberAgentAuthenticationRequirement(agent, selected);
    const repairContext = { ...context, repair: "account" };
    const initial = onboardingInitial(required, selected, repairContext);
    assert.equal(initial.step, "account");
    assert.equal(initial.intent, selected.access === "api" ? "api" : "account");
    const retried = markAuthenticationForRetry(required, selected);
    const next = nextOnboarding(initial, "next", {
      agent: retried,
      selection: selected,
      services: [service],
      context: repairContext,
    });
    assert.equal(next.step, "review");
    assert.equal(next.intent, initial.intent);
    assert.equal(selected.model, "Model A");
    assert.equal(selected.effort, "high");
  }
});
test("account repair reconnects a missing program before returning to login", () => {
  const required = rememberAgentAuthenticationRequirement(agent, selection);
  const repairContext = { ...context, repair: "account" };
  const initial = onboardingInitial(
    { ...required, connected: false, connectionState: "idle" },
    selection,
    repairContext,
  );
  assert.equal(initial.step, "program");
  const connected = nextOnboarding(initial, "next", {
    agent: required,
    selection,
    context: repairContext,
  });
  assert.equal(connected.step, "account");
});
test("repair in one location does not force login for an unaffected choice", () => {
  const required = rememberAgentAuthenticationRequirement(agent, selection);
  const initial = onboardingInitial(
    required,
    { ...selection, folder: "/B" },
    {
      ...context,
      folder: "/B",
      repair: "account",
    },
  );
  assert.equal(initial.step, "method");
});
const environment = (changes = {}) => ({
  agent,
  selection,
  services: [service],
  context,
  ...changes,
});
const choose = (intent, changes = {}) => {
  const inputs = environment(changes);
  const initial = onboardingInitial(inputs.agent, inputs.selection, context);
  return nextOnboarding(initial, { type: "choose", intent }, inputs);
};
const finishedAuthentication = (currentAgent, currentSelection) => ({
  ...markAuthenticationForRetry(currentAgent, currentSelection),
  authentication: {
    status: "flow-finished",
    folder: currentSelection.folder,
    method: "account",
    jobId: "finished-login",
  },
});

test("existing local settings proceed without forcing login or a paid test", () => {
  const before = structuredClone(agent);
  const state = choose("existing");
  assert.equal(state.step, "review");
  assert.equal(state.intent, "existing");
  assert.equal(onboardingStepIssue(state, agent, selection, [service]), null);
  assert.deepEqual(agent, before);
  assert.equal(agent.authentication, undefined);
  const required = rememberAgentAuthenticationRequirement(agent, selection);
  assert.equal(choose("existing", { agent: required }).step, "account");
});

test("registration, external return, failed or unknown auth never completes the account branch", () => {
  const state = choose("account");
  assert.equal(state.step, "account");
  for (const status of ["idle", "waiting", "failed", "unknown", "cancelled"]) {
    const currentAgent = {
      ...agent,
      registration: { status: "registered" },
      authentication: { status, folder: selection.folder },
    };
    assert.equal(
      nextOnboarding(state, "after-auth", environment({ agent: currentAgent })),
      state,
    );
  }
  const finished = finishedAuthentication(agent, selection);
  assert.equal(
    nextOnboarding(state, "after-auth", environment({ agent: finished })).step,
    "review",
  );
  const wrongFolder = { ...selection, folder: "/B" };
  assert.equal(
    nextOnboarding(
      state,
      "after-auth",
      environment({ agent: finished, selection: wrongFolder }),
    ),
    state,
  );
});

test("API setup, Agent login and source revisions remain separate gates", () => {
  const requiresAccount = rememberAgentAuthenticationRequirement(
    {
      ...agent,
      serviceCapabilities: {
        ...agent.serviceCapabilities,
        requiresAgentAuthentication: true,
      },
    },
    apiSelection,
  );
  const inputs = environment({
    agent: requiresAccount,
    selection: apiSelection,
  });
  const api = choose("api", inputs);
  assert.equal(api.step, "api");
  const account = nextOnboarding(api, "next", inputs);
  assert.equal(account.step, "account");
  assert.equal(account.intent, "api");
  const finished = finishedAuthentication(requiresAccount, apiSelection);
  assert.equal(
    nextOnboarding(account, "after-auth", { ...inputs, agent: finished }).step,
    "review",
  );
  assert.equal(
    nextOnboarding(account, "after-auth", {
      ...inputs,
      agent: finished,
      services: [],
    }).step,
    "api",
  );
  for (const changed of [
    { ...apiSelection, serviceId: "api-b" },
    { ...apiSelection, model: "Model B" },
    {
      ...apiSelection,
      serviceSnapshot: { ...service, secretRevision: 2 },
    },
  ]) {
    assert.equal(
      nextOnboarding(account, "after-auth", {
        ...inputs,
        agent: finished,
        selection: changed,
      }),
      account,
    );
  }
});

test("pending access work cannot switch branches or discard the current step", () => {
  const state = choose("account");
  const currentAgent = {
    ...agent,
    accessJob: { type: "auth", status: "waiting", id: "pending" },
  };
  const before = structuredClone(currentAgent);
  for (const action of [
    "back",
    "restart",
    "next",
    "after-auth",
    { type: "choose", intent: "api" },
  ]) {
    assert.equal(
      nextOnboarding(state, action, environment({ agent: currentAgent })),
      state,
    );
  }
  assert.match(
    onboardingStepIssue(state, currentAgent, selection, []),
    /尚未结束/,
  );
  assert.deepEqual(currentAgent, before);
});

test("restoration is tied to the entry while completed management, import and established threads bypass onboarding", () => {
  const state = choose("account");
  assert.equal(state.entryKey, preparationEntryKey(agent, selection, context));
  const saved = { ...agent, onboarding: state };
  assert.deepEqual(onboardingInitial(saved, selection, context), state);
  assert.equal(
    onboardingInitial(saved, selection, { ...context, folder: "/B" }).step,
    "method",
  );
  assert.equal(
    onboardingInitial(saved, { ...selection, model: "Model B" }, context).step,
    "method",
  );
  const implicitAgentSelection = { ...selection };
  delete implicitAgentSelection.agentId;
  const implicit = onboardingInitial(agent, implicitAgentSelection, context);
  assert.equal(implicit.entryKey, state.entryKey);
  const completed = { ...saved, onboardingComplete: true };
  for (const mode of [{ ...context, intent: "manage" }, { view: "explore" }]) {
    assert.equal(usesOnboarding(mode, completed), false);
    assert.equal(onboardingInitial(completed, selection, mode), null);
    assert.notEqual(onboardingInitial(saved, selection, mode), null);
  }
  for (const mode of [
    { ...context, intent: "import" },
    { ...context, view: "thread" },
    { ...context, fixedConversation: true },
  ]) {
    assert.equal(usesOnboarding(mode), false);
    assert.equal(onboardingInitial(saved, selection, mode), null);
  }
  assert.equal(usesOnboarding({ view: "explore", intent: "use" }), true);
});

test("program preparation must finish before choosing a usage branch", () => {
  const disconnected = { ...agent, connected: false, connectionState: "idle" };
  const state = onboardingInitial(disconnected, selection, context);
  assert.equal(state.step, "program");
  assert.equal(
    nextOnboarding(state, "next", environment({ agent: disconnected })),
    state,
  );
  assert.equal(
    nextOnboarding(
      state,
      { type: "choose", intent: "existing" },
      environment({ agent: disconnected }),
    ),
    state,
  );
  assert.equal(nextOnboarding(state, "next", environment()).step, "method");
});

test("unsupported API is not a selectable dead end, and missing model options do not invent a required model", () => {
  const noApi = { ...agent, serviceCapabilities: { status: "unavailable" } };
  const state = onboardingInitial(noApi, selection, context);
  assert.equal(
    nextOnboarding(
      state,
      { type: "choose", intent: "api" },
      environment({ agent: noApi }),
    ),
    state,
  );
  const noModels = { ...agent, models: [] };
  const emptySelection = { ...selection, model: "" };
  const review = choose("existing", {
    agent: noModels,
    selection: emptySelection,
  });
  assert.equal(review.step, "review");
  assert.equal(onboardingStepIssue(review, noModels, emptySelection, []), null);
});

test("explicit external-repair retry can proceed without being relabeled authentication success", () => {
  const required = rememberAgentAuthenticationRequirement(agent, selection);
  const state = choose("existing", { agent: required });
  const retry = markAuthenticationForRetry(required, selection);
  assert.equal(
    nextOnboarding(state, "after-auth", environment({ agent: retry })),
    state,
  );
  assert.equal(
    nextOnboarding(state, "next", environment({ agent: retry })).step,
    "review",
  );
  assert.equal(retry.authentication.status, "needs-check");
});

test("a review authentication failure has a direct repair path and returns without replacing the selected source", () => {
  for (const selected of [selection, apiSelection]) {
    const review = {
      ...onboardingInitial(agent, selected, context),
      step: "review",
      intent: selected.access === "api" ? "api" : "existing",
    };
    const required = rememberAgentAuthenticationRequirement(agent, selected);
    const repaired = nextOnboarding(
      review,
      "repair-account",
      environment({ agent: required, selection: selected }),
    );
    assert.equal(repaired.step, "account");
    assert.equal(repaired.intent, review.intent);
    const finished = finishedAuthentication(required, selected);
    const returned = nextOnboarding(
      repaired,
      "after-auth",
      environment({ agent: finished, selection: selected }),
    );
    assert.equal(returned.step, "review");
    assert.equal(returned.intent, review.intent);
    assert.equal(returned.entryKey, review.entryKey);
  }
});

test("a review service failure repairs the API configuration without treating it as Agent login", () => {
  const review = {
    ...onboardingInitial(agent, apiSelection, context),
    step: "review",
    intent: "api",
  };
  const failed = {
    ...agent,
    serviceAuthIssues: [{ serviceId: service.id, secretRevision: 1 }],
  };
  const repair = nextOnboarding(
    review,
    "repair-api",
    environment({ agent: failed, selection: apiSelection }),
  );
  assert.equal(repair.step, "api");
  assert.equal(repair.intent, "api");
  assert.equal(
    nextOnboarding(
      repair,
      "next",
      environment({ agent: failed, selection: apiSelection }),
    ),
    repair,
  );
  const updatedService = { ...service, secretRevision: 2 };
  const updatedSelection = { ...apiSelection, serviceSnapshot: updatedService };
  const returned = nextOnboarding(
    repair,
    "next",
    environment({
      agent: failed,
      selection: updatedSelection,
      services: [updatedService],
    }),
  );
  assert.equal(returned.step, "review");
  assert.equal(returned.intent, "api");
  assert.equal(failed.authentication, undefined);
});

test("repair navigation is unavailable outside review, while busy, or when no matching fault exists", () => {
  const review = {
    ...onboardingInitial(agent, selection, context),
    step: "review",
    intent: "existing",
  };
  const required = rememberAgentAuthenticationRequirement(agent, selection);
  for (const action of ["repair-account", "repair-api"]) {
    assert.equal(nextOnboarding(review, action, environment()), review);
    const account = { ...review, step: "account" };
    assert.equal(
      nextOnboarding(account, action, environment({ agent: required })),
      account,
    );
    assert.equal(
      nextOnboarding(
        review,
        action,
        environment({
          agent: {
            ...required,
            accessJob: { type: "test", status: "unknown" },
          },
        }),
      ),
      review,
    );
    assert.equal(
      nextOnboarding(
        review,
        action,
        environment({ agent: { ...required, connected: false } }),
      ),
      review,
    );
  }
});

test("an actual prototype authentication job preserves the API source through completion and the review return", () => {
  const required = rememberAgentAuthenticationRequirement(
    { ...agent, setupDraft: { ...apiSelection } },
    apiSelection,
  );
  const account = {
    ...onboardingInitial(required, apiSelection, context),
    step: "account",
    intent: "api",
  };
  let running = startAgentJob(
    required,
    "auth",
    { selection: apiSelection, authMethod: agent.authMethods[0] },
    1000,
  );
  running = continueAgentJob(running, running.accessJob.id, 1000);
  for (const time of [2000, 3000, 4000])
    running = advanceAgentJobs([running], time)[0];
  assert.equal(running.accessJob, null);
  assert.equal(running.authentication.status, "flow-finished");
  for (const key of [
    "access",
    "serviceId",
    "serviceSnapshot",
    "model",
    "effort",
    "folder",
  ]) {
    assert.deepEqual(running.setupDraft[key], apiSelection[key]);
  }
  const returned = nextOnboarding(
    account,
    "after-auth",
    environment({ agent: running, selection: running.setupDraft }),
  );
  assert.equal(returned.step, "review");
  assert.equal(returned.intent, "api");
});

test("cancelled API authentication returns to its API step only after termination is confirmed", () => {
  const original = { ...agent, setupDraft: { ...apiSelection } };
  const account = {
    ...onboardingInitial(original, apiSelection, context),
    step: "account",
    intent: "api",
  };
  let running = startAgentJob(
    original,
    "auth",
    {
      selection: apiSelection,
      authMethod: agent.authMethods[0],
      cancelOutcome: "unknown",
    },
    1000,
  );
  running = cancelAgentJob(running, 1000);
  running = advanceAgentJobs([running], 2000)[0];
  assert.equal(running.accessJob.status, "unknown");
  assert.equal(
    nextOnboarding(
      account,
      "back",
      environment({ agent: running, selection: apiSelection }),
    ),
    account,
  );
  const stopped = confirmAgentJobStopped(running, running.accessJob.id);
  const previous = nextOnboarding(
    account,
    "back",
    environment({ agent: stopped, selection: apiSelection }),
  );
  assert.equal(previous.step, "api");
  assert.equal(previous.intent, "api");
  assert.equal(stopped.setupDraft.serviceId, service.id);
  assert.deepEqual(
    stopped.setupDraft.serviceSnapshot,
    apiSelection.serviceSnapshot,
  );
  assert.equal(stopped.authentication, undefined);
});
