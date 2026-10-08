import test from "node:test";
import assert from "node:assert/strict";
import {
  deletionScope,
  libraryResults,
  libraryProtection,
  metadataSearch,
  CLEAR_DATA_REMOVES,
  CLEAR_DATA_KEEPS,
} from "../src/settings-library-state.js";
const task = (id, patch = {}) => ({
  id,
  title: `对话 ${id}`,
  agent: "Codex",
  status: "done",
  queue: [],
  folder: "/work/notes",
  group: "写作",
  ...patch,
});
test("destructive scope excludes active work, unknown results, queues and unsent material", () => {
  const tasks = [
    task("safe"),
    task("running", { status: "running" }),
    task("unknown", { status: "unknown" }),
    task("draft", { draft: "未发送" }),
    task("queue", { queue: [{ text: "稍后发送" }] }),
    task("attachment", { draftAttachments: [{ name: "notes.md" }] }),
  ];
  const scope = deletionScope(
    tasks,
    tasks.map((t) => t.id),
  );
  assert.deepEqual(
    scope.allowed.map((t) => t.id),
    ["safe"],
  );
  assert.equal(scope.protected.length, 5);
  assert.ok(libraryProtection(tasks[3]).includes("未发送"));
});
test("metadata search includes archived locations but never matches message body", () => {
  const tasks = [
    task("a", {
      archived: true,
      folder: "/work/mountain",
      extraMessages: [{ text: "正文秘密词" }],
    }),
    task("b"),
  ];
  assert.deepEqual(
    metadataSearch(tasks, "mountain").map((t) => t.id),
    ["a"],
  );
  assert.equal(metadataSearch(tasks, "正文秘密词").length, 0);
});
test("unsent filter preserves existing Agent and group constraints", () => {
  const tasks = [
    task("a", { draft: "未发" }),
    task("b", { draft: "未发", agent: "Pi" }),
    task("c"),
    task("d", { draft: "未发", group: "其他" }),
  ];
  assert.deepEqual(
    libraryResults(tasks, {
      state: "drafts",
      agent: "Codex",
      group: "写作",
    }).map((t) => t.id),
    ["a"],
  );
});
test("deletion re-evaluates current protection rather than trusting prior selection", () => {
  const before = task("a");
  assert.equal(deletionScope([before], ["a"]).allowed.length, 1);
  assert.equal(
    deletionScope([{ ...before, stopPhase: "unknown" }], ["a"]).allowed.length,
    0,
  );
  assert.equal(deletionScope([], ["a"]).allowed.length, 0);
});
test("clear data explanation includes owned programs, safe-storage keys and application folders, preserving Agent and user data", () => {
  assert.equal(CLEAR_DATA_REMOVES.length, 5);
  assert.ok(CLEAR_DATA_REMOVES.some((t) => t.includes("系统安全存储")));
  assert.ok(CLEAR_DATA_REMOVES.some((t) => t.includes("应用对话文件夹")));
  assert.ok(CLEAR_DATA_KEEPS.some((t) => t.includes("账号、配置和对话历史")));
  assert.ok(CLEAR_DATA_KEEPS.some((t) => t.includes("项目文件夹")));
});
