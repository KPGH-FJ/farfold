import test from "node:test";
import assert from "node:assert/strict";
import {
  threadAttachmentReviewItems,
  confirmThreadAttachments,
} from "../src/attachment-recovery.js";
import {
  canReleasePreviewQueue,
  previewQueueGate,
} from "../src/conversation-state.js";

const task = {
  draft: "当前正文",
  attachments: ["相同名字.md"],
  draftAttachments: ["旧格式.pdf"],
  attachmentsNeedReview: true,
  queuePaused: false,
  status: "done",
  queue: [
    { id: "q1", text: "第一条正文", attachments: ["相同名字.md", "待发.png"] },
    "只有正文的旧消息",
    { id: "q3", text: "第三条正文", attachments: [] },
  ],
};

test("输入与各条待发的同名附件有独立核对身份", () => {
  const items = threadAttachmentReviewItems(task);
  assert.equal(items.length, 4);
  assert.equal(new Set(items.map((item) => item.id)).size, 4);
  assert.equal(items[0].label, "当前输入 · 相同名字.md");
  assert.equal(items[2].label, "第 1 条待发 · 相同名字.md");
});

test("核对只过滤附件，正文和队列顺序不丢，旧格式附件归入当前输入", () => {
  const patch = confirmThreadAttachments(task, [
    "draftAttachments:0",
    "queue:0:0",
  ]);
  assert.deepEqual(patch.attachments, ["旧格式.pdf"]);
  assert.deepEqual(patch.draftAttachments, []);
  assert.deepEqual(patch.queue[0], {
    id: "q1",
    text: "第一条正文",
    attachments: ["相同名字.md"],
  });
  assert.equal(patch.queue[1], task.queue[1]);
  assert.deepEqual(patch.queue[2], task.queue[2]);
  assert.equal(patch.draft, undefined);
  assert.equal(patch.status, undefined);
  assert.equal(patch.extraMessages, undefined);
  assert.equal(patch.attachmentsNeedReview, false);
  assert.equal(patch.queuePaused, true);
  assert.deepEqual(task.queue[0].attachments, ["相同名字.md", "待发.png"]);
});

test("移除全部附件仍保留全部正文，不自动继续队列", () => {
  const next = { ...task, ...confirmThreadAttachments(task, []) };
  assert.equal(next.draft, task.draft);
  assert.deepEqual(next.attachments, []);
  assert.deepEqual(
    next.queue.map((item) => (typeof item === "string" ? item : item.text)),
    ["第一条正文", "只有正文的旧消息", "第三条正文"],
  );
  assert.equal(canReleasePreviewQueue(next), false);
  assert.equal(canReleasePreviewQueue({ ...next, queuePaused: false }), true);
});

test("附件未核对，即使队列未暂停也不能自动推进", () => {
  assert.equal(canReleasePreviewQueue(task), false);
  assert.deepEqual(previewQueueGate(task, {}), { queuePaused: true });
  assert.equal(
    canReleasePreviewQueue({ ...task, attachmentsNeedReview: false }),
    true,
  );
});
