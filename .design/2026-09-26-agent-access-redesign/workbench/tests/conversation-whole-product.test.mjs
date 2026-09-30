import test from "node:test";
import assert from "node:assert/strict";
import {
  makePrototypeSnapshot,
  restorePrototypeSnapshot,
} from "../src/prototype-persistence.js";
import {
  canAnswerPreview,
  canReleasePreviewQueue,
  previewQueueGate,
  resolvePreviewRecovery,
} from "../src/conversation-state.js";
import {
  recoveryPreviewEvent,
  conversationState,
  updateFeedback,
  feedbackKey,
  takeFeedback,
  applyConversationPatch,
} from "../src/conversation-policy.js";
import { isImportable, planImport } from "../src/import-state.js";
import {
  hasUnsentContent,
  autoArchiveEligibility,
} from "../src/history-policy.js";
import {
  beginPreviewQueueEdit,
  savePreviewQueueEdit,
  beginPreviewDecisionResult,
} from "../src/conversation-state.js";

test("restarting invalidates pending request handles while preserving the user's unanswered input", () => {
  for (const status of ["approval", "question"]) {
    const original = {
      id: status,
      status,
      answerDraft: { choice: "existing", note: "保留回答" },
      approvalAnswers: { first: "accept" },
      queue: [{ id: "q", text: "稍后" }],
    };
    const restored = restorePrototypeSnapshot(
      makePrototypeSnapshot({
        tasks: [original],
        draft: { choice: {}, text: "", files: [] },
      }),
    ).tasks[0];
    assert.equal(restored.status, "unknown");
    assert.equal(restored.interactionExpired, true);
    assert.equal(canAnswerPreview(restored, status, false), false);
    assert.deepEqual(restored.answerDraft, original.answerDraft);
    assert.deepEqual(restored.approvalAnswers, original.approvalAnswers);
    assert.deepEqual(restored.queue, original.queue);
    assert.equal(restored.queuePaused, true);
  }
});

test("a confirmed unknown result clears only obsolete request locks and never resumes the queue", () => {
  const task = {
    status: "unknown",
    stopPhase: "unknown",
    admissionUnknown: true,
    unknownReason: "restart",
    queue: ["保留"],
    draft: "继续",
  };
  for (const outcome of ["stopped", "completed"]) {
    const restored = {
      ...task,
      ...resolvePreviewRecovery(task, "unknown", outcome),
    };
    assert.equal(restored.stopPhase, null);
    assert.equal(restored.admissionUnknown, false);
    assert.equal(restored.terminalConfirmed, true);
    assert.equal(restored.queuePaused, true);
    assert.equal(conversationState(restored).attention, false);
    assert.deepEqual(restored.queue, task.queue);
  }
});

test("queued continuation cannot bypass current conversation restrictions", () => {
  const base = {
    status: "running",
    queuePaused: false,
    queue: [{ id: "q", text: "later" }],
  };
  for (const restriction of [
    { readOnly: true },
    { identityIncomplete: true },
    { connectionState: "lost" },
    { admissionUnknown: true },
    { stopPhase: "unknown" },
    { stopping: true },
    { recoveryRead: { phase: "loading" } },
    { status: "unknown" },
    { status: "recovery" },
    { status: "submitting" },
  ]) {
    const task = { ...base, ...restriction };
    assert.equal(
      canReleasePreviewQueue(task),
      false,
      JSON.stringify(restriction),
    );
    assert.deepEqual(previewQueueGate(task, {}), { queuePaused: true });
  }
  assert.equal(canReleasePreviewQueue(base), true);
});

test("disconnected or expired approval controls cannot submit old decisions", () => {
  for (const restriction of [
    { connectionState: "lost" },
    { interactionExpired: true },
    { readOnly: true },
    { recoveryRead: { phase: "loading" } },
  ])
    assert.equal(
      canAnswerPreview(
        { status: "approval", ...restriction },
        "approval",
        false,
      ),
      false,
    );
});

test("late recovery failures cannot replace a completed replay; failure needs a new read before retry", () => {
  const task = {
    status: "done",
    model: "M",
    recoveryRead: {
      id: "r",
      phase: "complete",
      receipt: true,
      bodyComplete: true,
    },
  };
  for (const event of ["failed", "empty", "unsupported", "partial"]) {
    const patch = recoveryPreviewEvent(task, event);
    assert.equal(patch, null);
  }
});

test("blank or missing history bodies cannot produce successful imported conversations", () => {
  for (const messages of [
    undefined,
    [],
    [{ role: "assistant", text: "   " }],
    [{ role: "tool", text: "only a tool receipt" }],
  ]) {
    const record = {
      key: "[a,b]",
      agentId: "a",
      externalId: "b",
      title: "历史",
      status: "continuable",
      messages,
    };
    assert.equal(isImportable(record), false);
    assert.equal(planImport([record], [record.key], []).tasks.length, 0);
  }
});

test("automatic archive recognizes unsent form notes and both feedback draft collections", () => {
  const task = {
    status: "done",
    lastActivityAt: 1,
    answerDraft: { note: "未提交的说明" },
    feedbackDrafts: {},
    contentDrafts: { file: { text: "文件意见" } },
  };
  assert.equal(hasUnsentContent({ ...task, contentDrafts: {} }), true);
  assert.equal(hasUnsentContent({ ...task, answerDraft: undefined }), true);
  assert.equal(autoArchiveEligibility(task, 1, 10 * 86400000).allowed, false);
});

test("editing a queued message pauses automatic release and tracks identity through reordering", () => {
  const original = { queue: ["first", "second"], queuePaused: false };
  let id = 0;
  const editing = beginPreviewQueueEdit(original, 0, () => String(++id));
  const current = { ...original, ...editing.patch };
  assert.equal(current.queuePaused, true);
  assert.notEqual(current.queue[0].id, current.queue[1].id);
  current.queue.reverse();
  const edited = savePreviewQueueEdit(current, {
    ...editing.edit,
    text: "edited first",
  });
  assert.equal(edited.patch.queue[0].text, "second");
  assert.equal(edited.patch.queue[1].text, "edited first");
  assert.equal(edited.patch.queuePaused, true);
  current.queue = [current.queue[0]];
  const missing = savePreviewQueueEdit(current, {
    ...editing.edit,
    text: "must not replace second",
  });
  assert.ok(missing.error);
  assert.equal(missing.patch, undefined);
  assert.equal(current.queue[0].text, "second");
});

test("declining a permission or cancelling a question waits for Agent completion", () => {
  for (const [status, outcome] of [
    ["approval", "declined"],
    ["question", "cancelled"],
  ]) {
    const task = { status, answerDraft: { note: "keep" }, queue: ["later"] };
    const next = { ...task, ...beginPreviewDecisionResult(task, outcome) };
    assert.equal(next.status, "running");
    assert.equal(next.terminalConfirmed, false);
    assert.equal(next.queuePaused, true);
    assert.deepEqual(next.answerDraft, task.answerDraft);
    assert.deepEqual(next.queue, task.queue);
    assert.equal(
      beginPreviewDecisionResult({ ...task, status: "stopped" }, outcome),
      null,
    );
  }
  assert.equal(
    hasUnsentContent({
      answerDraft: { note: "already submitted" },
      answerSubmitted: true,
    }),
    false,
  );
});

test("feedback reaches only the draft in read-only, archived and unknown conversations and survives reload", () => {
  const file = { path: "notes.md", content: "version one" };
  for (const flags of [
    { status: "done", readOnly: true },
    { status: "done", archived: true },
    { status: "unknown", queuePaused: true },
  ]) {
    const initial = {
      id: "feedback",
      agent: "A",
      model: "M",
      draft: "已有内容",
      queue: [],
      ...flags,
    };
    const note = applyConversationPatch(
      initial,
      updateFeedback(initial, file, { text: "请保留这条意见" }),
    );
    const patch = takeFeedback(note, feedbackKey(file));
    const next = applyConversationPatch(note, patch);
    assert.equal(next.status, initial.status);
    assert.equal(next.archived, initial.archived);
    assert.equal(next.readOnly, initial.readOnly);
    assert.deepEqual(next.queue, []);
    assert.equal(next.extraMessages, undefined);
    assert.equal(next.simulatePending, undefined);
    assert.match(next.draft, /已有内容/);
    assert.match(next.draft, /请保留这条意见/);
    const restored = restorePrototypeSnapshot(
      makePrototypeSnapshot({
        tasks: [next],
        draft: { choice: {}, text: "", files: [] },
      }),
    ).tasks[0];
    assert.equal(restored.draft, next.draft);
    assert.equal(restored.status, next.status);
  }
});

test("complete history text cannot silently repair a changed model or effort", () => {
  let task = {
    status: "recovery",
    model: "original",
    effort: "High",
    currentModel: "other",
    currentEffort: "Ultra",
    recoveryRead: { id: "r", phase: "loading" },
  };
  for (const type of ["receipt", "body-complete", "identity-mismatch"])
    task = { ...task, ...recoveryPreviewEvent(task, type) };
  assert.equal(task.status, "recovery");
  assert.equal(task.currentModel, "other");
  assert.equal(task.currentEffort, "Ultra");
  task = { ...task, ...recoveryPreviewEvent(task, "identity-matched") };
  assert.equal(task.status, "done");
  assert.equal(task.currentModel, "original");
  assert.equal(task.queuePaused, true);
});

test("attachment-only queued messages stay attachment-only through editing", () => {
  const task = { queue: [{ id: "q", text: "", attachments: ["notes.md"] }] };
  const result = savePreviewQueueEdit(task, {
    id: "q",
    originalText: "",
    text: "",
  });
  assert.equal(result.patch.queue[0].text, "");
  assert.deepEqual(result.patch.queue[0].attachments, ["notes.md"]);
});

test("restarting during an attachment-only first send keeps the empty prompt and readable title", () => {
  const draft = {
    text: "",
    files: ["only-file.md"],
    choice: { agent: "A", model: "M" },
  };
  const restored = restorePrototypeSnapshot(
    makePrototypeSnapshot({
      tasks: [],
      draft,
      pendingSend: { id: "pending-file", draft },
    }),
  );
  assert.equal(restored.tasks[0].title, "only-file.md");
  assert.equal(restored.tasks[0].prompt, "");
  assert.deepEqual(restored.tasks[0].sentAttachments, ["only-file.md"]);
  assert.equal(restored.tasks[0].status, "unknown");
});
