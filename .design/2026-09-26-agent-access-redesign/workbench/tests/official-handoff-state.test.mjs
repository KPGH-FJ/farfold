import assert from "node:assert/strict";
import test from "node:test";
import {
  beginOfficialHandoff,
  transitionOfficialHandoff,
  canFinishOfficialHandoff,
} from "../src/official-handoff-state.js";
import {
  startAgentJob,
  continueAgentJob,
  resolveAuthenticationJob,
  advanceAgentJobs,
} from "../src/access-jobs.js";
import {
  accountRequiredForSelection,
  authenticationRetryAllowed,
  rememberAgentAuthenticationRequirement,
} from "../src/authentication-state.js";

const method = {
  id: "declared",
  type: "agent",
  accountLabel: "Selected Account",
};
const accountRoute = {
  id: "account-login",
  purpose: "login",
  accountOwner: "Selected Account",
  interaction: { serviceSelection: "fixed-account" },
};
const serviceRoute = {
  id: "service-setup",
  purpose: "service",
  accountOwner: "Chosen by the Agent",
  interaction: { serviceSelection: "agent-owned" },
};
const choice = {
  access: "api",
  serviceId: "saved-service",
  model: "M",
  effort: "High",
  folder: "/project",
  serviceSnapshot: {
    endpoint: "https://api.example.test/v1",
    format: "responses",
    revision: 2,
    secretRevision: 3,
  },
};
const seed = () => ({
  id: "example",
  installed: true,
  added: true,
  registered: true,
  connected: true,
  connectionState: "connected",
  authMethods: [method],
  models: ["M"],
  model: "M",
  effort: "High",
});
const start = (route, outcome = "success") => {
  const original = rememberAgentAuthenticationRequirement(seed(), choice);
  const agent = startAgentJob(
    original,
    "auth",
    { authMethod: method, selection: choice, outcome },
    0,
  );
  return {
    ...agent,
    accessJob: {
      ...agent.accessJob,
      officialHandoff: beginOfficialHandoff(route, method),
    },
  };
};
const transition = (agent, action) => ({
  ...agent,
  accessJob: {
    ...agent.accessJob,
    officialHandoff: transitionOfficialHandoff(
      agent.accessJob.officialHandoff,
      action,
    ),
  },
});
const finish = (agent) => {
  let current = continueAgentJob(agent, agent.accessJob.id, 100);
  for (const now of [1000, 2000, 3000])
    current = advanceAgentJobs([current], now)[0];
  return current;
};

test("opening or returning from account signup/login never creates authorization", () => {
  const initial = beginOfficialHandoff(accountRoute, method);
  assert.equal(initial.mode, "account");
  assert.equal(initial.account, "Selected Account");
  assert.equal(canFinishOfficialHandoff(initial), false);
  assert.equal(transitionOfficialHandoff(initial, "approve"), initial);
  const external = transitionOfficialHandoff(initial, "open");
  const returned = transitionOfficialHandoff(external, "return");
  assert.equal(returned.stage, "waiting");
  assert.equal(canFinishOfficialHandoff(returned), false);
  assert.equal(transitionOfficialHandoff(returned, "approve"), returned);
  const confirmed = transitionOfficialHandoff(
    transitionOfficialHandoff(returned, "open"),
    "approve",
  );
  assert.equal(canFinishOfficialHandoff(confirmed), true);
  assert.equal(transitionOfficialHandoff(confirmed, "open"), confirmed);
  assert.equal(confirmed.registered, undefined);
  assert.equal(confirmed.entitlement, undefined);
});

test("Agent-owned setup cannot turn a fabricated account approval into success", () => {
  assert.equal(
    beginOfficialHandoff(null, { ...method, purpose: "setup" }).mode,
    "service",
  );
  const initial = beginOfficialHandoff(serviceRoute, method);
  assert.equal(initial.mode, "service");
  assert.equal(initial.account, null);
  assert.equal(
    transitionOfficialHandoff(initial, "settings-returned"),
    initial,
  );
  const external = transitionOfficialHandoff(initial, "open");
  assert.equal(transitionOfficialHandoff(external, "approve"), external);
  assert.equal(
    canFinishOfficialHandoff(transitionOfficialHandoff(external, "return")),
    false,
  );
  const returned = transitionOfficialHandoff(external, "settings-returned");
  assert.equal(returned.stage, "returned");
  assert.equal(canFinishOfficialHandoff(returned), true);
  assert.equal(returned.authorized, undefined);
  assert.equal(returned.provider, undefined);
});

test("waiting handoffs cannot bypass interaction through continue or a generic late-result control", () => {
  for (const route of [accountRoute, serviceRoute]) {
    let agent = start(route);
    for (const action of [null, "open", "return"]) {
      if (action) agent = transition(agent, action);
      assert.equal(continueAgentJob(agent, agent.accessJob.id, 100), agent);
      assert.equal(
        resolveAuthenticationJob(agent, agent.accessJob.id, 100),
        agent,
      );
    }
  }
});

test("service return retains known authentication failure and grants only the exact selection a retry", () => {
  let agent = start(serviceRoute);
  agent = transition(transition(agent, "open"), "settings-returned");
  const result = finish(agent);
  assert.equal(result.accessJob, null);
  assert.equal(result.authentication.status, "external-returned");
  assert.equal(result.authentication.accountService, null);
  assert.equal(result.authentication.accountKind, null);
  assert.equal(result.authentication.entitlement, "unknown");
  assert.equal(accountRequiredForSelection(result, choice), true);
  assert.equal(authenticationRetryAllowed(result, choice), true);
  for (const other of [
    { ...choice, serviceId: "different" },
    { ...choice, model: "other" },
    { ...choice, folder: "/another" },
    {
      ...choice,
      serviceSnapshot: {
        ...choice.serviceSnapshot,
        endpoint: "https://changed.example.test",
      },
    },
  ])
    assert.equal(authenticationRetryAllowed(result, other), false);
  assert.equal(result.model, "M");
  assert.equal(result.effort, "High");
  assert.match(result.lastAccessResult.message, /账号和模型可用性仍待检查/);
});

test("confirmed account handoff records only that account and leaves request validation outstanding", () => {
  let agent = start(accountRoute);
  agent = transition(transition(agent, "open"), "approve");
  const result = finish(agent);
  assert.equal(result.authentication.status, "flow-finished");
  assert.equal(result.authentication.accountService, "Selected Account");
  assert.equal(result.authentication.entitlement, "unknown");
  assert.equal(accountRequiredForSelection(result, choice), true);
  assert.equal(result.setupDraft.test, "idle");
});

test("known failure can end an unfinished interaction without manufacturing completion", () => {
  const agent = start(serviceRoute, "failed");
  const result = finish(agent);
  assert.equal(result.accessJob, null);
  assert.equal(result.lastAccessResult.status, "failed");
  assert.equal(result.authentication, undefined);
  assert.equal(authenticationRetryAllowed(result, choice), false);
});
