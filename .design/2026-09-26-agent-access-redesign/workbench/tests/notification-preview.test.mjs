import assert from "node:assert/strict";
import test from "node:test";
import {
  notificationPreferences,
  notificationAttention,
  notificationPreviewBlock,
  notificationPreviewTargets,
  resolveNotificationTarget,
} from "../src/notification-preview-state.js";

const tasks = [
  { id: "done", title: "已经完成的对话", agent: "Codex", status: "done" },
  { id: "approve", title: "等待批准", agent: "Pi", status: "approval" },
  { id: "question", title: "等待回答", agent: "Goose", status: "question" },
  { id: "problem", title: "工作出错", agent: "Codex", status: "failed" },
  {
    id: "archived",
    title: "已归档",
    agent: "Pi",
    status: "approval",
    archived: true,
  },
];

test("notification preferences preserve sound while disabled and ignore invalid values", () => {
  assert.deepEqual(notificationPreferences(), { enabled: false, sound: false });
  assert.deepEqual(notificationPreferences(null), {
    enabled: false,
    sound: false,
  });
  assert.deepEqual(notificationPreferences({ enabled: false, sound: true }), {
    enabled: false,
    sound: true,
  });
  assert.deepEqual(notificationPreferences({ enabled: "true", sound: 1 }), {
    enabled: false,
    sound: false,
  });
});

test("preview requires both preference and simulated permission; unknown permission is blocked", () => {
  assert.equal(notificationPreviewBlock({ enabled: true }, "granted"), null);
  assert.match(
    notificationPreviewBlock({ enabled: false }, "granted"),
    /先开启/,
  );
  assert.match(
    notificationPreviewBlock({ enabled: true }, "not-requested"),
    /权限演示/,
  );
  assert.match(
    notificationPreviewBlock({ enabled: true }, "denied"),
    /系统设置/,
  );
  assert.match(
    notificationPreviewBlock({ enabled: true }, "unavailable"),
    /无法使用/,
  );
  assert.match(
    notificationPreviewBlock({ enabled: true }, "unknown"),
    /无法使用/,
  );
});

test("multi-conversation tests prefer actual pending tasks and retain each destination identity", () => {
  const previews = notificationPreviewTargets(tasks);
  assert.deepEqual(
    previews.map((item) => item.taskId),
    ["approve", "question", "problem"],
  );
  assert.deepEqual(
    previews.map((item) => item.agent),
    ["Pi", "Goose", "Codex"],
  );
  assert.ok(previews.every((item) => item.reason));
  assert.equal(notificationPreviewTargets([]).length, 0);
});

test("a completed-task test is explicit about having no actual pending action", () => {
  const [preview] = notificationPreviewTargets(tasks, "done");
  assert.equal(preview.taskId, "done");
  assert.equal(preview.reason, null);
  assert.deepEqual(notificationPreviewTargets(tasks, "missing"), []);
  assert.deepEqual(notificationPreviewTargets(tasks, "archived"), []);
});

test("deleted notification destinations cannot be opened and resolved work is identified as changed", () => {
  const [preview] = notificationPreviewTargets(tasks, "approve");
  assert.equal(resolveNotificationTarget(preview, tasks).state, "current");
  const resolved = tasks.map((task) =>
    task.id === "approve" ? { ...task, status: "done" } : task,
  );
  const target = resolveNotificationTarget(preview, resolved);
  assert.equal(target.state, "changed");
  assert.equal(target.task.id, "approve");
  assert.equal(target.reason, null);
  assert.deepEqual(
    resolveNotificationTarget(
      preview,
      tasks.filter((task) => task.id !== "approve"),
    ),
    { state: "missing", task: null },
  );
  assert.equal(tasks[1].status, "approval");
});

test("notification payload excludes prompts, drafts, sources and credentials", () => {
  const [preview] = notificationPreviewTargets([
    {
      ...tasks[1],
      prompt: "私有正文",
      draft: "草稿",
      source: "内部地址",
      key: "secret",
    },
  ]);
  assert.deepEqual(Object.keys(preview).sort(), [
    "agent",
    "reason",
    "taskId",
    "title",
  ]);
  assert.equal(JSON.stringify(preview).includes("secret"), false);
});

test("uncertain stopping takes priority over an older approval status", () => {
  assert.equal(
    notificationAttention({ status: "approval", stopPhase: "unknown" }),
    "停止结果需要确认",
  );
  assert.equal(notificationAttention({ status: "running" }), null);
});
