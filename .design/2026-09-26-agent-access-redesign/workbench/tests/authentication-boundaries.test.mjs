import assert from "node:assert/strict";
import test from "node:test";
import {
  startAgentJob,
  continueAgentJob,
  advanceAgentJobs,
} from "../src/access-jobs.js";
import {
  accountRequiredForSelection,
  authenticationRequiredFor,
} from "../src/authentication-state.js";
import { setupChoiceIssue } from "../src/agent-setup-state.js";
import { accountRoute } from "../src/account-capabilities.js";
import {
  confirmOfficialAccountProgram,
  officialAccountProgramConfirmed,
  officialAccountRouteIssue,
  startOfficialAccountRoute,
} from "../src/official-account-route.js";

const method = { id: "browser", type: "agent", presentation: "browser" };
const seed = () => ({
  id: "claude-agent",
  name: "Claude Agent",
  installed: true,
  registered: true,
  connected: true,
  connectionState: "connected",
  command: "/only-the-connection-component",
  authMethods: [method],
  models: ["M"],
  model: "M",
  serviceCapabilities: { status: "implemented", formats: ["responses"] },
});
const service = {
  id: "s",
  name: "S",
  endpoint: "https://example.test/v1",
  format: "responses",
  models: ["M"],
  demoKey: true,
  secretRevision: 0,
};
const selection = { access: "api", serviceId: "s", model: "M", folder: "/A" };
const finish = (agent, now = 0) =>
  [1000, 2000, 3000].reduce(
    (current, elapsed) => advanceAgentJobs([current], now + elapsed)[0],
    agent,
  );
const fail = (outcome, choice = selection, agent = seed()) =>
  finish(startAgentJob(agent, "test", { outcome, selection: choice }, 0));

test("Agent-level API authentication failures do not accuse the service key", () => {
  for (const outcome of ["auth_required", "agent_auth_required"]) {
    const failed = fail(outcome);
    assert.equal(failed.serviceAuthIssues, undefined);
    assert.equal(failed.lastAccessResult.authenticationLayer, "agent");
    assert.equal(accountRequiredForSelection(failed, selection), true);
    assert.match(setupChoiceIssue(failed, selection, [service]), /Agent 账号/);
    assert.equal(
      accountRequiredForSelection(failed, { ...selection, serviceId: "other" }),
      false,
    );
    assert.equal(
      accountRequiredForSelection(failed, { ...selection, folder: "/B" }),
      false,
    );
    assert.equal(authenticationRequiredFor(failed, "/A"), false);
  }
});

test("a completed Agent login allows checking the same API source without replacing its key", () => {
  let agent = fail("agent_auth_required");
  agent = startAgentJob(agent, "auth", { authMethod: method, selection }, 3000);
  agent = continueAgentJob(agent, agent.accessJob.id, 3100);
  agent = finish(agent, 3100);
  assert.equal(agent.authentication.status, "flow-finished");
  assert.equal(accountRequiredForSelection(agent, selection), true);
  assert.equal(setupChoiceIssue(agent, selection, [service]), null);
  agent = finish(startAgentJob(agent, "test", { selection }, 6000), 6000);
  assert.equal(accountRequiredForSelection(agent, selection), false);
  assert.equal(agent.serviceAuthIssues, undefined);
});

test("service failure is explicit, isolated by service and credential, and not cleared by Agent login", () => {
  let agent = fail("service_auth_required");
  assert.equal(agent.lastAccessResult.authenticationLayer, "service");
  assert.equal(accountRequiredForSelection(agent, selection), false);
  assert.match(setupChoiceIssue(agent, selection, [service]), /更新.*密钥/);
  assert.equal(
    setupChoiceIssue(agent, selection, [{ ...service, secretRevision: 1 }]),
    null,
  );
  agent = startAgentJob(agent, "auth", { authMethod: method, selection }, 3000);
  agent = finish(continueAgentJob(agent, agent.accessJob.id, 3100), 3100);
  assert.match(setupChoiceIssue(agent, selection, [service]), /更新.*密钥/);
});

test("unknown authentication origin and service errors without a selected service never invent a key or account failure", () => {
  for (const [outcome, choice] of [
    ["authentication_unknown", selection],
    ["service_auth_required", { access: "existing", model: "M", folder: "/A" }],
    [
      "service_auth_required",
      { access: "existing", serviceId: "stale", model: "M", folder: "/A" },
    ],
  ]) {
    const agent = fail(outcome, choice);
    assert.equal(agent.lastAccessResult.status, "failed");
    assert.equal(agent.lastAccessResult.authenticationLayer, "unknown");
    assert.match(agent.lastAccessResult.message, /无法确认/);
    assert.equal(agent.serviceAuthIssues, undefined);
    assert.equal(accountRequiredForSelection(agent, choice), false);
  }
});

test("a successful retry clears only the observed Agent requirement for the tested API source", () => {
  const other = { ...selection, serviceId: "other" };
  let agent = fail("agent_auth_required");
  agent = fail("agent_auth_required", other, agent);
  agent = startAgentJob(agent, "auth", { authMethod: method, selection }, 3000);
  agent = finish(continueAgentJob(agent, agent.accessJob.id, 3100), 3100);
  agent = finish(startAgentJob(agent, "test", { selection }, 8000), 8000);
  assert.equal(accountRequiredForSelection(agent, selection), false);
  assert.equal(accountRequiredForSelection(agent, other), true);
  assert.equal(agent.serviceAuthIssues, undefined);
});

test("explicit authentication-layer metadata is retained without deriving it from source selection", () => {
  for (const layer of ["agent", "service", "unknown"]) {
    const agent = finish(
      startAgentJob(
        seed(),
        "test",
        {
          outcome: "auth_required",
          authenticationLayer: layer,
          selection,
        },
        0,
      ),
    );
    assert.equal(agent.lastAccessResult.authenticationLayer, layer);
    assert.equal(Boolean(agent.serviceAuthIssues?.length), layer === "service");
    assert.equal(
      accountRequiredForSelection(agent, selection),
      layer === "agent",
    );
  }
});

test("documentation routes require explicit matching program confirmation without inventing protocol methods", () => {
  const agent = { ...seed(), authMethods: [] };
  const routeId = "claude-subscription";
  assert.equal(accountRoute(agent, routeId).requiresProgramConfirmation, true);
  assert.equal(startOfficialAccountRoute(agent, routeId, { selection }), agent);
  assert.match(officialAccountRouteIssue(agent, routeId), /确认.*程序/);
  const confirmed = confirmOfficialAccountProgram(agent, routeId);
  assert.equal(officialAccountProgramConfirmed(confirmed, routeId), true);
  const started = startOfficialAccountRoute(confirmed, routeId, { selection });
  assert.equal(started.accessJob.authMethod.command, "claude");
  assert.deepEqual(started.authMethods, []);
  assert.deepEqual(started.accessJob.selection, selection);
  assert.equal(started.authentication, undefined);
});

test("changed route, command, or arguments require a fresh confirmation; unrelated operations cannot be overwritten", () => {
  const routeId = "claude-subscription";
  const confirmed = confirmOfficialAccountProgram(seed(), routeId);
  assert.equal(
    officialAccountProgramConfirmed(confirmed, "claude-console"),
    false,
  );
  for (const change of [{ command: "other" }, { args: ["auth", "other"] }]) {
    const edited = {
      ...confirmed,
      accountProgramConfirmation: {
        ...confirmed.accountProgramConfirmation,
        ...change,
      },
    };
    assert.equal(officialAccountProgramConfirmed(edited, routeId), false);
    assert.equal(startOfficialAccountRoute(edited, routeId), edited);
  }
  const busy = { ...confirmed, accessJob: { id: "pending", type: "test" } };
  assert.equal(confirmOfficialAccountProgram(busy, "claude-console"), busy);
  assert.equal(startOfficialAccountRoute(busy, routeId), busy);
});
