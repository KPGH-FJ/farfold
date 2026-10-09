import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareMessageResend,
  messageBranchSnapshot,
  conversationDeleteProtection,
  conversationDeletionRequest,
  attemptConversationDeletion,
  startFinderPreview,
  finishFinderPreview,
} from "../src/conversation-menu-state.js";

const task = {
  id: "menu-thread",
  agent: "Example Agent",
  source: "Original service",
  model: "Original model",
  status: "done",
  folder: "/example/project",
  draft: "原草稿",
  attachments: ["original.md"],
  queue: [{ id: "later", text: "保留待发" }],
};
const message = { text: "重新讨论", attachments: ["message.md"] };

test("再发一次只准备编辑草稿，保留原草稿附件、历史、队列及来源，不发送", () => {
  const source = structuredClone(task);
  const patch = prepareMessageResend(task, message);
  assert.deepEqual(patch.resendDraft, {
    previousDraft: "原草稿",
    previousAttachments: ["original.md"],
  });
  const next = { ...task, ...patch };
  assert.equal(next.draft, "重新讨论");
  assert.deepEqual(next.attachments, ["message.md"]);
  assert.equal(next.status, "done");
  for (const key of ["agent", "source", "model", "folder", "queue"])
    assert.deepEqual(next[key], source[key]);
  for (const key of [
    "simulatePending",
    "extraMessages",
    "previewRequestId",
    "queuePaused",
  ])
    assert.equal(Object.hasOwn(patch, key), false);
  patch.attachments.push("new.md");
  patch.resendDraft.previousAttachments.push("other.md");
  assert.deepEqual(task, source);
  assert.deepEqual(message.attachments, ["message.md"]);
});

test("连续选择其他重发消息仍保留最初的原草稿；空消息不替换任何内容", () => {
  const current = { ...task, ...prepareMessageResend(task, message) };
  current.draft = "第一条重发编辑中";
  const patch = prepareMessageResend(current, { text: "另一条" });
  assert.equal(patch.resendDraft.previousDraft, "原草稿");
  assert.deepEqual(patch.resendDraft.previousAttachments, ["original.md"]);
  assert.equal(prepareMessageResend(task, { text: "  " }), null);
  assert.equal(prepareMessageResend(task, null), null);
  assert.deepEqual(
    prepareMessageResend(task, { text: "", attachments: ["only.md"] })
      .attachments,
    ["only.md"],
  );
});

test("未知、只读和归档中准备重发不会解除发送限制或自动恢复队列", () => {
  for (const flags of [
    { status: "unknown", stopPhase: "unknown" },
    { readOnly: true },
    { archived: true },
  ]) {
    const current = { ...task, ...flags, queuePaused: true };
    const next = { ...current, ...prepareMessageResend(current, message) };
    for (const key of Object.keys(flags)) assert.equal(next[key], flags[key]);
    assert.equal(next.queuePaused, true);
    assert.deepEqual(next.queue, task.queue);
  }
});

test("从消息新建提供独立不可变草稿副本与原对话标识，不伪造完整历史", () => {
  const snapshot = messageBranchSnapshot(task, message);
  assert.deepEqual(snapshot, {
    text: "重新讨论",
    attachments: ["message.md"],
    role: "user",
    originTaskId: task.id,
  });
  snapshot.attachments.push("new.md");
  assert.deepEqual(message.attachments, ["message.md"]);
  assert.equal(
    messageBranchSnapshot(task, { text: "答复", role: "assistant" }).role,
    "assistant",
  );
  assert.equal(messageBranchSnapshot(task, { text: "" }), null);
  assert.deepEqual(task.queue, [{ id: "later", text: "保留待发" }]);
});

test("删除确认每次按最新任务复核；未发、暂存、进行中和未知都不准删除", () => {
  const empty = { ...task, draft: "", attachments: [], queue: [] };
  assert.equal(conversationDeletionRequest(empty, false), null);
  assert.equal(conversationDeletionRequest(empty, true), task.id);
  for (const flags of [
    { draft: "尚未发" },
    { attachments: ["a.md"] },
    { queue: [{ text: "待发" }] },
    { status: "running" },
    { status: "approval" },
    { status: "question" },
    { stopPhase: "unknown" },
    { status: "unknown" },
    { configurationChange: { phase: "pending" } },
    { resendDraft: { previousDraft: "暂存" } },
    { resendDraft: { previousAttachments: ["a.md"] } },
    { feedbackDrafts: { file: { text: "意见" } } },
  ]) {
    const changed = { ...empty, ...flags };
    assert.ok(conversationDeleteProtection(changed), JSON.stringify(flags));
    assert.equal(conversationDeletionRequest(changed, true), null);
  }
});

test("访达模拟明确等待结果，错误可重试，过期结果不覆盖新请求", () => {
  const pending = startFinderPreview(task, "first");
  assert.equal(pending.phase, "pending");
  assert.equal(
    finishFinderPreview(pending, "old", task.folder, "success"),
    pending,
  );
  assert.equal(
    finishFinderPreview(pending, "first", "/another", "success"),
    pending,
  );
  const failed = finishFinderPreview(pending, "first", task.folder, "failed");
  assert.equal(failed.phase, "failed");
  assert.match(failed.error, /复制路径或重试/);
  assert.equal(
    finishFinderPreview(failed, "first", task.folder, "success"),
    failed,
  );
  const retry = startFinderPreview(task, "second");
  assert.equal(
    finishFinderPreview(retry, "first", task.folder, "success"),
    retry,
  );
  assert.equal(
    finishFinderPreview(retry, "second", task.folder, "success").phase,
    "success",
  );
  assert.equal(
    startFinderPreview({ ...task, folder: "" }, "missing").phase,
    "failed",
  );
  assert.equal(task.draft, "原草稿");
});

test("删除结果未保存不会完成，重试仍复核保护且只在保存成功后完成", () => {
  const current = { ...task, draft: "", attachments: [], queue: [] };
  let calls = 0;
  const remove = (id) => {
    assert.equal(id, current.id);
    calls += 1;
    return calls > 1;
  };
  const failed = attemptConversationDeletion(current, true, remove);
  assert.equal(failed.phase, "failed");
  assert.match(failed.message, /未保存.*原对话保留/);
  assert.equal(calls, 1);
  assert.equal(
    attemptConversationDeletion(
      { ...current, draft: "刚输入的草稿" },
      true,
      remove,
    ).phase,
    "blocked",
  );
  assert.equal(calls, 1);
  assert.equal(
    attemptConversationDeletion(current, true, remove).phase,
    "deleted",
  );
  assert.equal(calls, 2);
  assert.equal(current.title, task.title);
});

test("删除保存抛出异常也保留确认，不会宣称完成或调用未确认删除", () => {
  const current = { ...task, draft: "", attachments: [], queue: [] };
  let calls = 0;
  const failedSave = () => {
    calls += 1;
    throw new Error("storage full");
  };
  assert.equal(
    attemptConversationDeletion(current, false, failedSave).phase,
    "blocked",
  );
  assert.equal(calls, 0);
  assert.equal(
    attemptConversationDeletion(current, true, failedSave).phase,
    "failed",
  );
  assert.equal(calls, 1);
  assert.equal(
    attemptConversationDeletion(current, true, undefined).phase,
    "blocked",
  );
});
