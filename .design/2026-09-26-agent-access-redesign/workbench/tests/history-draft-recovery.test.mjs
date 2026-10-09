import test from "node:test";
import assert from "node:assert/strict";
import {
  historySourceIssue,
  preserveDraft,
} from "../src/history-start-state.js";
import { modelReadScope } from "../src/model-read-state.js";
import {
  makePrototypeSnapshot,
  restorePrototypeSnapshot,
} from "../src/prototype-persistence.js";
import {
  startConfigurationChange,
  finishConfigurationChange,
} from "../src/conversation-configuration.js";

const agent = { id: "a", name: "A", models: ["current-model"] };
const choice = {
  agentId: "a",
  agent: "A",
  model: "retired-model",
  accessMode: "existing",
  source: "沿用已有设置",
};

test("history restart rejects a removed existing-setting model while accepting an available model", () => {
  assert.match(
    historySourceIssue(choice, [agent], [], "/p"),
    /不在当前可选列表/,
  );
  assert.equal(
    historySourceIssue(
      { ...choice, model: "current-model" },
      [agent],
      [],
      "/p",
    ),
    "",
  );
});

test("history restart checks the model list for the chosen folder, rather than another folder's list", () => {
  const folderAgent = {
    ...agent,
    modelCatalog: {
      status: "ready",
      scope: modelReadScope(agent, {
        access: "existing",
        folder: "/special",
        serviceId: "",
      }),
      values: ["special-model"],
    },
  };
  const selected = { ...choice, model: "special-model" };
  assert.equal(historySourceIssue(selected, [folderAgent], [], "/special"), "");
  assert.match(
    historySourceIssue(selected, [folderAgent], [], "/other"),
    /不在当前可选列表/,
  );
  assert.match(
    historySourceIssue(
      { ...choice, model: "current-model" },
      [folderAgent],
      [],
      "/special",
    ),
    /不在当前可选列表/,
  );
});

test("an unavailable model list is unknown, not proof that the historical model remains available", () => {
  assert.match(
    historySourceIssue(choice, [{ ...agent, models: [] }], [], "/p"),
    /未提供可核对的模型列表/,
  );
});

function pendingDraft() {
  const task = {
    ...choice,
    model: "current-model",
    id: "new-draft",
    status: "draft",
    folder: "/p",
    effort: "low",
    configurationPreviewResult: "success",
  };
  const capability = {
    models: ["current-model", "next-model"],
    supportsModelChange: true,
  };
  const change = startConfigurationChange(
    task,
    capability,
    { model: "next-model", effort: "low" },
    "change-1",
  );
  return {
    text: "原草稿",
    files: ["notes.md"],
    folder: "/p",
    choice: { ...task, ...change },
  };
}

test("putting an in-flight draft aside retains both settings but makes its missing future receipt checkable", () => {
  const current = pendingDraft();
  const next = { text: "另一份草稿", files: [], folder: "/q", choice };
  const result = preserveDraft(current, next, [], "saved");
  const saved = result.savedDrafts[0].draft;
  assert.equal(saved.choice.configurationChange.phase, "unknown");
  assert.equal(saved.choice.model, "current-model");
  assert.equal(saved.choice.configurationChange.next.model, "next-model");
  assert.equal(current.choice.configurationChange.phase, "pending");
  assert.deepEqual(saved.files, ["notes.md"]);
  const restored = preserveDraft(
    next,
    saved,
    result.savedDrafts,
    "second",
    "saved",
  );
  const checked = finishConfigurationChange(
    restored.draft.choice,
    "change-1",
    "success",
  );
  assert.equal(checked.model, "next-model");
  assert.equal(checked.configurationChange, null);
  assert.equal(restored.savedDrafts[0].draft.text, "另一份草稿");
});

test("restart also normalizes older saved draft receipts, so restoring cannot leave a lost timer pending forever", () => {
  const saved = pendingDraft();
  const snapshot = makePrototypeSnapshot({
    tasks: [],
    draft: { text: "当前草稿", files: [], folder: "/q", choice },
    savedDrafts: [{ id: "legacy", title: "此前保留的草稿", draft: saved }],
  });
  const restored = restorePrototypeSnapshot(snapshot);
  const preserved = restored.savedDrafts[0].draft;
  assert.equal(preserved.choice.configurationChange.phase, "unknown");
  assert.equal(preserved.choice.model, "current-model");
  assert.equal(preserved.choice.configurationChange.next.model, "next-model");
  assert.equal(restored.draft.text, "当前草稿");
  assert.equal(restored.pendingSend, null);
  assert.equal(
    snapshot.savedDrafts[0].draft.choice.configurationChange.phase,
    "pending",
  );
});
