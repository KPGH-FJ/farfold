import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_CATALOG, catalogState } from "../src/agent-catalog.js";
import {
  agentCanAttempt,
  busyAgentTasks,
  initialSetupDraft,
  normalizeAgent,
  preparedAgent,
  reconcileAgentServices,
  serviceConversations,
  setupChoiceIssue,
  setupFingerprint,
} from "../src/agent-setup-state.js";
import {
  advanceAgentJobs,
  cancelAgentJob,
  confirmAgentJobStopped,
  programAction,
  startAgentJob,
} from "../src/access-jobs.js";
const seed = () => normalizeAgent(structuredClone(AGENT_CATALOG[0]));
const disconnected = () => programAction(seed(), "disconnect");
const service = (changes = {}) => ({
  id: "one",
  name: "API",
  endpoint: "https://a.example/v1",
  format: "responses",
  models: ["a"],
  demoKey: true,
  revision: 1,
  secretRevision: 0,
  ...changes,
});
function finish(agent) {
  let agents = [agent];
  for (let now = 1000; now <= 6000; now += 1000)
    agents = advanceAgentJobs(agents, now);
  return agents[0];
}

test("normal drafting can attempt existing settings without account claims or a mandatory preparation test", () => {
  const agent = seed();
  const draft = initialSetupDraft(agent, []);
  assert.equal(draft.access, "existing");
  assert.equal(draft.account, undefined);
  assert.equal(draft.test, "idle");
  assert.equal(agentCanAttempt(agent), true);
  assert.equal(initialSetupDraft({ ...agent, model: "" }, []).model, "");
  assert.equal(
    initialSetupDraft({ ...agent, accessMode: "account" }, []).access,
    "existing",
  );
});
test("discovery does not silently add an Agent, including a removed catalog entry", () => {
  const discovered = normalizeAgent(catalogState(AGENT_CATALOG[0], []));
  assert.equal(discovered.added, false);
  assert.equal(discovered.registered, false);
  assert.equal(discovered.installed, false);
  assert.equal(discovered.installations.length, 1);
  const added = programAction(discovered, "register");
  assert.equal(added.registered, true);
  assert.equal(added.connected, false);
  const removed = programAction(added, "remove");
  assert.equal(catalogState(AGENT_CATALOG[0], [removed]).added, false);
});
test("installation candidate only replaces the selected program after compatibility and end confirmation", () => {
  const old = disconnected();
  const candidate = startAgentJob(old, "install", {}, 0);
  const intermediate = advanceAgentJobs([candidate], 1000)[0];
  assert.equal(intermediate.selectedInstallationId, old.selectedInstallationId);
  assert.equal(intermediate.installations.length, old.installations.length);
  const result = finish(candidate);
  assert.notEqual(result.selectedInstallationId, old.selectedInstallationId);
  assert.equal(result.installations.length, old.installations.length + 1);
  assert.equal(result.connected, false);
  assert.equal(result.programRevision, old.programRevision + 1);
});
test("candidate failures and confirmed cancellation retain the previous selected program", () => {
  const old = disconnected();
  for (const result of [
    finish(startAgentJob(old, "install", { outcome: "failure" }, 0)),
    finish(cancelAgentJob(startAgentJob(old, "install", {}, 0), 10)),
  ]) {
    assert.equal(result.selectedInstallationId, old.selectedInstallationId);
    assert.deepEqual(result.installations, old.installations);
    assert.equal(result.accessJob, null);
  }
});
test("cancellation is not completion and unknown cleanup blocks another program change", () => {
  const old = disconnected();
  const running = startAgentJob(
    old,
    "install",
    { cancelOutcome: "unknown" },
    0,
  );
  const cancelling = cancelAgentJob(running, 10);
  assert.equal(cancelling.accessJob.status, "cancelling");
  const unknown = advanceAgentJobs([cancelling], 1000)[0];
  assert.equal(unknown.accessJob.status, "unknown");
  assert.equal(startAgentJob(unknown, "install"), unknown);
  assert.equal(programAction(unknown, "remove"), unknown);
  const same = [unknown];
  assert.equal(advanceAgentJobs(same, 999999), same);
  assert.equal(confirmAgentJobStopped(unknown, "old-attempt"), unknown);
  const stopped = confirmAgentJobStopped(unknown, unknown.accessJob.id);
  assert.equal(stopped.selectedInstallationId, old.selectedInstallationId);
  assert.equal(stopped.accessJob, null);
});
test("connection, necessary dependencies, and authentication remain separate from installation", () => {
  const missing = { ...disconnected(), dependenciesMissing: true };
  assert.equal(startAgentJob(missing, "connect"), missing);
  const fixed = finish(startAgentJob(missing, "dependency", {}, 0));
  assert.equal(fixed.dependenciesMissing, false);
  assert.equal(fixed.connected, false);
  const connected = finish(startAgentJob(fixed, "connect", {}, 0));
  assert.equal(connected.connected, true);
  assert.equal(connected.authentication, undefined);
  assert.equal(connected.setupComplete, false);
});
test("independent Agent jobs progress in parallel and unchanged arrays retain identity", () => {
  const a = disconnected();
  const b = { ...disconnected(), id: "other", name: "Other" };
  const jobs = [
    startAgentJob(a, "install", { outcome: "unknown" }, 0),
    startAgentJob(b, "connect", {}, 0),
  ];
  assert.equal(advanceAgentJobs(jobs, 1), jobs);
  let result = jobs;
  for (let now = 1000; now <= 5000; now += 1000)
    result = advanceAgentJobs(result, now);
  assert.equal(result[0].accessJob.status, "unknown");
  assert.equal(result[1].connected, true);
  assert.equal(
    busyAgentTasks(a, [{ agentId: "other", agent: a.name, status: "running" }])
      .length,
    0,
  );
});
test("destructive actions protect only this Agent's active work, all response and stop states included", () => {
  const agent = disconnected();
  const tasks = [
    "running",
    "submitting",
    "approval",
    "question",
    "stopping",
    "stopUnconfirmed",
    "unknown",
    "done",
  ].map((status) => ({ agentId: agent.id, status }));
  assert.equal(busyAgentTasks(agent, tasks).length, 7);
  assert.equal(programAction(agent, "remove", null, 1), agent);
  assert.equal(startAgentJob(agent, "install", { busyCount: 1 }), agent);
  const connected = seed();
  assert.equal(startAgentJob(connected, "install"), connected);
  assert.equal(programAction(connected, "remove"), connected);
});
test("drafts, recovery requests and finished work do not block an Agent account change", () => {
  const agent = seed();
  const tasks = ["draft", "recovery", "done", "stopped", "failed"].map(
    (status) => ({
      id: status,
      agentId: agent.id,
      status,
    }),
  );
  assert.deepEqual(busyAgentTasks(agent, tasks), []);
  const mixed = [
    ...tasks,
    { id: "uncertain", agentId: agent.id, status: "unknown" },
  ];
  assert.deepEqual(
    busyAgentTasks(agent, mixed).map((task) => task.id),
    ["uncertain"],
  );
});
test("disconnect/remove/uninstall have different effects and external/selected/in-use installs stay protected", () => {
  const agent = disconnected();
  agent.installations = [
    ...agent.installations,
    { id: "managed", managed: true, path: "/demo/old", version: "old" },
    { id: "busy", managed: true, inUse: true, path: "/demo/busy" },
  ];
  assert.equal(
    programAction(agent, "uninstall", agent.selectedInstallationId),
    agent,
  );
  assert.equal(programAction(agent, "uninstall", "busy"), agent);
  assert.equal(
    programAction(agent, "uninstall", "managed").installations.length,
    2,
  );
  const removed = programAction(agent, "remove");
  assert.equal(removed.removed, true);
  assert.equal(removed.installed, true);
  assert.equal(removed.selectedInstallationId, null);
  assert.deepEqual(removed.installations, agent.installations);
  assert.equal(
    programAction(removed, "uninstall", agent.installations[0].id),
    removed,
  );
});
test("service deletion/revision invalidates completed evidence without disconnecting work or overwriting a pending choice", () => {
  const agent = seed();
  const draft = {
    access: "api",
    serviceId: "one",
    model: "a",
    effort: "High",
    test: "passed",
  };
  draft.testFingerprint = setupFingerprint(agent, draft, [service()]);
  const prepared = preparedAgent(agent, draft, [service()]);
  prepared.setupDraft = { access: "existing", model: "6 Astra", test: "idle" };
  const original = [prepared];
  assert.equal(
    reconcileAgentServices(original, [service({ name: "renamed" })]),
    original,
  );
  for (const changed of [
    [],
    [service({ revision: 2 })],
    [service({ secretRevision: 1 })],
    [service({ models: [] })],
  ]) {
    const result = reconcileAgentServices(original, changed)[0];
    assert.equal(result.connected, true);
    assert.equal(result.setupComplete, false);
    assert.equal(result.setupDraft.access, "existing");
  }
});
test("program, connection, model, effort and secret revisions scope preparation evidence", () => {
  const agent = seed();
  const draft = { access: "api", serviceId: "one", model: "a", effort: "High" };
  const old = setupFingerprint(agent, draft, [service()]);
  for (const changed of [
    { ...agent, programRevision: 1 },
    { ...agent, connectionRevision: 1 },
  ])
    assert.notEqual(setupFingerprint(changed, draft, [service()]), old);
  assert.notEqual(
    setupFingerprint(agent, { ...draft, effort: "Ultra" }, [service()]),
    old,
  );
  assert.notEqual(
    setupFingerprint(agent, draft, [service({ secretRevision: 1 })]),
    old,
  );
});
test("API authentication errors stay on their selected service and credential revision", () => {
  const agent = seed();
  const draft = {
    access: "api",
    serviceId: "one",
    secretRevision: 0,
    model: "a",
  };
  const failed = finish(
    startAgentJob(
      agent,
      "test",
      { outcome: "service_auth_required", selection: draft },
      0,
    ),
  );
  assert.equal(failed.authRequired, false);
  assert.equal(failed.serviceAuthIssues[0].serviceId, "one");
  assert.ok(setupChoiceIssue(failed, draft, [service()]).includes("认证失败"));
  assert.equal(
    setupChoiceIssue(failed, draft, [service({ secretRevision: 1 })]),
    null,
  );
  assert.equal(
    setupChoiceIssue(failed, { ...draft, serviceId: "two" }, [
      service({ id: "two" }),
    ]),
    null,
  );
  assert.equal(
    setupChoiceIssue(failed, { access: "existing", model: "6 Astra" }, []),
    null,
  );
  assert.equal(
    setupChoiceIssue({ ...agent, authRequired: true }, draft, [service()]),
    null,
  );
});
test("service impact is identified by saved identity, not an unrelated same-name record", () => {
  const tasks = [
    { id: "yes", serviceId: "one" },
    { id: "legacy", source: "API" },
    { id: "other", serviceId: "two", source: "API" },
    { id: "existing", accessMode: "existing", source: "API" },
  ];
  assert.deepEqual(
    serviceConversations(service(), tasks).map((item) => item.id),
    ["yes", "legacy"],
  );
});

test("independent short tests may run while this Agent has a pending conversation; destructive actions and authentication remain guarded", () => {
  const agent = seed();
  const draft = { access: "existing", model: "6 Astra", effort: "High" };
  const fingerprint = setupFingerprint(agent, draft, []);
  const testing = startAgentJob(
    agent,
    "test",
    { busyCount: 1, selection: draft, fingerprint },
    0,
  );
  assert.equal(testing.accessJob.type, "test");
  const done = finish(testing);
  assert.equal(done.setupDraft.test, "passed");
  assert.equal(done.connectionRevision, agent.connectionRevision);
  assert.equal(done.selectedInstallationId, agent.selectedInstallationId);
  assert.equal(done.connected, agent.connected);
  assert.equal(startAgentJob(agent, "auth", { busyCount: 1 }), agent);
  assert.equal(programAction(agent, "disconnect", null, 1), agent);
});

test("A then B authentication failures remain source-scoped when returning to A or rotating one credential", () => {
  const draft = {
    access: "api",
    serviceId: "one",
    secretRevision: 0,
    model: "a",
  };
  const fail = (agent, selection) =>
    finish(
      startAgentJob(
        agent,
        "test",
        { outcome: "service_auth_required", selection },
        0,
      ),
    );
  const failedA = fail(seed(), draft);
  const failedBoth = fail(failedA, { ...draft, serviceId: "two" });
  assert.equal(failedBoth.serviceAuthIssues.length, 2);
  for (const id of ["one", "two"]) {
    assert.ok(
      setupChoiceIssue(failedBoth, { ...draft, serviceId: id }, [
        service({ id }),
      ]).includes("认证失败"),
    );
  }
  assert.equal(
    setupChoiceIssue(failedBoth, draft, [service({ secretRevision: 1 })]),
    null,
  );
  const succeededA = finish(
    startAgentJob(
      failedBoth,
      "test",
      { selection: { ...draft, secretRevision: 1 } },
      0,
    ),
  );
  assert.ok(
    setupChoiceIssue(succeededA, { ...draft, serviceId: "two" }, [
      service({ id: "two" }),
    ]).includes("认证失败"),
  );
  assert.equal(
    setupChoiceIssue(succeededA, draft, [service({ secretRevision: 1 })]),
    null,
  );
  assert.equal(
    fail(failedBoth, draft).serviceAuthIssues.length,
    2,
    "repeat failure does not duplicate the same source revision",
  );
});

test("saving an explicit API selection without a short test does not repeatedly revoke the selection", () => {
  const input = seed();
  const draft = {
    access: "api",
    serviceId: "one",
    model: "a",
    effort: "High",
    folder: "/A",
    test: "idle",
  };
  const selected = preparedAgent(input, draft, [service()]);
  const items = [selected];
  assert.equal(reconcileAgentServices(items, [service()]), items);
  assert.equal(
    reconcileAgentServices(items, [service({ revision: 2 })])[0].setupComplete,
    false,
  );
});
test("uninstall protects another access referencing the managed path through command, arguments, environment or selected installation", () => {
  const base = disconnected();
  const item = {
    id: "shared-old",
    managed: true,
    path: "/demo/managed-program",
    version: "old",
  };
  base.installations = [...base.installations, item];
  for (const reference of [
    { command: "/demo/managed-program/bin/agent" },
    { args: ["/demo/managed-program/component"] },
    { env: { PROGRAM_PATH: "/demo/managed-program" } },
    {
      selectedInstallationId: "selected",
      installations: [{ id: "selected", path: "/demo/managed-program/agent" }],
    },
  ]) {
    const other = {
      id: "other",
      name: "Another",
      registered: true,
      ...reference,
    };
    assert.equal(
      programAction(base, "uninstall", item.id, 0, {
        allAgents: [base, other],
      }),
      base,
    );
  }
  const unrelated = {
    id: "other",
    registered: true,
    command: "/demo/managed-program-extra",
  };
  assert.ok(
    !programAction(base, "uninstall", item.id, 0, {
      allAgents: [unrelated],
    }).installations.some((entry) => entry.id === item.id),
  );
});

test("a successful explicit connection keeps registration and sidebar membership consistent", () => {
  const prior = { ...disconnected(), added: false };
  const connected = finish(startAgentJob(prior, "connect", {}, 0));
  assert.equal(connected.connected, true);
  assert.equal(connected.registered, true);
  assert.equal(connected.added, true);
  assert.equal(connected.authentication, undefined);
  const failed = finish(
    startAgentJob(prior, "connect", { outcome: "failure" }, 0),
  );
  assert.equal(failed.added, false);
  assert.equal(failed.connected, false);
});
