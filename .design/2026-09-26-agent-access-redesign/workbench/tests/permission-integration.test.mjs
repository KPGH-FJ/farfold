import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_CATALOG,
  permissionCapabilityFor,
  permissionSelectionFor,
} from "../src/agent-catalog.js";
import { makeAttempt, admittedConversation } from "../src/workbench-state.js";
import {
  previewConversationBlocked,
  canReleasePreviewQueue,
  previewQueueGate,
} from "../src/conversation-state.js";
import {
  conversationState,
  applyConversationPatch,
} from "../src/conversation-policy.js";
import { restorePrototypeSnapshot } from "../src/prototype-persistence.js";

const agent = AGENT_CATALOG.find((item) => item.permissionCapability);
const choice = {
  agent: agent.name,
  model: "original",
  effort: "High",
  permissionValue: "read-only",
};
test("权限能力仅来自提供的样例；其他目录与明确空能力不制造三档", () => {
  assert.equal(
    permissionCapabilityFor({ id: "custom", name: agent.name }),
    null,
  );
  assert.equal(
    permissionCapabilityFor({ ...agent, permissionCapability: null }),
    null,
  );
  assert.equal(
    permissionCapabilityFor(
      AGENT_CATALOG.find((item) => item.id === "opencode"),
    ),
    null,
  );
});
test("首次请求保留所选权限；发送签名仍对应用户草稿", () => {
  const attempt = makeAttempt({
    text: "test",
    files: [],
    folder: "",
    choice,
    permission: permissionSelectionFor(agent, choice),
    id: "permission",
    outcome: "success",
  });
  const task = admittedConversation(attempt);
  assert.equal(task.permissionValue, "read-only");
  assert.deepEqual(task.permissionCapability, agent.permissionCapability);
  assert.deepEqual(JSON.parse(attempt.signature).choice, choice);
});
test("更改中与未确认权限阻止发送、待发和归档；恢复后不自动释放", () => {
  for (const phase of ["pending", "unknown"]) {
    const task = {
      status: "done",
      permissionChange: { phase },
      queue: [{ id: "q", text: "draft" }],
      queuePaused: false,
    };
    assert.equal(previewConversationBlocked(task), true);
    assert.equal(canReleasePreviewQueue(task), false);
    assert.equal(conversationState(task).canArchive, false);
    const paused = { ...task, ...previewQueueGate(task, {}) };
    assert.equal(paused.queuePaused, true);
    assert.equal(
      canReleasePreviewQueue({ ...paused, permissionChange: null }),
      false,
    );
  }
});
test("权限回包只更改权限，不替换固定选择或回应审批", () => {
  const task = {
    ...choice,
    status: "done",
    source: "existing",
    permissionValue: "agent",
    approvalAnswers: {},
    queuePaused: true,
  };
  const next = applyConversationPatch(task, {
    permissionValue: "read-only",
    model: "other",
    effort: "Low",
  });
  assert.equal(next.permissionValue, "read-only");
  assert.equal(next.model, "original");
  assert.equal(next.effort, "High");
  assert.deepEqual(next.approvalAnswers, {});
  assert.equal(next.queuePaused, true);
});
test("权限请求中重启保留旧值并标为未确认，不能伪造完成", () => {
  const state = restorePrototypeSnapshot({
    version: 6,
    tasks: [
      {
        id: "p",
        status: "done",
        permissionValue: "read-only",
        permissionChange: { phase: "pending", requestedValue: "agent" },
      },
    ],
    draft: { text: "保留", files: [], choice },
    agents: [],
  });
  assert.equal(state.tasks[0].permissionValue, "read-only");
  assert.equal(state.tasks[0].permissionChange.phase, "unknown");
  assert.equal(conversationState(state.tasks[0]).attention, true);
  assert.equal(previewConversationBlocked(state.tasks[0]), true);
  assert.equal(state.draft.text, "保留");
});
