import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgent } from "../src/agent-setup-state.js";
import { advanceAgentJobs, cancelAgentJob } from "../src/access-jobs.js";
import {
  needsAutomaticProgramCheck,
  startProgramChange,
  removeAgentAccess,
  uninstallUnusedProgram,
  removableInstallations,
  authenticationTypeLabel,
  agentAccountIdentity,
  setupSelectionChanged,
} from "../src/agent-redesign-state.js";
const sample = () =>
  normalizeAgent({
    id: "sample",
    name: "示例",
    installed: true,
    registered: true,
    connected: true,
    selectedInstallationId: "old",
    installations: [
      { id: "old", path: "/owned/program", managed: true, version: "1" },
      {
        id: "external",
        path: "/external/program",
        managed: false,
        version: "2",
      },
    ],
    sourceId: "service",
    serviceId: "service",
    setupDraft: { access: "api", serviceId: "service", model: "A" },
  });
function finish(agent) {
  for (let i = 0; i < 8; i++)
    agent = advanceAgentJobs([agent], Date.now() + 1000 * (i + 1))[0];
  return agent;
}

test("automatic program checking only applies to an idle admitted program and never advances authentication", () => {
  const agent = { ...sample(), connected: false, connectionState: "idle" };
  assert.equal(needsAutomaticProgramCheck(agent), true);
  for (const patch of [
    { removed: true },
    { registered: false },
    { dependenciesMissing: true },
    { connected: true },
    { connectionState: "failed" },
    { connectionState: "unknown" },
    { accessJob: { status: "unknown" } },
  ])
    assert.equal(needsAutomaticProgramCheck({ ...agent, ...patch }), false);
  assert.equal(needsAutomaticProgramCheck(agent, 1), false);
  assert.equal(agent.authentication, undefined);
});

test("program update closes only idle connection and failed or cancelled candidates preserve selection and service", () => {
  const old = sample();
  for (const result of [
    finish(startProgramChange(old, "install", { outcome: "failure" })),
    finish(cancelAgentJob(startProgramChange(old, "install"))),
  ]) {
    assert.equal(result.selectedInstallationId, "old");
    assert.deepEqual(result.installations, old.installations);
    assert.equal(result.serviceId, "service");
    assert.equal(result.accessJob, null);
  }
  assert.equal(startProgramChange(old, "install", { busyCount: 1 }), old);
  const unknown = { ...old, connectionState: "unknown" };
  assert.equal(startProgramChange(unknown, "install"), unknown);
});

test("default removal revokes selected service while preserving programs and credentials elsewhere", () => {
  const old = sample(),
    removed = removeAgentAccess(old);
  assert.equal(removed.removed, true);
  assert.equal(removed.connected, false);
  assert.equal(removed.serviceId, null);
  assert.equal(removed.setupDraft, undefined);
  assert.deepEqual(removed.installations, old.installations);
  assert.equal(old.serviceId, "service");
});

test("optional uninstall never accepts external or shared programs; in-flight work blocks removal", () => {
  const old = sample();
  assert.equal(removeAgentAccess(old, { uninstallIds: ["external"] }), old);
  const other = {
    id: "other",
    registered: true,
    command: "/owned/program/run",
  };
  assert.deepEqual(removableInstallations(old, [other]), []);
  assert.equal(
    removeAgentAccess(old, { allAgents: [other], uninstallIds: ["old"] }),
    old,
  );
  assert.equal(removeAgentAccess(old, { busyCount: 1 }), old);
  const removed = removeAgentAccess(old, { uninstallIds: ["old"] });
  assert.deepEqual(
    removed.installations.map((item) => item.id),
    ["external"],
  );
});

test("identity and authentication type are explicit evidence, never inferred from provider or official labels", () => {
  assert.equal(
    agentAccountIdentity({ authentication: { accountService: "服务 A" } }),
    "Agent 未提供身份信息",
  );
  assert.equal(
    agentAccountIdentity(
      {
        authentication: { accountEmail: "demo@example.invalid", folder: "/a" },
      },
      "/b",
    ),
    "Agent 未提供身份信息",
  );
  assert.equal(
    agentAccountIdentity(
      {
        authentication: { accountEmail: "demo@example.invalid", folder: "/a" },
      },
      "/a",
    ),
    "demo@example.invalid",
  );
  assert.equal(
    authenticationTypeLabel({ type: "terminal", label: "API Key" }),
    "终端登录",
  );
  assert.equal(authenticationTypeLabel({ label: "API Key" }), "类型未提供");
});

test("exit protection compares source model reasoning and endpoint changes, ignoring optional test progress", () => {
  const current = {
    access: "api",
    serviceId: "a",
    model: "A",
    effort: "High",
    serviceSnapshot: { endpoint: "a" },
  };
  assert.equal(
    setupSelectionChanged(current, { ...current, test: "passed" }),
    false,
  );
  for (const change of [
    { serviceId: "b" },
    { model: "B" },
    { effort: "Low" },
    { serviceSnapshot: { endpoint: "b" } },
  ])
    assert.equal(
      setupSelectionChanged(current, { ...current, ...change }),
      true,
    );
});

test("unused managed version cleanup keeps current connection access service and history settings, and rechecks protections", () => {
  const old = sample();
  old.installations.push({
    id: "unused",
    path: "/owned/previous",
    version: "0",
    managed: true,
  });
  old.history = ["keep-history"];
  const cleaned = uninstallUnusedProgram(old, "unused");
  assert.deepEqual(cleaned, {
    ...old,
    installations: old.installations.filter((item) => item.id !== "unused"),
  });
  assert.equal(cleaned.connected, true);
  assert.equal(cleaned.selectedInstallationId, "old");
  assert.equal(cleaned.registered, true);
  for (const id of ["old", "external", "missing"])
    assert.equal(uninstallUnusedProgram(old, id), old);
  assert.equal(uninstallUnusedProgram(old, "unused", { busyCount: 1 }), old);
  const working = { ...old, accessJob: { status: "running" } };
  assert.equal(uninstallUnusedProgram(working, "unused"), working);
  const unknown = { ...old, connectionState: "unknown" };
  assert.equal(uninstallUnusedProgram(unknown, "unused"), unknown);
  const referenced = [
    { id: "other", registered: true, command: "/owned/previous/run" },
  ];
  assert.equal(
    uninstallUnusedProgram(old, "unused", { allAgents: referenced }),
    old,
  );
  const inUse = {
    ...old,
    installations: old.installations.map((item) =>
      item.id === "unused" ? { ...item, inUse: true } : item,
    ),
  };
  assert.equal(uninstallUnusedProgram(inUse, "unused"), inUse);
});
