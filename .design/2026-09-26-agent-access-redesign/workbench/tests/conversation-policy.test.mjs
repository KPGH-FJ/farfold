import test from "node:test";
import assert from "node:assert/strict";
import {
  applyConversationPatch,
  conversationState,
  requestPreviewEvent,
  recoveryPreviewEvent,
  feedbackKey,
  updateFeedback,
  takeFeedback,
} from "../src/conversation-policy.js";

const task = {
  id: "a",
  status: "done",
  agent: "Codex",
  source: "existing",
  model: "A",
  effort: "High",
  draft: "保留输入",
  queue: [],
};
test("首次接纳前可改；之后无确认回执不能改模型推理，Agent与来源固定", () => {
  const draft = { ...task, status: "draft" };
  assert.equal(applyConversationPatch(draft, { effort: "Low" }).effort, "Low");
  for (const status of ["running", "unknown", "done", "recovery"]) {
    const current = { ...task, status };
    const next = applyConversationPatch(current, {
      agent: "Other",
      model: "B",
      effort: "Low",
      source: "new",
    });
    for (const key of ["agent", "model", "effort", "source"])
      assert.equal(next[key], task[key]);
  }
});
test("缺失旧值需显式确认，已知值即使确认也不能覆盖", () => {
  const old = { ...task, effort: undefined };
  assert.equal(
    applyConversationPatch(old, { effort: "High" }).effort,
    undefined,
  );
  const confirmed = applyConversationPatch(old, {
    effort: "High",
    confirmMissingIdentity: true,
  });
  assert.equal(confirmed.effort, "High");
  assert.equal(
    applyConversationPatch(confirmed, {
      effort: "Low",
      confirmMissingIdentity: true,
    }).effort,
    "High",
  );
});
test("完成先于未知或通信错误，明确结果保持；旧请求结果不能影响当前工作", () => {
  const start = {
    ...task,
    status: "running",
    previewRequestId: "r",
    terminalConfirmed: false,
  };
  let complete = { ...start, ...requestPreviewEvent(start, "completed") };
  for (const type of ["unknown", "transport-error", "accepted"]) {
    complete = { ...complete, ...requestPreviewEvent(complete, type) };
    assert.equal(complete.status, "done");
    assert.equal(complete.admissionUnknown, false);
  }
  assert.equal(
    applyConversationPatch(complete, { status: "unknown" }).status,
    "done",
  );
  const unknown = { ...start, ...requestPreviewEvent(start, "unknown") };
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.draft, task.draft);
  assert.equal(
    requestPreviewEvent(start, "completed", "old").status,
    undefined,
  );
  assert.equal(requestPreviewEvent(unknown, "completed").status, "done");
});
test("停止未确认保留原审批问题并进入需要你；正常释放空闲连接不制造待办", () => {
  for (const status of ["approval", "question"]) {
    const pending = {
      ...task,
      status,
      answerDraft: { note: "原回答" },
      approvalAnswers: { a: "accept" },
    };
    for (const stopPhase of ["waiting", "unknown", "failed"]) {
      const next = applyConversationPatch(pending, {
        stopPhase,
        queuePaused: true,
      });
      assert.equal(next.status, status);
      assert.deepEqual(next.answerDraft, pending.answerDraft);
      assert.deepEqual(next.approvalAnswers, pending.approvalAnswers);
      assert.equal(conversationState(next).attention, true);
      assert.equal(conversationState(next).canArchive, false);
    }
  }
  assert.equal(
    conversationState({ ...task, connectionState: "released" }).idle,
    true,
  );
  assert.equal(
    conversationState({ ...task, status: "unknown" }).attention,
    true,
  );
  assert.equal(
    conversationState({ ...task, status: "running", connectionState: "lost" })
      .attention,
    true,
  );
  assert.equal(
    conversationState({ ...task, status: "submitting" }).canArchive,
    false,
  );
  assert.equal(
    conversationState({ ...task, queue: ["still pending"] }).canArchive,
    false,
  );
});
test("恢复回执和正文完整必须同时具备；失败空正文与旧通道保持不完整", () => {
  for (const order of [
    ["receipt", "partial", "body-complete", "identity-matched"],
    ["identity-matched", "partial", "body-complete", "receipt"],
  ]) {
    let current = {
      ...task,
      status: "recovery",
      recoveryRead: { id: "read", phase: "loading" },
      queue: ["keep"],
    };
    order.forEach((type, i) => {
      current = { ...current, ...recoveryPreviewEvent(current, type) };
      assert.equal(current.status, i < order.length - 1 ? "recovery" : "done");
      assert.equal(current.model, task.model);
      assert.equal(current.effort, task.effort);
      assert.deepEqual(current.queue, ["keep"]);
    });
    assert.equal(current.queuePaused, true);
  }
  for (const type of ["failed", "empty", "unsupported"]) {
    const original = {
      ...task,
      status: "recovery",
      recoveryRead: { id: "read", phase: "loading", receipt: true },
    };
    const failed = { ...original, ...recoveryPreviewEvent(original, type) };
    assert.equal(
      recoveryPreviewEvent(failed, "body-complete").status,
      "recovery",
    );
    assert.equal(recoveryPreviewEvent(failed, "body-complete", "old"), null);
  }
});
test("文件意见按对话、文件、内容版本隔离，加入输入不发送也不误清其他草稿", () => {
  const first = { path: "a.ts", after: "one", versionLabel: "第一版" };
  const second = { ...first, after: "two", versionLabel: "第二版" };
  const anotherFile = { ...first, path: "b.ts" };
  let a = { ...task };
  a = { ...a, ...updateFeedback(a, first, { text: "旧行意见", line: "8" }) };
  a = { ...a, ...updateFeedback(a, second, { text: "新内容意见" }) };
  a = { ...a, ...updateFeedback(a, anotherFile, { text: "别的文件" }) };
  assert.equal(Object.keys(a.feedbackDrafts).length, 3);
  assert.equal(task.feedbackDrafts, undefined);
  const patch = takeFeedback(a, feedbackKey(first));
  assert.match(patch.draft, /保留输入/);
  assert.match(patch.draft, /第一版，第 8 行/);
  assert.match(patch.draft, /旧行意见/);
  assert.equal(patch.status, undefined);
  assert.equal(patch.extraMessages, undefined);
  assert.equal(Object.keys(patch.feedbackDrafts).length, 2);
  assert.equal(patch.feedbackDrafts[feedbackKey(second)].text, "新内容意见");
});
