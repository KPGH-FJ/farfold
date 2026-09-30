import assert from "node:assert/strict";
import { preparationIntentEntry } from "../src/setup-entry.js";
import test from "node:test";
import {
  setupContextForEntry,
  preparationWork,
  conversationPreparationRequest,
} from "../src/preparation-navigation.js";
import {
  preparationEntry,
  preparationReturn,
  completePreparation,
  authScopeKey,
} from "../src/workbench-state.js";
import { draftForEntry } from "../src/setup-entry.js";
import { selectionMatchesAgent } from "../src/setup-entry.js";

test("starting another Agent from a conversation prepares the new draft and retains only its return destination", () => {
  const entry = {
    view: "thread",
    active: "old-conversation",
    contextView: "thread",
    contextActive: "old-conversation",
    folder: "/old",
    choice: { agent: "old", model: "old-model" },
    panel: "account",
    repair: "account",
  };
  const draft = {
    text: "新任务",
    files: ["new.md"],
    folder: "/new",
    choice: { agent: "new", model: "new-model" },
  };
  const next = preparationIntentEntry(entry, "use", draft);
  const context = setupContextForEntry(next);
  assert.equal(context.view, "new");
  assert.equal(context.active, null);
  assert.equal(context.folder, "/new");
  assert.equal(context.repair, undefined);
  assert.deepEqual(next.choice, draft.choice);
  assert.deepEqual(preparationReturn(next), {
    view: "thread",
    active: "old-conversation",
  });
  assert.equal(
    setupContextForEntry(preparationIntentEntry(entry, "manage", draft)).active,
    "old-conversation",
  );
});

test("same-name Agents retain distinct authentication and settings targets", () => {
  const one = { id: "one", name: "同名" };
  const two = { id: "two", name: "同名" };
  const choice = { agent: "同名", agentId: "two", accessMode: "existing" };
  assert.equal(selectionMatchesAgent(one, choice), false);
  assert.equal(selectionMatchesAgent(two, choice), true);
  assert.notEqual(
    authScopeKey({ choice }),
    authScopeKey({ choice: { ...choice, agentId: "one" } }),
  );
});

test("conversation repair retains the owning task through settings and leaves the new draft untouched", () => {
  const task = {
    id: "thread-a",
    agent: "同名 Agent",
    agentId: "second",
    title: "原任务",
    folder: "/A",
    model: "original",
    effort: "High",
    accessMode: "api",
    serviceId: "service-a",
    serviceSnapshot: {
      id: "service-a",
      endpoint: "https://example.invalid",
      revision: 2,
    },
  };
  const draft = {
    text: "另一个未发送草稿",
    files: ["brief.md"],
    folder: "/B",
    choice: { agent: "别的 Agent", model: "other" },
  };
  const entry = {
    ...preparationEntry({
      view: "thread",
      active: task.id,
      tasks: [task],
      draft,
    }),
    ...conversationPreparationRequest(task, {
      panel: "model",
      reason: "检查原来的选择",
    }),
  };
  const context = setupContextForEntry(entry);
  assert.deepEqual(
    {
      view: context.view,
      active: context.active,
      panel: context.panel,
      folder: context.folder,
    },
    { view: "thread", active: "thread-a", panel: "model", folder: "/A" },
  );
  assert.match(context.reason, /原任务.*检查原来的选择/);
  const agent = {
    id: "second",
    name: "同名 Agent",
    models: ["new-default"],
    model: "new-default",
  };
  const prepared = draftForEntry(agent, [], entry.choice, context);
  assert.equal(prepared.model, "original");
  assert.equal(prepared.effort, "High");
  assert.deepEqual(prepared.serviceSnapshot, task.serviceSnapshot);
  assert.notEqual(prepared.serviceSnapshot, task.serviceSnapshot);
  const result = completePreparation(entry, draft, {
    agent: agent.name,
    model: "new-default",
  });
  assert.equal(result.applyChoice, false);
  assert.equal(result.draft, draft);
  assert.deepEqual(preparationReturn(entry), {
    view: "thread",
    active: task.id,
  });
});

test("a settings detour keeps the conversation identity and the exact repair target", () => {
  const context = setupContextForEntry({
    view: "settings",
    active: "other",
    contextView: "thread",
    contextActive: "owner",
    folder: "/original",
    repair: "account",
    panel: "account",
  });
  assert.equal(context.view, "thread");
  assert.equal(context.active, "owner");
  assert.equal(context.folder, "/original");
  assert.equal(context.repair, "account");
});

test("a first message still being submitted protects authentication without linking to nonexistent history", () => {
  const tasks = [{ id: "existing", agent: "A", status: "done" }];
  const next = preparationWork(tasks, {
    id: "pending",
    draft: { choice: { agent: "B", model: "M" } },
  });
  assert.equal(tasks.length, 1);
  assert.equal(next[1].status, "submitting");
  assert.equal(next[1].canOpen, false);
  assert.equal(next[1].agent, "B");
});
