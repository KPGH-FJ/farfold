import assert from "node:assert/strict";
import test from "node:test";
import {
  archiveEligibility,
  visibleInActive,
  filterConversations,
  applyArchivePolicy,
  autoArchiveEligibility,
  restoreConversation,
  patchConversationMetadata,
} from "../src/history-policy.js";
import { archiveReviewTasks } from "./fixtures/archive-review-tasks.js";
const DAY = 86400000;
const now = new Date("2026-09-26T00:00:00Z").getTime();
const settled = {
  id: "a",
  title: "旧对话",
  status: "done",
  agent: "Codex",
  group: "产品",
  queue: [],
  lastActivityAt: now - 40 * DAY,
};

test("every archive entry receives the same active-work rejection", () => {
  for (const patch of [
    { status: "running" },
    { status: "approval" },
    { status: "question" },
    { status: "unknown" },
    { status: "recovery" },
    { status: "submitting" },
    { stopPhase: "waiting" },
    { stopPhase: "unknown" },
    { admissionUnknown: true },
    { queue: [{ text: "待发" }], queuePaused: true },
    { recoveryRead: { phase: "loading" } },
    { connectionState: "lost" },
  ]) {
    const task = { ...settled, ...patch };
    assert.equal(
      archiveEligibility(task).allowed,
      false,
      JSON.stringify(patch),
    );
    const result = patchConversationMetadata(task, { archived: true }, now);
    assert.equal(result.task, task);
    assert.ok(result.error);
  }
});

test("stale archive flag cannot hide active work or duplicate it in archived", () => {
  const task = { ...settled, status: "unknown", archived: true };
  assert.equal(visibleInActive(task), true);
  assert.equal(filterConversations([task], { state: "needs" }).length, 1);
  assert.equal(filterConversations([task], { state: "archived" }).length, 0);
});

test("same-dimension filters replace previous values, different dimensions combine", () => {
  const tasks = [settled, { ...settled, id: "b", agent: "Pi", pinned: true }];
  let filters = { agent: "Pi", group: "产品", state: "all" };
  assert.deepEqual(
    filterConversations(tasks, filters).map((task) => task.id),
    ["b"],
  );
  filters = { ...filters, agent: "Codex" };
  assert.deepEqual(
    filterConversations(tasks, filters).map((task) => task.id),
    ["a"],
  );
  assert.equal(
    filterConversations(tasks, { ...filters, starred: true }).length,
    0,
  );
  assert.equal(
    filterConversations(tasks, { ...filters, agent: "", starred: true }).length,
    1,
  );
});

test("metadata search includes location without claiming body search", () => {
  const tasks = [{ ...settled, folder: "/work/demo", prompt: "hidden body" }];
  assert.equal(filterConversations(tasks, { query: "demo" }).length, 1);
  assert.equal(filterConversations(tasks, { query: "hidden body" }).length, 0);
});

test("automatic archive chooses only a known-ended unprotected old conversation", () => {
  const tasks = archiveReviewTasks(now);
  const result = applyArchivePolicy(tasks, 30, now);
  assert.deepEqual(result.archivedIds, ["archive-review-eligible"]);
  assert.equal(result.count, 1);
  assert.equal(result.tasks[0].archiveSource, "automatic");
  assert.equal(result.tasks[0].archivedAt, now);
  assert.equal(tasks[0].archived, undefined);
});

test("archive is durable metadata and remains after a prototype restart", () => {
  const first = applyArchivePolicy([settled], 30, now).tasks;
  const loaded = JSON.parse(JSON.stringify(first));
  assert.equal(loaded[0].archived, true);
  assert.equal(applyArchivePolicy(loaded, 30, now + DAY).count, 0);
  assert.equal(filterConversations(loaded, { state: "archived" }).length, 1);
});

test("restoring preserves identity and restarts a full archive waiting period", () => {
  const archived = applyArchivePolicy([settled], 30, now).tasks[0];
  const restored = restoreConversation(archived, now);
  assert.equal(restored.id, settled.id);
  assert.equal(restored.lastActivityAt, settled.lastActivityAt);
  assert.equal(
    autoArchiveEligibility(restored, 30, now + 29 * DAY).allowed,
    false,
  );
  assert.equal(
    autoArchiveEligibility(restored, 30, now + 30 * DAY).allowed,
    true,
  );
});

test("disabling automatic archive neither archives nor restores existing records", () => {
  const archived = { ...settled, archived: true };
  assert.equal(applyArchivePolicy([settled, archived], 0, now).count, 0);
  assert.equal(applyArchivePolicy([archived], 0, now).tasks[0], archived);
});

test("unknown historical timestamps and unfinished feedback are protected", () => {
  for (const patch of [
    { lastActivityAt: null },
    { lastActivityKnown: false },
    { completionKnown: false },
    { draft: "未发送" },
    { attachments: ["note.md"] },
    { feedbackDrafts: { key: { text: "这句再看一下" } } },
  ])
    assert.equal(
      autoArchiveEligibility({ ...settled, ...patch }, 30, now).allowed,
      false,
    );
});

test("editing meaningful pending input updates activity while organization does not", () => {
  assert.equal(
    patchConversationMetadata(settled, { draft: "稍后发" }, now).task
      .lastActivityAt,
    now,
  );
  assert.equal(
    patchConversationMetadata(settled, { title: "新标题", group: "写作" }, now)
      .task.lastActivityAt,
    settled.lastActivityAt,
  );
  const restored = patchConversationMetadata(
    { ...settled, archived: true },
    { archived: false },
    now,
  ).task;
  assert.equal(restored.archiveRestoredAt, now);
});

test("opening or completing history read cannot invent a last activity time", () => {
  const task = {
    ...settled,
    lastActivityAt: null,
    status: "recovery",
    recoveryRead: { phase: "loading" },
  };
  const read = patchConversationMetadata(
    task,
    { status: "done", recoveryRead: { phase: "complete" } },
    now,
  ).task;
  assert.equal(read.lastActivityAt, null);
  assert.equal(autoArchiveEligibility(read, 30, now).allowed, false);
});
