import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_EXAMPLES,
  filterCommands,
  insertCommand,
  attachmentName,
} from "../src/composer-examples.js";
import {
  historyStartCandidate,
  historySourceIssue,
  preserveDraft,
} from "../src/history-start-state.js";
import { hasUnsentContent } from "../src/history-policy.js";
import { libraryProtection } from "../src/settings-library-state.js";
import {
  makePrototypeSnapshot,
  restorePrototypeSnapshot,
} from "../src/prototype-persistence.js";

test("long command search includes description and preserves a multiline draft verbatim", () => {
  const [command] = filterCommands(COMMAND_EXAMPLES, "键盘导航");
  assert.ok(command.name.length > 40 && command.description.length > 100);
  const draft = "保留这段文字\n  包括空格与原有顺序";
  assert.equal(insertCommand(draft, command.name), `${command.name}\n${draft}`);
  assert.equal(filterCommands(COMMAND_EXAMPLES, "NO-SUCH-COMMAND").length, 0);
  assert.equal(insertCommand("", "/help"), "/help ");
});
test("attachments retain distinguishing paths even when file names match", () => {
  assert.notEqual(
    attachmentName("版本一/意见.md"),
    attachmentName({ path: "版本二/意见.md" }),
  );
});
const current = {
  text: "原草稿",
  files: ["原附件.md"],
  folder: "/old",
  choice: { agent: "A", model: "m" },
};
const next = {
  text: "新内容",
  files: ["新附件.md"],
  folder: "/next",
  choice: { agent: "B", model: "n" },
};
test("new conversation preserves the entire old draft and restoration swaps without data loss", () => {
  const result = preserveDraft(current, next, [], "first");
  assert.deepEqual(result.savedDrafts[0].draft, current);
  assert.deepEqual(result.draft, next);
  const restored = preserveDraft(
    result.draft,
    result.savedDrafts[0].draft,
    result.savedDrafts,
    "second",
    "first",
  );
  assert.deepEqual(restored.draft, current);
  assert.deepEqual(restored.savedDrafts[0].draft, next);
  restored.draft.files.push("changed");
  assert.deepEqual(current.files, ["原附件.md"]);
});
test("new-from-message copies selected content, attachments, source and config without consuming history", () => {
  const task = {
    id: "t",
    agent: "A",
    model: "m",
    folder: "/p",
    accessMode: "api",
    serviceSnapshot: { endpoint: "https://old.example" },
    configValues: { mode: "chosen" },
    prompt: "past",
  };
  const draft = historyStartCandidate(task, {
    text: "selected reply",
    attachments: ["file.md"],
  });
  assert.equal(draft.text, "selected reply");
  assert.deepEqual(draft.choice.configValues, { mode: "chosen" });
  assert.equal(task.prompt, "past");
  assert.equal(historyStartCandidate(task).text, "");
});
const agent = {
  id: "a",
  name: "A",
  serviceCapabilities: { status: "implemented", formats: ["openai"] },
};
const service = {
  id: "s",
  name: "Service",
  endpoint: "https://old.example",
  format: "openai",
  models: ["m"],
  demoKey: true,
};
const choice = {
  agent: "A",
  agentId: "a",
  model: "m",
  source: "Service",
  serviceId: "s",
  serviceSnapshot: service,
  accessMode: "api",
};
test("new-from-history rejects changed destinations, missing identity and removed services", () => {
  assert.equal(historySourceIssue(choice, [agent], [service]), "");
  assert.ok(
    historySourceIssue(
      choice,
      [agent],
      [{ ...service, endpoint: "https://different.example" }],
    ),
  );
  assert.ok(
    historySourceIssue(
      { ...choice, serviceSnapshot: null },
      [agent],
      [service],
    ),
  );
  assert.ok(historySourceIssue(choice, [agent], []));
  assert.ok(
    historySourceIssue(choice, [{ ...agent, removed: true }], [service]),
  );
  assert.ok(
    historySourceIssue(
      {
        ...choice,
        accessMode: "unknown",
        serviceId: undefined,
        model: "未提供原模型",
        originalModelKnown: false,
      },
      [agent],
      [service],
    ),
  );
  assert.equal(
    historySourceIssue(
      choice,
      [agent],
      [{ ...service, name: "Renamed", secretRevision: 2 }],
    ),
    "",
  );
});
test("temporarily saved resend contents protect library deletion even if replacement is emptied", () => {
  const task = {
    status: "done",
    draft: "",
    attachments: [],
    resendDraft: { previousDraft: "keep me", previousAttachments: [] },
  };
  assert.ok(hasUnsentContent(task));
  assert.ok(libraryProtection(task));
  assert.ok(
    libraryProtection({
      ...task,
      resendDraft: { previousDraft: "", previousAttachments: ["file.md"] },
    }),
  );
});
test("saved drafts and notification preferences survive prototype restart without sending", () => {
  const result = preserveDraft(current, next, [], "draft");
  const state = restorePrototypeSnapshot(
    makePrototypeSnapshot({
      ...result,
      tasks: [],
      notificationPreferences: { enabled: true, sound: true },
    }),
  );
  assert.deepEqual(state.savedDrafts[0].draft, current);
  assert.deepEqual(state.notificationPreferences, {
    enabled: true,
    sound: true,
  });
  assert.equal(state.pendingSend, null);
});
