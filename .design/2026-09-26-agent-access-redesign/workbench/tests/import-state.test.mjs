import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import {
  addedImportAgents,
  captureImportIdentity,
  createImportOperation,
  exampleConversations,
  filterImportRecords,
  importIdentity,
  importAgentReady,
  initialImportDraft,
  isImportable,
  lookupExample,
  joinedImportTasks,
  mergeImportedTasks,
  planImport,
  taskFromImport,
  toggleVisibleSelection,
  visibleImportPreview,
} from "../src/import-state.js";

const agent = {
  id: "sample-agent",
  name: "Sample Agent",
  connected: true,
  models: ["Original model"],
  effort: "High",
};
const records = exampleConversations(agent);
const allKeys = records.map((record) => record.key);

test("only added Agents appear; unknown and unprepared access does not become successful lookup", () => {
  const unknown = { id: "unknown", name: "Unknown", added: true, ready: false };
  assert.deepEqual(
    addedImportAgents([agent, unknown, { id: "catalog-only" }]),
    [agent, unknown],
  );
  assert.equal(lookupExample(unknown).lookup, "failed");
  assert.equal(lookupExample(undefined).lookup, "failed");
  assert.equal(lookupExample(agent).lookup, "loaded");
});

test("unsupported listing, empty listing, and read failure remain distinct", () => {
  assert.deepEqual(lookupExample(agent, "unsupported"), {
    lookup: "unsupported",
  });
  assert.deepEqual(lookupExample(agent, "empty"), {
    lookup: "loaded",
    records: [],
  });
  assert.equal(lookupExample(agent, "error").lookup, "failed");
  assert.equal(lookupExample(agent, "normal").records.length, 6);
});

test("normal retry replaces lookup result without changing selected keys or query", () => {
  const selected = [records[0].key, records[3].key];
  const draft = {
    ...initialImportDraft(),
    selected,
    query: "文案",
    previewId: records[3].externalId,
  };
  const failed = { ...draft, ...lookupExample(agent, "error") };
  const retried = { ...failed, ...lookupExample(agent) };
  assert.deepEqual(retried.selected, selected);
  assert.equal(retried.query, "文案");
  assert.equal(retried.previewId, records[3].externalId);
  assert.equal(retried.records.length, 6);
});

test("select all applies only to visible importable records and preserves hidden selections", () => {
  const existing = [taskFromImport(records[0])];
  const chosen = toggleVisibleSelection([], records, existing);
  assert.equal(chosen.length, 4);
  assert.ok(!chosen.includes(records[0].key));
  assert.ok(!chosen.includes(records[4].key));
  const visible = filterImportRecords(records, "搜索框");
  const hidden = [records[2].key];
  const selected = toggleVisibleSelection(hidden, visible, []);
  assert.deepEqual(
    new Set(selected),
    new Set([records[2].key, records[1].key]),
  );
  assert.deepEqual(toggleVisibleSelection(selected, visible, []), hidden);
  assert.deepEqual(filterImportRecords(records, "没有这个标题"), []);
});

test("no directory is required for import or continuation", () => {
  const task = taskFromImport(records[0]);
  assert.equal(task.folder, "");
  assert.equal(task.readOnly, false);
  assert.equal(task.importStatus, "continuable");
  assert.deepEqual(task.importedMessages, records[0].messages);
  assert.equal(
    task.simulatePending,
    undefined,
    "import must not trigger a new response",
  );
  assert.equal(
    task.resultMode,
    undefined,
    "import must not borrow an engineering sample",
  );
});

test("read-only and missing-location histories stay read-only with original identities", () => {
  for (const record of [records[2], records[3]]) {
    const task = taskFromImport(record);
    assert.equal(task.readOnly, true);
    assert.equal(task.readOnlyReason, record.reason);
    assert.equal(task.folder, record.folder);
    assert.equal(task.externalConversationId, record.externalId);
    assert.equal(task.importKey, importIdentity(agent.id, record.externalId));
    assert.equal(task.model, record.model);
    assert.equal(task.effort, record.effort);
  }
  assert.equal(taskFromImport(records[3]).importedLocationMissing, true);
  assert.equal(taskFromImport(records[2]).importedLocationMissing, false);
});

test("unreadable history cannot be imported as an empty conversation", () => {
  assert.equal(isImportable(records[4]), false);
  const result = planImport(records, [records[4].key], []);
  assert.equal(result.tasks.length, 0);
  assert.equal(result.failures.length, 1);
});

test("partial import preserves successful tasks and retries only the failed item", () => {
  const chosen = records
    .filter((record) => isImportable(record))
    .map((record) => record.key);
  const first = planImport(records, chosen, []);
  assert.equal(first.tasks.length, 4);
  assert.equal(first.failures.length, 1);
  const retry = planImport(records, chosen, first.tasks, first.attempts);
  assert.equal(retry.tasks.length, 1);
  assert.equal(retry.failures.length, 0);
  assert.equal(retry.skipped.length, 4);
  const merged = mergeImportedTasks(first.tasks, retry.tasks);
  assert.equal(merged.length, 5);
  const again = planImport(records, allKeys, merged, retry.attempts);
  assert.equal(again.tasks.length, 0);
  assert.equal(again.skipped.length, 5);
  assert.equal(again.failures.length, 1, "only unreadable entry remains");
});

test("duplicate identity uses Agent plus external id, never title", () => {
  const first = taskFromImport(records[0]);
  const otherAgent = exampleConversations({ ...agent, id: "another-agent" })[0];
  const sameTitle = taskFromImport(otherAgent);
  assert.equal(first.title, sameTitle.title);
  assert.notEqual(first.importKey, sameTitle.importKey);
  assert.equal(
    mergeImportedTasks([first], [first, sameTitle, sameTitle]).length,
    2,
  );
  const duplicateRecords = [records[0], { ...records[0] }];
  assert.equal(
    planImport(duplicateRecords, [first.importKey], []).tasks.length,
    1,
  );
});

test("cancel before submission preserves selection and prevents the callback", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const selected = [records[0].key];
  const busy = [];
  let calls = 0;
  const operation = createImportOperation((value) => busy.push(value));
  operation.begin("import", agent.id, () => calls++, 450);
  t.mock.timers.tick(300);
  assert.equal(operation.cancel(), true);
  t.mock.timers.tick(500);
  assert.equal(calls, 0);
  assert.deepEqual(selected, [records[0].key]);
  assert.deepEqual(busy, ["import", null]);
  operation.dispose();
});

test("close and reopen cannot submit a batch twice while its callback is pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolve,
    calls = 0,
    completed = 0;
  const deferred = new Promise((done) => {
    resolve = done;
  });
  const operation = createImportOperation(() => {});
  const submit = () =>
    operation.begin(
      "import",
      agent.id,
      async (request) => {
        operation.commit(request);
        calls++;
        await deferred;
        if (!operation.isCurrent(request)) return;
        completed++;
        operation.finish(request);
      },
      450,
    );
  assert.equal(submit(), true);
  t.mock.timers.tick(450);
  assert.equal(operation.active.stage, "committing");
  assert.equal(
    operation.cancel(),
    false,
    "close must not claim to cancel an admitted batch",
  );
  assert.equal(submit(), false, "reopen retains the in-flight lock");
  assert.equal(calls, 1);
  resolve();
  await deferred;
  assert.equal(completed, 1);
  assert.equal(operation.active, null);
  operation.dispose();
});

test("late completion from a disposed import cannot replace a newer operation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const operation = createImportOperation(() => {});
  let resolve,
    writes = 0;
  const deferred = new Promise((done) => {
    resolve = done;
  });
  operation.begin(
    "import",
    "old-agent",
    async (request) => {
      operation.commit(request);
      await deferred;
      if (!operation.isCurrent(request)) return;
      writes++;
      operation.finish(request);
    },
    1,
  );
  t.mock.timers.tick(1);
  operation.dispose();
  operation.begin("lookup", "new-agent", () => {}, 650);
  resolve();
  await deferred;
  assert.equal(writes, 0);
  assert.equal(operation.active.owner, "new-agent");
  operation.dispose();
});

test("disconnect is authoritative even when previous setup metadata remains", () => {
  const disconnected = {
    ...agent,
    connected: false,
    added: true,
    setupComplete: true,
  };
  assert.equal(importAgentReady(disconnected), false);
  assert.equal(lookupExample(disconnected).lookup, "failed");
  assert.equal(
    importAgentReady({ ...disconnected, demoReady: true }),
    true,
    "an explicitly prepared local proposal can still be previewed",
  );
});

test("changing current Agent settings does not rewrite a discovered history identity", () => {
  const identity = captureImportIdentity(agent);
  const first = lookupExample(agent, "normal", identity);
  const changed = { ...agent, model: "Changed current model", effort: "Low" };
  const retried = lookupExample(changed, "normal", identity);
  assert.equal(first.records[0].key, retried.records[0].key);
  assert.equal(retried.records[0].model, first.records[0].model);
  assert.equal(retried.records[0].effort, first.records[0].effort);
  assert.notEqual(first.records[0].model, agent.models[0]);
  assert.equal(captureImportIdentity(changed).model, undefined);
  assert.notEqual(first.records[0].model, first.records[1].model);
  const imported = taskFromImport(first.records[0]);
  const afterReopen = lookupExample(changed, "normal", undefined, [imported]);
  assert.equal(afterReopen.records[0].model, imported.model);
  assert.equal(afterReopen.records[0].effort, imported.effort);
});

test("a historical record missing its model stays read-only even when the current Agent has a model", () => {
  const record = lookupExample(agent).records.find(
    (item) => item.externalId === "sample-reading",
  );
  assert.equal(record.status, "readOnly");
  assert.equal(taskFromImport(record).readOnly, true);
  assert.equal(record.originalModelKnown, false);
  assert.equal(record.model, "未提供原模型");
  assert.match(record.reason, /没有提供原模型/);
});

test("import retains the record's service identity without borrowing present Agent choices", () => {
  const record = {
    ...records[0],
    source: "历史服务",
    accessMode: "api",
    serviceId: "original-service",
    serviceSnapshot: {
      id: "original-service",
      endpoint: "https://history.example.test/v1",
      format: "responses",
    },
  };
  const task = taskFromImport(record);
  assert.equal(task.serviceId, record.serviceId);
  assert.deepEqual(task.serviceSnapshot, record.serviceSnapshot);
  assert.notEqual(task.serviceSnapshot, record.serviceSnapshot);
  assert.equal(task.lifecycle, "established");
});

test("search preview always belongs to the visible result set and can restore the previous selection", () => {
  const previous = records[3].externalId;
  assert.equal(
    visibleImportPreview(records, "周末", previous).externalId,
    records[0].externalId,
  );
  assert.equal(
    visibleImportPreview(records, "nothing-matches", previous),
    null,
  );
  assert.equal(
    visibleImportPreview(records, "", previous).externalId,
    previous,
  );
});

test("opening an imported item uses current parent data instead of the acknowledgement snapshot", () => {
  const old = taskFromImport(records[0]);
  const current = {
    ...old,
    title: "My current title",
    draft: "Keep this draft",
    archived: true,
  };
  assert.equal(joinedImportTasks([current], [old]).get(old.importKey), current);
  assert.equal(
    joinedImportTasks([current, { id: "unrelated" }], [old]).size,
    1,
  );
});

test("imported history is copied without mutating records or existing tasks", () => {
  const snapshot = structuredClone(records);
  const task = taskFromImport(records[0]);
  task.importedMessages[0].text = "changed in local task";
  assert.deepEqual(records, snapshot);
  const existing = [{ id: "keep", draft: "keep draft" }];
  mergeImportedTasks(existing, [task]);
  assert.deepEqual(existing, [{ id: "keep", draft: "keep draft" }]);
});

let server, ImportConversations;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
    logLevel: "error",
  });
  ({ default: ImportConversations } = await server.ssrLoadModule(
    "/src/ImportConversations.jsx",
  ));
});
after(async () => server?.close());

test("actual import component renders the proposal and has a truthful no-Agent exit", () => {
  const render = (props) =>
    renderToStaticMarkup(
      React.createElement(ImportConversations, {
        agents: [],
        tasks: [],
        onClose() {},
        onExplore() {},
        onImport() {},
        ...props,
      }),
    );
  const empty = render({});
  assert.ok(empty.includes("还没有已添加的 Agent"));
  assert.ok(empty.includes("去添加 Agent"));
  assert.ok(empty.includes("不读取真实 Agent 历史"));
  const normal = render({ agents: [agent] });
  assert.ok(normal.includes("Sample Agent"));
  assert.ok(normal.includes("查找示例对话"));
  assert.equal(render({ open: false }), "");
});
