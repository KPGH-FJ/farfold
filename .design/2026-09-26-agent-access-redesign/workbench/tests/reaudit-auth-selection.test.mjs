import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_CATALOG } from "../src/agent-catalog.js";
import { normalizeAgent, setupChoiceIssue } from "../src/agent-setup-state.js";
import {
  accountRequiredForSelection,
  authenticationRetryAllowed,
  markAuthenticationForRetry,
  rememberAgentAuthenticationRequirement,
} from "../src/authentication-state.js";
import {
  startAgentJob,
  continueAgentJob,
  advanceAgentJobs,
} from "../src/access-jobs.js";
import {
  entitlementIssue,
  rememberEntitlementFailure,
  markEntitlementForRetry,
} from "../src/selection-entitlement.js";
import { agentHubStatus } from "../src/agent-hub-status.js";
import * as firstSend from "../src/first-send-auth.js";

const seed = () => normalizeAgent(structuredClone(AGENT_CATALOG[0]));
const services = ["A", "B"].map((id) => ({
  id,
  name: id,
  endpoint: `https://${id}.example`,
  format: "responses",
  models: ["M", "N"],
  demoKey: true,
  secretRevision: 1,
}));
const selection = (id = "A") => ({
  access: "api",
  serviceId: id,
  folder: "/work",
  model: "M",
  effort: "High",
  serviceSnapshot: { ...services.find((service) => service.id === id) },
});
const finish = (agent) => {
  for (let time = 1000; time < 6000; time += 1000)
    agent = advanceAgentJobs([agent], time)[0];
  return agent;
};

test("login for one exact choice cannot release another known authentication failure", () => {
  let agent = rememberAgentAuthenticationRequirement(
    rememberAgentAuthenticationRequirement(seed(), selection()),
    selection("B"),
  );
  agent = startAgentJob(
    agent,
    "auth",
    { authMethod: agent.authMethods[0], selection: selection() },
    0,
  );
  agent = finish(continueAgentJob(agent, agent.accessJob.id, 1));
  assert.equal(setupChoiceIssue(agent, selection(), services), null);
  for (const changed of [
    selection("B"),
    { ...selection(), model: "N" },
    { ...selection(), effort: "Ultra" },
    { ...selection(), folder: "/other" },
    {
      ...selection(),
      serviceSnapshot: { ...selection().serviceSnapshot, secretRevision: 2 },
    },
  ]) {
    assert.equal(authenticationRetryAllowed(agent, changed), false);
  }
  assert.match(setupChoiceIssue(agent, selection("B"), services), /账号认证/);
  assert.equal(
    startAgentJob(agent, "test", { selection: selection("B") }),
    agent,
  );
});

test("explicit external repair grants only the selected source and legacy folder grants never unlock an API", () => {
  const base = rememberAgentAuthenticationRequirement(
    rememberAgentAuthenticationRequirement(seed(), selection()),
    selection("B"),
  );
  const repaired = markAuthenticationForRetry(base, selection());
  assert.equal(authenticationRetryAllowed(repaired, selection()), true);
  assert.equal(authenticationRetryAllowed(repaired, selection("B")), false);
  const legacy = { ...base, authenticationRetryContexts: ["/work"] };
  assert.equal(authenticationRetryAllowed(legacy, selection()), false);
  assert.equal(authenticationRetryAllowed(legacy, selection("B")), false);
  const local = {
    access: "existing",
    folder: "/work",
    model: "6 Astra",
    effort: "High",
  };
  const retainedLocal = { ...legacy, setupDraft: local };
  assert.equal(authenticationRetryAllowed(retainedLocal, local), true);
  assert.equal(
    authenticationRetryAllowed(retainedLocal, { ...local, model: "5.6 Sol" }),
    false,
  );
  assert.equal(
    authenticationRetryAllowed(retainedLocal, { ...local, folder: "/other" }),
    false,
  );
});

test("successful first send settles only matching authentication and entitlement observations", () => {
  assert.equal(typeof firstSend.settleSuccessfulFirstSend, "function");
  const choice = {
    agent: "Codex",
    accessMode: "existing",
    model: "6 Astra",
    effort: "High",
  };
  const selected = { ...choice, folder: "/work" };
  const other = { ...choice, folder: "/other" };
  let agent = rememberAgentAuthenticationRequirement(
    rememberAgentAuthenticationRequirement(seed(), selected),
    other,
  );
  agent = markEntitlementForRetry(
    rememberEntitlementFailure(agent, selected),
    selected,
  );
  agent = markAuthenticationForRetry(agent, selected);
  const attempt = {
    outcome: "success",
    draft: { choice, folder: "/work" },
    service: null,
  };
  const settled = firstSend.settleSuccessfulFirstSend(agent, attempt);
  assert.equal(accountRequiredForSelection(settled, selected), false);
  assert.equal(authenticationRetryAllowed(settled, selected), false);
  assert.equal(entitlementIssue(settled, selected), null);
  assert.equal(accountRequiredForSelection(settled, other), true);
  for (const outcome of ["unknown", "agent_auth", "rejected"])
    assert.equal(
      firstSend.settleSuccessfulFirstSend(agent, { ...attempt, outcome }),
      agent,
    );
  assert.equal(
    firstSend.settleSuccessfulFirstSend(
      { ...agent, name: "Other", id: "other" },
      attempt,
    ).authRequired,
    true,
  );
  const only = rememberAgentAuthenticationRequirement(seed(), selected);
  assert.equal(
    agentHubStatus(firstSend.settleSuccessfulFirstSend(only, attempt)).label,
    "可以使用",
  );
});
