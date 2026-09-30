import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_CATALOG } from "../src/agent-catalog.js";
import {
  normalizeAgent,
  initialSetupDraft,
  setupChoiceIssue,
  setupCompletionIssue,
  setupFingerprint,
} from "../src/agent-setup-state.js";
import {
  authenticationRequiredFor,
  authenticationRetryAllowed,
  markAuthenticationForRetry,
  manualAuthenticationIssue,
  manualAuthenticationMethod,
} from "../src/authentication-state.js";
import {
  advanceAgentJobs,
  cancelAgentJob,
  confirmAgentJobStopped,
  continueAgentJob,
  startAgentJob,
} from "../src/access-jobs.js";
const agent = () =>
  normalizeAgent({
    ...structuredClone(AGENT_CATALOG[0]),
    authMethods: [method],
  });
const method = {
  id: "terminal",
  type: "terminal",
  presentation: "terminal",
  label: "交互式登录",
};
const start = () =>
  startAgentJob(
    {
      ...agent(),
      authRequired: true,
      setupDraft: { access: "existing", model: "6 Astra", test: "idle" },
    },
    "auth",
    { authMethod: method },
    0,
  );

test("authentication is an action within the existing source and does not produce another source or model success", () => {
  const waiting = start();
  assert.equal(waiting.setupDraft.access, "existing");
  assert.equal(waiting.accessJob.status, "waiting");
  let agents = [continueAgentJob(waiting, waiting.accessJob.id, 100)];
  agents = advanceAgentJobs(agents, 1000);
  agents = advanceAgentJobs(agents, 2000);
  const complete = agents[0];
  assert.equal(complete.authentication.status, "flow-finished");
  assert.equal(
    complete.lastAccessResult.message,
    "登录步骤已结束，模型可用性仍待检查。",
  );
  assert.equal(complete.authentication.entitlement, "unknown");
  assert.equal(
    complete.authRequired,
    true,
    "flow completion is still awaiting a model check",
  );
  assert.equal(authenticationRetryAllowed(complete, ""), true);
  assert.equal(complete.connected, true);
  assert.equal(complete.setupComplete, false);
  assert.equal(complete.setupDraft.test, "idle");
  assert.equal(initialSetupDraft(complete).access, "existing");
});
test("leaving a component does not own or cancel the pending authentication action", () => {
  const waiting = start();
  const restored = structuredClone(waiting);
  const items = [restored];
  assert.equal(advanceAgentJobs(items, 10000), items);
  assert.equal(restored.accessJob.id, waiting.accessJob.id);
  assert.equal(restored.accessJob.authMethod.id, "terminal");
  assert.equal(
    startAgentJob(restored, "auth", { authMethod: { id: "browser" } }),
    restored,
  );
});
test("late authentication confirmations cannot complete a cancelled or superseded operation", () => {
  const waiting = start();
  const oldId = waiting.accessJob.id;
  const cancelled = advanceAgentJobs([cancelAgentJob(waiting, 100)], 1000)[0];
  assert.equal(continueAgentJob(cancelled, oldId), cancelled);
  assert.equal(cancelled.authRequired, true);
  const next = startAgentJob(cancelled, "auth", { authMethod: method }, 2000);
  assert.notEqual(next.accessJob.id, oldId);
  assert.equal(continueAgentJob(next, oldId), next);
});
test("authentication timeout preserves unknown end state and requires explicit confirmation", () => {
  const device = {
    id: "device",
    type: "agent",
    presentation: "device",
    expiresInMs: 300000,
  };
  const waiting = startAgentJob(
    { ...agent(), authMethods: [device], authRequired: true },
    "auth",
    { authMethod: device },
    0,
  );
  const expired = advanceAgentJobs([waiting], 300001)[0];
  assert.equal(expired.accessJob.status, "unknown");
  assert.equal(expired.authRequired, true);
  assert.equal(startAgentJob(expired, "auth", { authMethod: method }), expired);
  const ended = confirmAgentJobStopped(expired, expired.accessJob.id);
  assert.equal(ended.accessJob, null);
  assert.equal(ended.authRequired, true);
});
test("reconnect failure after the authentication action never claims successful preparation", () => {
  const waiting = startAgentJob(
    { ...agent(), authRequired: true },
    "auth",
    { authMethod: method, outcome: "failure" },
    0,
  );
  const checking = continueAgentJob(waiting, waiting.accessJob.id, 100);
  const failed = advanceAgentJobs([checking], 1000)[0];
  assert.equal(failed.lastAccessResult.status, "failed");
  assert.equal(failed.authRequired, true);
  assert.equal(failed.authentication, undefined);
});

const finish = (input) => {
  let result = input;
  for (let now = 1000; now <= 6000; now += 1000)
    result = advanceAgentJobs([result], now)[0];
  return result;
};
test("starting another authentication immediately invalidates old success, including failure and cancellation", () => {
  const draft = {
    access: "existing",
    folder: "/A",
    model: "6 Astra",
    effort: "High",
    test: "passed",
  };
  const base = agent();
  draft.testFingerprint = setupFingerprint(base, draft, []);
  const prepared = {
    ...base,
    setupComplete: true,
    setupEvidence: draft,
    setupDraft: draft,
  };
  for (const outcome of ["failure", "cancel"]) {
    let active = startAgentJob(
      prepared,
      "auth",
      {
        selection: draft,
        authMethod: method,
        outcome: outcome === "failure" ? "failure" : "success",
      },
      0,
    );
    assert.equal(active.setupDraft.test, "idle");
    assert.equal(active.setupEvidence, null);
    assert.equal(active.setupComplete, false);
    active =
      outcome === "cancel"
        ? cancelAgentJob(active, 1)
        : continueAgentJob(active, active.accessJob.id, 1);
    const ended = finish(active);
    assert.notEqual(ended.setupDraft.test, "passed");
    assert.equal(ended.setupDraft.testFingerprint, null);
  }
});
test("external configuration allows checks in that location without declaring it verified", () => {
  const a = {
    access: "existing",
    folder: "/A",
    model: "6 Astra",
    effort: "High",
  };
  const b = { ...a, folder: "/B" };
  let input = agent();
  for (const selection of [a, b])
    input = finish(
      startAgentJob(input, "test", { selection, outcome: "auth_required" }, 0),
    );
  assert.equal(authenticationRequiredFor(input, "/A"), true);
  assert.equal(authenticationRequiredFor(input, "/B"), true);
  const pending = markAuthenticationForRetry({ ...input, authMethods: [] }, a);
  assert.equal(authenticationRequiredFor(pending, "/A"), true);
  assert.equal(pending.setupComplete, false);
  assert.equal(setupChoiceIssue(pending, a, []), null);
  assert.equal(
    setupCompletionIssue(pending, a, []),
    null,
    "外部设置完成后可以返回草稿，由用户显式发送来检查",
  );
  assert.equal(pending.authentication.status, "needs-check");
  assert.ok(setupChoiceIssue(pending, b, []));
  const fingerprint = setupFingerprint(pending, a, []);
  const active = startAgentJob(
    pending,
    "test",
    { selection: a, fingerprint },
    0,
  );
  assert.equal(
    authenticationRetryAllowed(active, a),
    true,
    "执行中的检查仍受作业保护，普通失败不会要求再次登录",
  );
  const checked = finish(active);
  assert.equal(authenticationRequiredFor(checked, "/A"), false);
  assert.equal(authenticationRequiredFor(checked, "/B"), true);
  assert.equal(setupCompletionIssue(checked, a, []), null);
  assert.equal(checked.setupEvidence.folder, "/A");
  assert.equal(checked.lastAccessResult.folder, "/A");
  assert.equal(checked.lastAccessResult.fingerprint, fingerprint);
  assert.notEqual(
    setupFingerprint(checked, a, []),
    setupFingerprint(checked, b, []),
  );
});
test("explicit manual authentication carries only user-chosen simulated command, arguments and variable name", () => {
  assert.ok(manualAuthenticationIssue("demo-login; rm", ""));
  assert.ok(manualAuthenticationIssue("demo-login", "token=real-secret"));
  assert.ok(manualAuthenticationIssue("demo-login", "", "KEY=value"));
  const manual = manualAuthenticationMethod(
    "/demo/login-program",
    "login\n--example",
    "EXAMPLE_KEY",
  );
  assert.deepEqual(manual.args, ["login", "--example"]);
  assert.equal(manual.secretVariable, "EXAMPLE_KEY");
  assert.equal(manual.secret, undefined);
  const active = startAgentJob(
    { ...agent(), authMethods: [] },
    "auth",
    { authMethod: manual, selection: { access: "existing", folder: "/A" } },
    0,
  );
  assert.equal(active.accessJob.status, "waiting");
  assert.equal(active.manualAuthentication.command, "/demo/login-program");
  const ended = finish(continueAgentJob(active, active.accessJob.id, 1));
  assert.equal(authenticationRetryAllowed(ended, "/A"), true);
  assert.equal(authenticationRetryAllowed(ended, "/B"), false);
  assert.equal(ended.setupComplete, false);
});
