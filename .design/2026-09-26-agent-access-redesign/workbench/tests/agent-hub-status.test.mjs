import test from "node:test";
import assert from "node:assert/strict";
import { agentHubStatus } from "../src/agent-hub-status.js";
import { agentCanAttempt } from "../src/agent-setup-state.js";

const connected = {
  installed: true,
  connected: true,
  connectionState: "connected",
  registered: true,
  onboardingComplete: true,
};
const service = { id: "team", secretRevision: 2 };
const apiFailure = { serviceId: "team", secretRevision: 2 };

test("a folder-specific account failure is a partial warning, not global unavailability", () => {
  const agent = {
    ...connected,
    authRequired: true,
    authRequiredContext: "/project-a",
    authRequiredContexts: ["/project-a"],
  };
  assert.deepEqual(agentHubStatus(agent), {
    label: "部分工作需要登录",
    ready: false,
  });
  assert.equal(agentCanAttempt(agent), true);
});

test("context observations and legacy ordinary-conversation observations remain visible", () => {
  for (const observation of [
    { authRequiredContexts: ["/project-a"] },
    { authRequiredContexts: [""] },
    { authRequired: true },
  ]) {
    assert.equal(
      agentHubStatus({ ...connected, ...observation }).label,
      "部分工作需要登录",
    );
  }
});

test("API authentication failures name the affected service category, not Agent login", () => {
  const agent = { ...connected, serviceAuthIssues: [apiFailure] };
  assert.deepEqual(agentHubStatus(agent, [service]), {
    label: "部分 API 服务需要更新密钥",
    ready: false,
  });
  assert.equal(agentCanAttempt(agent), true);
});

test("Agent login observations on a live API source remain scoped account warnings", () => {
  for (const folder of ["", "/project-a"]) {
    const agent = {
      ...connected,
      authRequiredApiSelections: [JSON.stringify([folder, service.id])],
    };
    assert.deepEqual(agentHubStatus(agent, [service]), {
      label: "部分工作需要登录",
      ready: false,
    });
    assert.equal(agentCanAttempt(agent), true);
  }
});

test("API-scoped Agent login observations ignore missing or deleting services and invalid scopes", () => {
  const agent = {
    ...connected,
    authRequiredApiSelections: [JSON.stringify(["/project-a", service.id])],
  };
  for (const services of [
    [],
    [{ ...service, id: "other" }],
    [{ ...service, deleting: true }],
  ]) {
    assert.deepEqual(agentHubStatus(agent, services), {
      label: "已连接",
      ready: true,
    });
  }
  assert.deepEqual(
    agentHubStatus(
      { ...connected, authRequiredApiSelections: ["invalid", "null", "{}"] },
      [service],
    ),
    { label: "已连接", ready: true },
  );
});

test("rotating an API key does not erase its separate Agent login requirement", () => {
  const agent = {
    ...connected,
    authRequiredApiSelections: [JSON.stringify(["/project-a", service.id])],
    serviceAuthIssues: [apiFailure],
  };
  assert.equal(
    agentHubStatus(agent, [service]).label,
    "部分工作需要检查账号或 API 密钥",
  );
  assert.equal(
    agentHubStatus(agent, [{ ...service, secretRevision: 3 }]).label,
    "部分工作需要登录",
  );
});

test("deleted services, other service IDs and replaced keys do not retain a warning", () => {
  const agent = { ...connected, serviceAuthIssues: [apiFailure] };
  for (const services of [
    [],
    [{ ...service, id: "other" }],
    [{ ...service, secretRevision: 3 }],
    [{ ...service, deleting: true }],
  ]) {
    assert.deepEqual(agentHubStatus(agent, services), {
      label: "已连接",
      ready: true,
    });
  }
});

test("account and service requirements coexist without implying every route is blocked", () => {
  assert.equal(
    agentHubStatus(
      { ...connected, authRequired: true, serviceAuthIssues: [apiFailure] },
      [service],
    ).label,
    "部分工作需要检查账号或 API 密钥",
  );
});

test("active operations and program failures take priority over scoped authentication warnings", () => {
  const agent = { ...connected, authRequired: true };
  for (const [state, label] of [
    [{ accessJob: { label: "连接中" }, removed: true }, "连接中"],
    [{ removed: true }, "已移除接入"],
    [{ dependenciesMissing: true }, "缺少必要程序"],
    [{ connectionState: "failed" }, "连接失败"],
    [{ connectionState: "unknown" }, "连接状态待确认"],
    [{ connectionState: "connecting" }, "连接中"],
  ]) {
    assert.deepEqual(agentHubStatus({ ...agent, ...state }), {
      label,
      ready: false,
    });
  }
});

test("unaffected directory states retain their existing meaning", () => {
  for (const [agent, label, ready] of [
    [connected, "已连接", true],
    [{ registered: true }, "已添加", false],
    [{ installations: [{ id: "local" }] }, "本机发现", false],
    [{}, "尚未安装", false],
  ]) {
    assert.deepEqual(agentHubStatus(agent), { label, ready });
  }
});

test("a connection without first preparation completion is visible but not ready for a new conversation", () => {
  const unconfirmed = { ...connected, onboardingComplete: false };
  assert.deepEqual(agentHubStatus(unconfirmed), {
    label: "程序已连接 · 接入未完成",
    ready: false,
  });
  assert.equal(agentCanAttempt(unconfirmed), true);
  assert.deepEqual(
    agentHubStatus({ ...unconfirmed, authRequiredContexts: ["/project-a"] }),
    { label: "部分工作需要登录", ready: false },
  );
});
