import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_CATALOG } from "../src/agent-catalog.js";
import {
  normalizeAgent,
  setupChoiceIssue,
  setupCompletionIssue,
} from "../src/agent-setup-state.js";
import { serviceSelectionSnapshot } from "../src/service-access.js";
import {
  beginRegistration,
  registrationTransition,
} from "../src/registration-state.js";
import {
  startAgentJob,
  advanceAgentJobs,
  cancelAgentJob,
  resolveAuthenticationJob,
} from "../src/access-jobs.js";
import {
  rememberAuthenticationRequirement,
  markAuthenticationForRetry,
} from "../src/authentication-state.js";
import { scopedAuthIssue } from "../src/workbench-state.js";
const agent = () => normalizeAgent(structuredClone(AGENT_CATALOG[0]));
const service = {
  id: "api",
  name: "Source A",
  endpoint: "https://a.example/v1",
  format: "responses",
  models: ["M"],
  demoKey: true,
  secretRevision: 1,
};
const draft = {
  access: "api",
  serviceId: "api",
  model: "M",
  serviceSnapshot: serviceSelectionSnapshot(service),
};

test("API only requests an Agent account when the verified capability and explicit failure both require it", () => {
  const requiring = rememberAuthenticationRequirement(
    {
      ...agent(),
      serviceCapabilities: {
        status: "implemented",
        formats: ["responses"],
        requiresAgentAuthentication: true,
      },
    },
    "/A",
  );
  const choice = { ...draft, accessMode: "api", folder: "/A" };
  assert.match(setupChoiceIssue(requiring, choice, [service]), /Agent 账号/);
  assert.match(
    scopedAuthIssue({}, { choice, folder: "/A", service }, requiring),
    /Agent 账号/,
  );
  const retry = markAuthenticationForRetry(requiring, choice);
  assert.equal(setupCompletionIssue(retry, choice, [service]), null);
  assert.equal(
    scopedAuthIssue({}, { choice, folder: "/A", service }, retry),
    null,
  );
  const direct = {
    ...requiring,
    serviceCapabilities: {
      ...requiring.serviceCapabilities,
      requiresAgentAuthentication: false,
    },
  };
  assert.equal(setupChoiceIssue(direct, choice, [service]), null);
  assert.equal(
    scopedAuthIssue({}, { choice, folder: "/A", service }, direct),
    null,
  );
});

test("L01: saving changed source never authorizes a prepared draft; explicit snapshot confirmation restores eligibility", () => {
  const changed = {
    ...service,
    endpoint: "https://b.example/v1",
    secretRevision: 2,
  };
  assert.match(setupChoiceIssue(agent(), draft, [changed]), /来源/);
  assert.match(setupCompletionIssue(agent(), draft, [changed]), /来源/);
  assert.equal(
    setupChoiceIssue(
      agent(),
      { ...draft, serviceSnapshot: serviceSelectionSnapshot(changed) },
      [changed],
    ),
    null,
  );
  assert.equal(
    setupChoiceIssue(agent(), draft, [
      { ...service, name: "Renamed", secretRevision: 2 },
    ]),
    null,
  );
  assert.equal(draft.serviceSnapshot.endpoint, service.endpoint);
});
test("registration completion, leaving and retrying never mutate selection or produce authentication/key claims", () => {
  const target = { folder: "/A", ...draft };
  let registration = beginRegistration({
    accountLabel: "Example",
    methodId: "browser",
    selection: target,
  });
  target.folder = "/B";
  assert.equal(registration.status, "ready");
  assert.equal(registrationTransition(registration, "fail"), registration);
  registration = registrationTransition(registration, "start");
  registration = registrationTransition(registration, "fail");
  assert.equal(registration.status, "failed");
  registration = registrationTransition(
    registrationTransition(registration, "return"),
    "resume",
  );
  assert.equal(registration.selection.folder, "/A");
  registration = registrationTransition(
    registrationTransition(registration, "retry"),
    "registered",
  );
  assert.equal(registration.status, "registered");
  assert.equal(registration.authentication, undefined);
  assert.equal(registration.demoKey, undefined);
  assert.equal(registration.entitlement, undefined);
  assert.equal(
    registrationTransition(registration, "key-issued"),
    registration,
  );
});
test("API existing-account route with a verified destination skips registration without saving a credential or implying service availability", () => {
  let registration = beginRegistration({
    kind: "api",
    accountLabel: "API service",
    destination: { verified: true, url: "https://example.test/signup" },
  });
  assert.equal(
    registrationTransition(registration, "key-issued"),
    registration,
  );
  registration = registrationTransition(registration, "existing-account");
  assert.equal(registration.existingAccount, true);
  registration = registrationTransition(registration, "key-issued");
  assert.equal(registration.status, "key-issued");
  assert.equal(registration.demoKey, undefined);
});
test("L03: unknown cancellation retains the operation and late result updates only its own result, never a new attempt", () => {
  const selection = { access: "existing", folder: "/A", model: "6 Astra" };
  let pending = startAgentJob(
    agent(),
    "auth",
    { authMethod: agent().authMethods[0], selection, cancelOutcome: "unknown" },
    0,
  );
  const id = pending.accessJob.id;
  pending = advanceAgentJobs([cancelAgentJob(pending, 1)], 1000)[0];
  assert.equal(pending.accessJob.status, "unknown");
  assert.equal(resolveAuthenticationJob(pending, "old-id", 2000), pending);
  pending = resolveAuthenticationJob(pending, id, 2000);
  for (let time = 3000; time < 7000; time += 1000)
    pending = advanceAgentJobs([pending], time)[0];
  assert.equal(pending.accessJob, null);
  assert.equal(pending.authentication.status, "flow-finished");
  assert.equal(pending.authentication.entitlement, "unknown");
  assert.notEqual(pending.setupDraft.test, "passed");
  assert.equal(resolveAuthenticationJob(pending, id, 8000), pending);
  assert.equal(setupCompletionIssue(pending, selection, []), null);
});
