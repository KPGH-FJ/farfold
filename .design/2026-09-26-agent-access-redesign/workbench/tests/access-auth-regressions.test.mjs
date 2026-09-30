import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_CATALOG } from "../src/agent-catalog.js";
import {
  normalizeAgent,
  setupChoiceIssue,
  setupCompletionIssue,
  agentCanAttempt,
} from "../src/agent-setup-state.js";
import {
  startAgentJob,
  advanceAgentJobs,
  continueAgentJob,
  cancelAgentJob,
  confirmAgentJobStopped,
} from "../src/access-jobs.js";
import { canAttempt, scopedAuthIssue } from "../src/workbench-state.js";
import { draftForEntry } from "../src/setup-entry.js";
import {
  authenticationStartIssue,
  authenticationRetryAllowed,
  rememberAuthenticationRequirement,
  manualAuthenticationMethod,
} from "../src/authentication-state.js";
import {
  entitlementIssue,
  entitlementRetryAllowed,
  markEntitlementForRetry,
} from "../src/selection-entitlement.js";

const browser = {
  id: "browser",
  type: "agent",
  presentation: "browser",
  label: "账号授权",
};
const terminal = {
  id: "terminal",
  type: "terminal",
  presentation: "terminal",
  label: "登录程序",
};
const device = {
  id: "device",
  type: "agent",
  presentation: "device",
  label: "设备码",
  expiresInMs: 300000,
};
const seed = () =>
  normalizeAgent({
    ...structuredClone(AGENT_CATALOG[0]),
    authMethods: [browser, terminal, device],
  });
const selection = {
  access: "existing",
  folder: "/A",
  model: "6 Astra",
  effort: "High",
};
const choice = {
  agent: "Codex",
  accessMode: "existing",
  model: "6 Astra",
  effort: "High",
};
const finish = (agent, start = 0) => {
  for (let now = start + 1000; now <= start + 6000; now += 1000)
    agent = advanceAgentJobs([agent], now)[0];
  return agent;
};

test("同Agent认证等待、取消与未知均阻止所有发送入口，其他Agent不受影响", () => {
  const waiting = startAgentJob(
    seed(),
    "auth",
    { selection, authMethod: device },
    0,
  );
  const cases = [
    waiting,
    cancelAgentJob(waiting, 100),
    advanceAgentJobs([waiting], 300001)[0],
  ];
  for (const agent of cases) {
    assert.equal(canAttempt(agent), false);
    assert.equal(agentCanAttempt(agent), false);
    assert.match(
      scopedAuthIssue({}, { choice, folder: "/B" }, agent),
      /认证.*结束/,
    );
  }
  assert.equal(canAttempt({ ...seed(), id: "other", name: "Other" }), true);
});

test("认证成功后普通短测失败可直接重试；新的认证失败才收回重试资格", () => {
  const blocked = rememberAuthenticationRequirement(seed(), "/A");
  const active = startAgentJob(
    blocked,
    "auth",
    { selection, authMethod: browser },
    0,
  );
  const authorized = finish(continueAgentJob(active, active.accessJob.id, 1));
  const failed = finish(
    startAgentJob(authorized, "test", { selection, outcome: "failure" }, 10000),
    10000,
  );
  assert.equal(authenticationRetryAllowed(failed, selection), true);
  assert.equal(setupChoiceIssue(failed, selection, []), null);
  assert.equal(
    setupCompletionIssue(failed, selection, []),
    null,
    "允许返回草稿，由实际请求验证",
  );
  assert.equal(failed.setupDraft.test, "failed", "返回许可不能抹掉失败结果");
  const retry = startAgentJob(
    failed,
    "test",
    { selection, outcome: "auth_required" },
    20000,
  );
  assert.equal(retry.accessJob.type, "test");
  const authFailed = finish(retry, 20000);
  assert.equal(authenticationRetryAllowed(authFailed, selection), false);
  assert.match(setupChoiceIssue(authFailed, selection, []), /认证/);
});

test("权限不足按Agent、位置、来源和模型限制准备与发送；明确修复后仅允许验证重试", () => {
  const failed = finish(
    startAgentJob(seed(), "test", { selection, outcome: "entitlement" }, 0),
  );
  assert.match(entitlementIssue(failed, selection), /权限或额度/);
  assert.match(setupCompletionIssue(failed, selection, []), /权限或额度/);
  assert.match(
    scopedAuthIssue({}, { choice, folder: "/A" }, failed),
    /权限或额度/,
  );
  assert.doesNotMatch(failed.lastAccessResult.message, /账号已确认/);
  for (const changed of [
    { ...selection, folder: "/B" },
    { ...selection, model: "5.6 Sol" },
    { ...selection, access: "api", serviceId: "other" },
  ])
    assert.equal(entitlementIssue(failed, changed), null);
  assert.equal(entitlementIssue({ ...failed, id: "other" }, selection), null);
  assert.ok(
    entitlementIssue(failed, { ...selection, effort: "Low" }),
    "降低推理等级不能绕过同模型权益错误",
  );
  assert.equal(startAgentJob(failed, "test", { selection }, 10000), failed);
  const repaired = markEntitlementForRetry(failed, selection);
  assert.equal(entitlementRetryAllowed(repaired, selection), true);
  assert.equal(setupChoiceIssue(repaired, selection, []), null);
  assert.equal(setupCompletionIssue(repaired, selection, []), null);
  assert.equal(scopedAuthIssue({}, { choice, folder: "/A" }, repaired), null);
  assert.ok(
    entitlementIssue(repaired, selection),
    "允许显式尝试不抹掉未验证的权益失败",
  );
  const networkFailed = finish(
    startAgentJob(repaired, "test", { selection, outcome: "failure" }, 10000),
    10000,
  );
  assert.equal(entitlementRetryAllowed(networkFailed, selection), true);
  const done = finish(
    startAgentJob(networkFailed, "test", { selection }, 20000),
    20000,
  );
  assert.equal(entitlementIssue(done, selection), null);
  assert.equal(setupCompletionIssue(done, selection, []), null);
});

test("API权益错误区分服务与密钥修订，改名不解除，同服务重新声明失败保留限制", () => {
  const service = { id: "s", secretRevision: 1, name: "Service" };
  const api = {
    ...selection,
    access: "api",
    serviceId: "s",
    secretRevision: 1,
    model: "M",
  };
  let failed = finish(
    startAgentJob(
      seed(),
      "test",
      { selection: api, outcome: "entitlement" },
      0,
    ),
  );
  assert.ok(entitlementIssue(failed, api, { ...service, name: "Renamed" }));
  assert.equal(
    entitlementIssue(failed, api, { ...service, secretRevision: 2 }),
    null,
  );
  assert.equal(
    entitlementIssue(
      failed,
      { ...api, serviceId: "other" },
      { ...service, id: "other" },
    ),
    null,
  );
  const repaired = markEntitlementForRetry(failed, api, service);
  failed = finish(
    startAgentJob(
      repaired,
      "test",
      { selection: api, outcome: "entitlement" },
      10000,
    ),
    10000,
  );
  assert.equal(entitlementRetryAllowed(failed, api, service), false);
  assert.ok(entitlementIssue(failed, api, service));
});

test("暂离认证后跨位置进入只恢复认证操作快照，不改新入口草稿", () => {
  const waiting = startAgentJob(
    seed(),
    "auth",
    { selection, authMethod: browser },
    0,
  );
  const other = { ...choice, model: "5.6 Sol" };
  const resumed = draftForEntry(waiting, [], other, {
    view: "new",
    folder: "/B",
  });
  assert.equal(resumed.folder, "/A");
  assert.equal(resumed.model, "6 Astra");
  assert.equal(resumed.access, "existing");
  resumed.model = "mutated";
  assert.equal(waiting.accessJob.selection.model, "6 Astra");
  assert.equal(other.model, "5.6 Sol");
});

test("认证前置在状态层拒绝未添加、未连接、依赖缺失和未声明方式", () => {
  for (const invalid of [
    { ...seed(), installed: false },
    { ...seed(), registered: false },
    { ...seed(), added: false },
    { ...seed(), connected: false, connectionState: "idle" },
    { ...seed(), dependenciesMissing: true },
  ]) {
    assert.ok(authenticationStartIssue(invalid, browser));
    assert.equal(
      startAgentJob(invalid, "auth", { authMethod: browser }),
      invalid,
    );
  }
  const agent = seed();
  assert.ok(
    authenticationStartIssue(agent, { id: "undeclared", type: "agent" }),
  );
  assert.equal(
    startAgentJob(agent, "auth", { authMethod: { id: "undeclared" } }),
    agent,
  );
  assert.ok(authenticationStartIssue(agent, browser, 1));
  assert.equal(authenticationStartIssue(agent, browser), null);
  const manual = manualAuthenticationMethod("demo-login", "login");
  assert.equal(
    authenticationStartIssue({ ...agent, authMethods: [] }, manual),
    null,
  );
  assert.ok(
    authenticationStartIssue(agent, { ...manual, command: "bad;command" }),
  );
});

test("仅明确声明期限的方式会过期，浏览器和终端没有通用五分钟超时", () => {
  for (const method of [browser, terminal]) {
    const waiting = startAgentJob(
      seed(),
      "auth",
      { selection, authMethod: method },
      0,
    );
    assert.equal(waiting.accessJob.expiresAt, undefined);
    assert.equal(
      advanceAgentJobs([waiting], 600001)[0].accessJob.status,
      "waiting",
    );
  }
  const waiting = startAgentJob(
    seed(),
    "auth",
    { selection, authMethod: device },
    0,
  );
  assert.equal(waiting.accessJob.expiresAt, 300000);
  assert.equal(
    advanceAgentJobs([waiting], 300001)[0].accessJob.status,
    "unknown",
  );
  assert.equal(
    continueAgentJob(waiting, waiting.accessJob.id, 300001).accessJob.status,
    "unknown",
    "刷新间隙的过期确认同样不能成功",
  );
  const stopped = confirmAgentJobStopped(
    advanceAgentJobs([waiting], 300001)[0],
    waiting.accessJob.id,
  );
  assert.equal(stopped.accessJob, null);
});
