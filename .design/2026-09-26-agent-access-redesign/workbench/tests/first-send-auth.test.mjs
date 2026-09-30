import assert from "node:assert/strict";
import test from "node:test";
import {
  firstSendFailure,
  firstSendAuthDestination,
} from "../src/first-send-auth.js";
import {
  makeAttempt,
  admittedConversation,
  scopedAuthIssue,
} from "../src/workbench-state.js";
import { startAgentJob, advanceAgentJobs } from "../src/access-jobs.js";
import {
  accountRequiredForSelection,
  markAuthenticationForRetry,
} from "../src/authentication-state.js";

const agent = {
  id: "a",
  name: "Agent A",
  installed: true,
  connected: true,
  registered: true,
  connectionState: "connected",
  models: ["M"],
  model: "M",
};
const service = { id: "s", secretRevision: 3 };
const draft = {
  text: "Keep this exact input",
  files: ["notes.md"],
  folder: "/A",
  choice: {
    agent: "Agent A",
    agentId: "a",
    accessMode: "api",
    serviceId: "s",
    model: "M",
    effort: "High",
  },
};
const attempt = (outcome, changes = {}) =>
  makeAttempt({
    ...draft,
    service,
    outcome,
    id: "send-a",
    ...changes,
  });
const finishedTest = (outcome) => {
  let next = startAgentJob(
    agent,
    "test",
    {
      outcome,
      selection: {
        ...draft.choice,
        access: "api",
        folder: draft.folder,
        secretRevision: 3,
      },
    },
    0,
  );
  for (const now of [1000, 2000, 3000]) next = advanceAgentJobs([next], now)[0];
  return next;
};

test("first-send auth means Agent login even when API was chosen, preserves the whole draft and creates no history", () => {
  const input = attempt("auth");
  const snapshot = structuredClone(input);
  const failure = firstSendFailure(agent, input);
  assert.equal(admittedConversation(input), null);
  assert.equal(failure.layer, "agent");
  assert.equal(
    failure.rememberBlock,
    false,
    "Agent observations must not enter the API-key failure block",
  );
  assert.equal(failure.agent.serviceAuthIssues, undefined);
  assert.equal(
    accountRequiredForSelection(failure.agent, {
      ...draft.choice,
      folder: draft.folder,
    }),
    true,
  );
  assert.equal(firstSendAuthDestination(failure.agent, draft), "agent");
  assert.match(
    scopedAuthIssue({}, { ...draft, service }, failure.agent),
    /Agent 账号/,
  );
  assert.deepEqual(input, snapshot);
});

test("explicit service failures keep the API-key route and cannot be released by an Agent-login retry", () => {
  const input = attempt("service_auth");
  const failure = firstSendFailure(agent, input);
  assert.equal(admittedConversation(input), null);
  assert.equal(failure.layer, "service");
  assert.equal(failure.rememberBlock, true);
  assert.deepEqual(failure.agent.serviceAuthIssues, [
    { serviceId: "s", secretRevision: 3 },
  ]);
  assert.equal(
    accountRequiredForSelection(failure.agent, {
      ...draft.choice,
      folder: draft.folder,
    }),
    false,
  );
  assert.equal(firstSendAuthDestination(failure.agent, draft), "service");
  assert.deepEqual(
    markAuthenticationForRetry(failure.agent, "/A").serviceAuthIssues,
    failure.agent.serviceAuthIssues,
  );
});

test("first-send and short-test failures produce the same account or service observation", () => {
  for (const [sendOutcome, testOutcome] of [
    ["auth", "agent_auth_required"],
    ["service_auth", "service_auth_required"],
  ]) {
    const sent = firstSendFailure(agent, attempt(sendOutcome)).agent;
    const tested = finishedTest(testOutcome);
    assert.deepEqual(
      sent.authRequiredApiSelections,
      tested.authRequiredApiSelections,
    );
    assert.deepEqual(sent.serviceAuthIssues, tested.serviceAuthIssues);
  }
});

test("unknown authentication origin and a service result without an API selection never invent success or a key failure", () => {
  for (const input of [
    attempt("authentication_unknown"),
    attempt("service_auth", {
      choice: { ...draft.choice, accessMode: "existing" },
      service: null,
    }),
  ]) {
    const failure = firstSendFailure(agent, input);
    assert.equal(admittedConversation(input), null);
    assert.equal(failure.layer, "unknown");
    assert.equal(failure.agent, agent);
    assert.equal(failure.rememberBlock, false);
    assert.match(failure.message, /无法确认/);
  }
});

test("another service or folder is not forced to login, while a still-running auth operation returns to the Agent", () => {
  const failed = firstSendFailure(agent, attempt("auth")).agent;
  assert.equal(
    accountRequiredForSelection(failed, {
      ...draft.choice,
      serviceId: "other",
      folder: "/A",
    }),
    false,
  );
  assert.equal(
    accountRequiredForSelection(failed, { ...draft.choice, folder: "/B" }),
    false,
  );
  const busy = { ...agent, accessJob: { type: "auth", status: "unknown" } };
  assert.equal(firstSendAuthDestination(busy, draft), "agent");
  const retry = markAuthenticationForRetry(failed, {
    ...draft.choice,
    folder: "/A",
  });
  assert.equal(scopedAuthIssue({}, { ...draft, service }, retry), null);
  assert.equal(
    accountRequiredForSelection(retry, { ...draft.choice, folder: "/A" }),
    true,
    "retry permission is not successful login evidence",
  );
});
