import test from "node:test";
import assert from "node:assert/strict";
import {
  startConfigurationChange,
  finishConfigurationChange,
} from "../src/conversation-configuration.js";
import {
  applyConversationPatch,
  recoveryPreviewEvent,
  updateFeedback,
  feedbackKey,
} from "../src/conversation-policy.js";
import {
  previewConversationBlocked,
  canReleasePreviewQueue,
  canAnswerPreview,
} from "../src/conversation-state.js";
import {
  webpageEvent,
  fileReadEvent,
} from "../src/conversation-content-state.js";
import {
  createConversationExport,
  exportPreviewOutcome,
} from "../src/conversation-export.js";

const original = {
  id: "review",
  agent: "Agent A",
  source: "Service A",
  status: "done",
  model: "A",
  effort: "High",
  draft: "保留草稿",
  attachments: ["note.md"],
  queue: [{ id: "q1", text: "待发" }],
  queuePaused: false,
};
const capability = {
  models: [
    { id: "A", label: "A", efforts: ["Low", "High"] },
    { id: "B", label: "B", efforts: ["Low", "High"] },
  ],
  supportsModelChange: true,
  supportsEffortChange: true,
};
const next = { model: "B", effort: "Low" };

test("Markdown 仅导出传入的已展示示例消息，不补造历史或带入草稿队列", () => {
  const snapshot = createConversationExport(
    { ...original, title: "方案/比较" },
    [
      { role: "user", text: "已展示的问题" },
      { role: "assistant", text: "已展示的示例回答" },
    ],
  );
  assert.equal(snapshot.filename, "方案-比较.md");
  assert.equal(snapshot.messageCount, 2);
  assert.match(snapshot.markdown, /交互原型导出/);
  assert.match(snapshot.markdown, /## 你\n\n已展示的问题/);
  assert.match(snapshot.markdown, /## Agent A\n\n已展示的示例回答/);
  assert.doesNotMatch(snapshot.markdown, /保留草稿/);
  assert.doesNotMatch(snapshot.markdown, /##[^\n]*\n\n待发/);
  assert.equal(createConversationExport(original, []), null);
});

test("导出准备可保持等待，失败可重试，无正文不伪造成功文件", () => {
  const snapshot = createConversationExport(original, [
    { role: "user", text: "已有内容" },
  ]);
  assert.equal(exportPreviewOutcome(snapshot, "waiting", 1).phase, "preparing");
  assert.equal(exportPreviewOutcome(snapshot, "success", 1).phase, "ready");
  assert.equal(exportPreviewOutcome(snapshot, "failed", 1).phase, "failed");
  assert.equal(exportPreviewOutcome(snapshot, "failed", 2).phase, "ready");
  assert.equal(exportPreviewOutcome(null, "success", 2).phase, "failed");
  assert.deepEqual(original.queue, [{ id: "q1", text: "待发" }]);
  assert.equal(original.draft, "保留草稿");
});

test("完成后模型与推理只在匹配的确认保存回执后改变，Agent来源与草稿保留", () => {
  let current = applyConversationPatch(
    original,
    startConfigurationChange(original, capability, next, "c1"),
  );
  assert.equal(current.model, "A");
  assert.equal(previewConversationBlocked(current), true);
  assert.equal(current.queuePaused, true);
  current = applyConversationPatch(
    current,
    finishConfigurationChange(current, "c1", "success"),
  );
  assert.equal(current.model, "B");
  assert.equal(current.effort, "Low");
  assert.equal(current.fixedIdentity.model, "B");
  for (const key of ["agent", "source", "draft", "attachments", "queue"])
    assert.deepEqual(current[key], original[key]);
  assert.equal(current.queuePaused, true);
  assert.equal(
    canReleasePreviewQueue(current, {
      workEnabled: true,
      sourceAvailable: true,
      agentAvailable: true,
    }),
    false,
  );
  assert.equal(
    applyConversationPatch(current, { source: "Service B", model: "A" }).model,
    "B",
  );
});

test("审批、回答、运行、停止未知与恢复未确认不能开始模型更改", () => {
  for (const state of [
    { status: "approval" },
    { status: "question" },
    { status: "running" },
    { stopPhase: "unknown" },
    { permissionReconfirmRequired: true },
    { status: "recovery" },
  ]) {
    assert.equal(
      startConfigurationChange(
        { ...original, ...state },
        capability,
        next,
        "c1",
      ),
      null,
    );
  }
  assert.equal(startConfigurationChange(original, undefined, next, "c1"), null);
});

test("配置明确失败保留原值，未知保持发送暂停，旧回执与运行中迟到成功不能放行", () => {
  const current = applyConversationPatch(
    original,
    startConfigurationChange(original, capability, next, "c1"),
  );
  assert.equal(finishConfigurationChange(current, "old", "success"), null);
  const failed = applyConversationPatch(
    current,
    finishConfigurationChange(current, "c1", "failed"),
  );
  assert.equal(failed.model, "A");
  assert.equal(failed.configurationChange, null);
  const unknown = applyConversationPatch(
    current,
    finishConfigurationChange(current, "c1", "unknown"),
  );
  assert.equal(unknown.model, "A");
  assert.equal(previewConversationBlocked(unknown), true);
  const checked = applyConversationPatch(
    unknown,
    finishConfigurationChange(unknown, "c1", "success"),
  );
  assert.equal(checked.model, "B");
  assert.equal(checked.queuePaused, true);
  const raced = finishConfigurationChange(
    { ...current, status: "running" },
    "c1",
    "success",
  );
  assert.equal(raced.configurationChange.phase, "unknown");
  assert.equal(raced.model, undefined);
});

test("历史完整恢复仍需要明确确认权限，回答提交未知阻止再次提交", () => {
  let current = {
    ...original,
    status: "recovery",
    recoveryRead: { id: "r", phase: "loading" },
  };
  for (const event of ["receipt", "body-complete", "identity-matched"])
    current = { ...current, ...recoveryPreviewEvent(current, event) };
  assert.equal(current.status, "done");
  assert.equal(current.permissionReconfirmRequired, true);
  assert.equal(previewConversationBlocked(current), true);
  assert.equal(
    canAnswerPreview(
      {
        ...original,
        status: "question",
        questionSubmission: { phase: "unknown" },
      },
      "question",
      false,
    ),
    false,
  );
});

test("网页查看不授予权限；收起保留，换页、关闭和连接结束撤回", () => {
  let page = webpageEvent({}, "open");
  assert.equal(page.granted, false);
  page = webpageEvent(page, "grant");
  const hidden = webpageEvent(page, "hide");
  assert.equal(hidden.granted, true);
  assert.equal(hidden.open, false);
  assert.equal(webpageEvent(hidden, "open").granted, true);
  for (const action of ["close", "disconnect", "navigate"])
    assert.equal(
      webpageEvent(page, action, "https://example.com/next").granted,
      false,
    );
});

test("单文件读取失败不改另一文件，版本更新后旧意见仍对应旧版本", () => {
  let task = { ...original, filePreviewStates: { "b.md": "ready" } };
  task = { ...task, ...fileReadEvent(task, "a.md", "failed") };
  assert.equal(task.filePreviewStates["b.md"], "ready");
  const version1 = { path: "a.md", content: "第一版", versionLabel: "第一版" };
  const version2 = { path: "a.md", content: "第二版", versionLabel: "第二版" };
  task = { ...task, ...updateFeedback(task, version1, { text: "原版本意见" }) };
  task = { ...task, ...fileReadEvent(task, "a.md", "ready") };
  assert.equal(task.feedbackDrafts[feedbackKey(version1)].text, "原版本意见");
  assert.equal(task.feedbackDrafts[feedbackKey(version2)], undefined);
});
