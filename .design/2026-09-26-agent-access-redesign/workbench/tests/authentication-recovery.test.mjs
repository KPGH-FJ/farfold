import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { AGENT_CATALOG } from "../src/agent-catalog.js";
import { normalizeAgent } from "../src/agent-setup-state.js";
import * as jobs from "../src/access-jobs.js";

const method = {
  id: "browser",
  type: "agent",
  presentation: "browser",
  label: "浏览器登录",
};
const selection = {
  access: "existing",
  folder: "/original",
  model: "6 Astra",
  effort: "High",
};
const waiting = (options = {}) =>
  jobs.startAgentJob(
    normalizeAgent({
      ...structuredClone(AGENT_CATALOG[0]),
      authMethods: [method],
    }),
    "auth",
    { authMethod: method, selection, ...options },
    100,
  );
const unknown = (options = {}) => {
  const agent = waiting(options);
  return {
    ...agent,
    accessJob: {
      ...agent.accessJob,
      status: "unknown",
      label: "登录结果尚未确认",
    },
  };
};
let server, Status;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    cacheDir: "/tmp/farfold-auth-recovery-cache",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  Status = (await server.ssrLoadModule("/src/access-job-status.jsx")).default;
});
after(async () => {
  await server?.close();
});
const render = (agent) =>
  renderToStaticMarkup(React.createElement(Status, { agent, onChange() {} }));

test("检查未知登录只读取现有进度，保留原操作和选择，不产生成功或新尝试", () => {
  const original = unknown();
  const checked = jobs.checkAuthenticationJob(
    original,
    original.accessJob.id,
    200,
  );
  assert.equal(checked.accessJob.id, original.accessJob.id);
  assert.equal(checked.accessJob.status, "unknown");
  assert.deepEqual(checked.accessJob.selection, original.accessJob.selection);
  assert.deepEqual(checked.accessJob.authMethod, method);
  assert.equal(checked.authentication, undefined);
  assert.equal(checked.lastAccessResult, null);
  assert.match(checked.accessJob.resultCheckNotice, /尚未收到新的登录结果/);
  assert.equal(jobs.advanceAgentJobs([checked], 1000000)[0], checked);
  assert.equal(
    jobs.startAgentJob(checked, "auth", { authMethod: method }, 300),
    checked,
  );
  assert.equal(
    jobs.checkAuthenticationJob(checked, "old-operation", 400),
    checked,
  );
});

test("结束未知登录请求沿用同一操作，并等待结束确认后才允许重试", () => {
  const original = unknown();
  const ending = jobs.endAuthenticationJob(
    original,
    original.accessJob.id,
    200,
  );
  assert.equal(ending.accessJob.id, original.accessJob.id);
  assert.equal(ending.accessJob.status, "cancelling");
  assert.deepEqual(ending.accessJob.selection, original.accessJob.selection);
  assert.deepEqual(ending.accessJob.authMethod, method);
  assert.equal(jobs.advanceAgentJobs([ending], 899)[0], ending);
  assert.equal(
    jobs.startAgentJob(ending, "auth", { authMethod: method }, 300),
    ending,
  );
  const ended = jobs.advanceAgentJobs([ending], 900)[0];
  assert.equal(ended.accessJob, null);
  assert.equal(ended.lastAccessResult.status, "cancelled");
  assert.equal(ended.lastAccessResult.id, original.accessJob.id);
  assert.equal(ended.authentication, undefined);
  assert.equal(
    jobs.endAuthenticationJob(original, "old-operation", 200),
    original,
  );
});

test("结束仍未知时保留操作，检查与重复结束都不会新增登录", () => {
  const original = unknown({ cancelOutcome: "unknown" });
  const ending = jobs.endAuthenticationJob(
    original,
    original.accessJob.id,
    200,
  );
  const unresolved = jobs.advanceAgentJobs([ending], 900)[0];
  assert.equal(unresolved.accessJob.status, "unknown");
  assert.equal(unresolved.accessJob.id, original.accessJob.id);
  assert.deepEqual(
    unresolved.accessJob.selection,
    original.accessJob.selection,
  );
  const checked = jobs.checkAuthenticationJob(
    unresolved,
    original.accessJob.id,
    1000,
  );
  assert.equal(checked.accessJob.status, "unknown");
  const secondEnd = jobs.endAuthenticationJob(
    checked,
    original.accessJob.id,
    1100,
  );
  assert.equal(secondEnd.accessJob.status, "cancelling");
  assert.equal(secondEnd.accessJob.id, original.accessJob.id);
  assert.equal(secondEnd.accessJob.resultCheckNotice, undefined);
  assert.equal(
    jobs.advanceAgentJobs([secondEnd], 1800)[0].accessJob.status,
    "unknown",
  );
});

test("未知和结束中的迟到结果仍归属原操作，旧操作结果不能完成新登录", () => {
  const original = unknown();
  for (const pending of [
    original,
    jobs.endAuthenticationJob(original, original.accessJob.id, 200),
  ]) {
    assert.equal(
      jobs.resolveAuthenticationJob(pending, "old-operation", 300),
      pending,
    );
    let completed = jobs.resolveAuthenticationJob(
      pending,
      original.accessJob.id,
      300,
    );
    assert.equal(completed.accessJob.id, original.accessJob.id);
    assert.equal(completed.accessJob.status, "running");
    assert.deepEqual(
      completed.accessJob.selection,
      original.accessJob.selection,
    );
    completed = jobs.advanceAgentJobs([completed], 1000)[0];
    completed = jobs.advanceAgentJobs([completed], 1700)[0];
    assert.equal(completed.accessJob, null);
    assert.equal(completed.lastAccessResult.status, "passed");
    assert.equal(completed.authentication.method, method.id);
    assert.equal(completed.authentication.folder, selection.folder);
  }
});

test("未知恢复动作不改变普通等待或其他类型任务", () => {
  const active = waiting();
  assert.equal(
    jobs.checkAuthenticationJob(active, active.accessJob.id, 200),
    active,
  );
  assert.equal(
    jobs.endAuthenticationJob(active, active.accessJob.id, 200),
    active,
  );
  const other = {
    ...active,
    accessJob: { ...active.accessJob, type: "test", status: "unknown" },
  };
  assert.equal(
    jobs.checkAuthenticationJob(other, other.accessJob.id, 200),
    other,
  );
  assert.equal(
    jobs.endAuthenticationJob(other, other.accessJob.id, 200),
    other,
  );
  assert.equal(jobs.cancelAgentJob(active, 200).accessJob.status, "cancelling");
  assert.equal(active.accessJob.label, "等待登录授权");
});

test("未知登录的检查与结束位于正常操作区，模拟回执保持折叠", () => {
  const html = render(unknown());
  const normalActions = html.split("<details>")[0];
  assert.ok(normalActions.includes("检查登录结果"));
  assert.ok(normalActions.includes("结束此次登录"));
  assert.match(html, /<details><summary>评审：模拟后续确认<\/summary>/);
  assert.ok(html.includes("模拟收到迟到的登录完成结果"));
  assert.ok(html.includes("模拟收到结束确认"));
  const normalWaiting = render(waiting());
  assert.ok(normalWaiting.includes("取消操作"));
  assert.ok(!normalWaiting.includes("检查登录结果"));
  assert.ok(!normalWaiting.includes("结束此次登录"));
});

test("拒绝登录显示对应说明，其他操作失败继续使用原文案", () => {
  const active = waiting();
  const failed = { ...jobs.continueAgentJob(active, active.accessJob.id, 200) };
  failed.accessJob = {
    ...failed.accessJob,
    outcome: "failed",
    failureMessage: "登录未完成：本次授权未获同意。可以重新登录。",
  };
  const result = jobs.advanceAgentJobs([failed], 900)[0];
  assert.equal(result.lastAccessResult.status, "failed");
  assert.equal(
    result.lastAccessResult.message,
    failed.accessJob.failureMessage,
  );
  const other = { ...failed, accessJob: { ...failed.accessJob, type: "test" } };
  assert.match(
    jobs.advanceAgentJobs([other], 900)[0].lastAccessResult.message,
    /模拟操作失败/,
  );
});
