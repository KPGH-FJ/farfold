import { statusLabel } from "../src/data-v2.js";
import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_CATALOG } from "../src/agent-catalog.js";
import { startAgentJob, advanceAgentJobs } from "../src/access-jobs.js";
import {
  syncAccessTestTasks,
  actOnAccessTest,
  ACCESS_TEST_PROMPT,
} from "../src/access-test-tasks.js";

const service = {
  id: "one",
  name: "示例服务",
  endpoint: "https://example.test",
  format: "responses",
  secretRevision: 1,
  models: ["A"],
};
function started(outcome = "success", now = 0) {
  const agent = structuredClone(
    AGENT_CATALOG.find((item) => item.name === "Codex"),
  );
  return startAgentJob(
    agent,
    "test",
    {
      outcome,
      fingerprint: "fixed",
      selection: {
        access: "api",
        serviceId: "one",
        secretRevision: 1,
        folder: "位置A",
        model: "A",
        effort: "High",
      },
    },
    now,
  );
}

test("连接测试进入统一列表，身份按开始快照固定，不改其他任务", () => {
  const agent = started();
  const ordinary = {
    id: "ordinary",
    agent: "Codex",
    status: "running",
    draft: "保留输入",
  };
  let tasks = syncAccessTestTasks([ordinary], [agent], [service]);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, agent.accessJob.id);
  assert.equal(tasks[0].agentId, agent.id);
  assert.equal(tasks[0].prompt, ACCESS_TEST_PROMPT);
  assert.equal(tasks[0].simulatePending, false);
  assert.equal(tasks[1], ordinary);
  tasks = syncAccessTestTasks(
    tasks,
    [{ ...agent, model: "B" }],
    [{ ...service, endpoint: "https://changed.test" }],
  );
  assert.equal(tasks[0].model, "A");
  assert.equal(tasks[0].folder, "位置A");
  assert.equal(tasks[0].serviceSnapshot.endpoint, service.endpoint);
  assert.equal(syncAccessTestTasks(tasks, [agent], [service]), tasks);
});

test("统一对话批准对应同一次作业，完成记录和准备证据一起出现", () => {
  let agents = [started("approval")];
  const id = agents[0].accessJob.id;
  let tasks = syncAccessTestTasks([], agents, [service]);
  agents = advanceAgentJobs(agents, 700);
  agents = advanceAgentJobs(agents, 1400);
  tasks = syncAccessTestTasks(tasks, agents, [service]);
  assert.equal(tasks[0].status, "approval");
  agents = actOnAccessTest(agents, id, "approve", 1500);
  agents = advanceAgentJobs(agents, 2200);
  agents = advanceAgentJobs(agents, 2900);
  tasks = syncAccessTestTasks(tasks, agents, [service]);
  assert.equal(tasks[0].status, "done");
  assert.equal(agents[0].accessJob, null);
  assert.equal(agents[0].setupEvidence.model, "A");
  assert.equal(agents[0].lastAccessResult.id, id);
});

test("停止等待确认，未知只保留原作业；迟到记录控制不能取消新测试", () => {
  let agents = [started("unknown")];
  const id = agents[0].accessJob.id;
  let tasks = syncAccessTestTasks([], agents, [service]);
  agents = advanceAgentJobs(agents, 700);
  agents = advanceAgentJobs(agents, 1400);
  tasks = syncAccessTestTasks(tasks, agents, [service]);
  assert.equal(tasks[0].status, "unknown");
  agents = actOnAccessTest(agents, id, "approve", 1500);
  assert.equal(agents[0].accessJob.status, "unknown");
  agents = actOnAccessTest(agents, id, "confirm-stopped");
  tasks = syncAccessTestTasks(tasks, agents, [service]);
  assert.equal(tasks[0].status, "stopped");
  assert.notEqual(agents[0].setupDraft.test, "passed");
  const newer = started("success", 5000);
  assert.equal(actOnAccessTest([newer], id, "stop")[0], newer);
  let stopped = actOnAccessTest([newer], newer.accessJob.id, "stop", 5100);
  assert.equal(stopped[0].accessJob.status, "cancelling");
  stopped = advanceAgentJobs(stopped, 5800);
  assert.equal(stopped[0].lastAccessResult.status, "cancelled");
});

test("拒绝与失败不会制造成功回复，也不会启动普通任务预览", () => {
  let agents = [started("approval")];
  const id = agents[0].accessJob.id;
  let tasks = syncAccessTestTasks([], agents, [service]);
  agents = advanceAgentJobs(advanceAgentJobs(agents, 700), 1400);
  agents = actOnAccessTest(agents, id, "reject", 1500);
  agents = advanceAgentJobs(agents, 2200);
  tasks = syncAccessTestTasks(tasks, agents, [service]);
  assert.equal(tasks[0].accessTest.result, "cancelled");
  assert.equal(tasks[0].status, "stopped");
  assert.equal(tasks[0].simulatePending, false);
  const failed = started("failure", 3000);
  tasks = syncAccessTestTasks(tasks, [failed], [service]);
  agents = advanceAgentJobs(advanceAgentJobs([failed], 3700), 4400);
  tasks = syncAccessTestTasks(tasks, agents, [service]);
  assert.equal(tasks[0].accessTest.result, "failed");
  assert.equal(tasks[0].status, "failed");
});

test("普通失败、认证与权益失败均显示失败，保留具体原因而不伪装为用户停止", () => {
  for (const outcome of ["failure", "auth_required", "entitlement"]) {
    const agent = started(outcome);
    let tasks = syncAccessTestTasks([], [agent], [service]);
    const agents = advanceAgentJobs(advanceAgentJobs([agent], 700), 1400);
    tasks = syncAccessTestTasks(tasks, agents, [service]);
    assert.equal(agents[0].lastAccessResult.status, "failed");
    assert.equal(tasks[0].status, "failed", outcome);
    assert.equal(tasks[0].accessTest.result, "failed");
    assert.equal(tasks[0].accessTest.label, agents[0].lastAccessResult.message);
  }
});

test("连接测试失败在列表里展示可读状态", () => {
  assert.equal(statusLabel({ status: "failed" }), "未通过");
  assert.equal(statusLabel({ status: "stopped" }), "已停止");
});
