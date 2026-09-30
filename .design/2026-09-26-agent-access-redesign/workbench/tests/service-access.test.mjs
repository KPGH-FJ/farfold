import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_CATALOG } from "../src/agent-catalog.js";
import {
  compatibleServices,
  serviceChoiceIssue,
  serviceAccess,
  continuationIssue,
  selectedService,
  usesApi,
} from "../src/service-access.js";

const responses = {
  id: "r",
  name: "Responses",
  format: "responses",
  models: ["m"],
};
const chat = {
  id: "c",
  name: "Chat",
  format: "chat-completions",
  models: ["m"],
};
const services = [responses, chat];
const api = { accessMode: "api", serviceId: "r", model: "m" };
const byName = (name) => AGENT_CATALOG.find((agent) => agent.name === name);

test("Pi's declared formats do not grant an unimplemented service route", () => {
  const pi = byName("Pi");
  assert.deepEqual(compatibleServices(pi, services), []);
  assert.match(serviceChoiceIssue(api, pi, services), /尚未接通/);
  assert.equal(
    serviceChoiceIssue({ accessMode: "existing" }, pi, services),
    null,
  );
});
test("verified routes keep the supported formats available", () => {
  assert.deepEqual(
    compatibleServices(byName("Codex"), services).map((s) => s.id),
    ["r"],
  );
  assert.equal(compatibleServices(byName("OpenCode"), services).length, 2);
  assert.equal(serviceChoiceIssue(api, byName("Codex"), services), null);
});
test("edited formats, removed models and deleted services cannot pass a stale selection", () => {
  const codex = byName("Codex");
  assert.match(
    serviceChoiceIssue(api, codex, [{ ...responses, format: "messages" }]),
    /接口/,
  );
  assert.match(
    serviceChoiceIssue(api, codex, [{ ...responses, models: ["other"] }]),
    /来源已改变/,
  );
  assert.match(serviceChoiceIssue(api, codex, []), /来源已改变/);
});
test("only explicitly prepared proposal entries get a proposal route", () => {
  const proposal = {
    proposal: true,
    demoReady: true,
    apiFormats: ["responses"],
  };
  assert.equal(serviceAccess(proposal), "proposal");
  assert.equal(serviceChoiceIssue(api, proposal, services), null);
  assert.equal(serviceAccess({ ...proposal, proposal: false }), "unavailable");
  assert.equal(serviceAccess({ ...proposal, demoReady: false }), "unavailable");
});

const authenticatedService = {
  ...responses,
  endpoint: "https://example.test/v1",
  demoKey: true,
  secretRevision: 2,
};
const failedAgent = {
  ...byName("Codex"),
  serviceAuthIssues: [{ serviceId: responses.id, secretRevision: 2 }],
};
const boundChoice = {
  ...api,
  agent: "Codex",
  serviceSnapshot: structuredClone(authenticatedService),
};

test("a preparation authentication failure blocks both new and established requests", () => {
  assert.match(
    serviceChoiceIssue(boundChoice, failedAgent, [authenticatedService]),
    /认证失败/,
  );
  assert.match(
    continuationIssue(boundChoice, [authenticatedService], failedAgent),
    /认证失败/,
  );
});
test("authentication failures stay within the Agent and selected service", () => {
  assert.equal(
    serviceChoiceIssue(boundChoice, byName("OpenCode"), [authenticatedService]),
    null,
  );
  const other = { ...authenticatedService, id: "other" };
  assert.equal(
    serviceChoiceIssue(
      { ...boundChoice, serviceId: other.id, serviceSnapshot: other },
      failedAgent,
      [other],
    ),
    null,
  );
});
test("key rotation releases only the superseded secret without rewriting old history", () => {
  const rotated = { ...authenticatedService, secretRevision: 3 };
  assert.equal(serviceChoiceIssue(boundChoice, failedAgent, [rotated]), null);
  assert.equal(continuationIssue(boundChoice, [rotated], failedAgent), null);
  assert.equal(boundChoice.serviceSnapshot.secretRevision, 2);
  assert.deepEqual(failedAgent.serviceAuthIssues, [
    { serviceId: responses.id, secretRevision: 2 },
  ]);
});
test("renaming or changing non-secret revisions cannot clear explicit authentication failure", () => {
  const renamed = { ...authenticatedService, name: "Renamed", revision: 50 };
  assert.match(
    serviceChoiceIssue(boundChoice, failedAgent, [renamed]),
    /认证失败/,
  );
  assert.match(
    continuationIssue(boundChoice, [renamed], failedAgent),
    /认证失败/,
  );
});
test("records without a secret revision use the initial credential scope", () => {
  const service = { ...authenticatedService, secretRevision: undefined };
  const agent = {
    ...failedAgent,
    serviceAuthIssues: [{ serviceId: service.id, secretRevision: 0 }],
  };
  assert.match(serviceChoiceIssue(boundChoice, agent, [service]), /认证失败/);
});
test("explicit existing settings ignore residual API identifiers and failures", () => {
  const existing = { ...boundChoice, accessMode: "existing" };
  assert.equal(usesApi(existing), false);
  assert.equal(selectedService(existing, [authenticatedService]), undefined);
  assert.equal(
    serviceChoiceIssue(existing, failedAgent, [authenticatedService]),
    null,
  );
  assert.equal(continuationIssue(existing, [], failedAgent), null);
});
test("history source changes remain distinct from authentication failures", () => {
  const changed = {
    ...authenticatedService,
    endpoint: "https://other.test/v1",
  };
  assert.match(
    continuationIssue(boundChoice, [changed], failedAgent),
    /地址或接口/,
  );
});
