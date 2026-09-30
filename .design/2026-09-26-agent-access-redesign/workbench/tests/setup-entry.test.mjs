import assert from "node:assert/strict";
import test from "node:test";
import { draftForEntry, preparationEntryKey } from "../src/setup-entry.js";
const agent = { id: "a", name: "Agent A", models: ["M1", "M2"], model: "M1" };
const selection = {
  agentId: "a",
  accessMode: "existing",
  model: "M1",
  effort: "high",
};
const context = { view: "new", folder: "/A" };
test("leaving and reopening the same preparation keeps its unconfirmed choices", () => {
  const draft = draftForEntry(agent, [], selection, context);
  const changed = {
    ...agent,
    setupDraft: { ...draft, model: "M2", effort: "low" },
  };
  const resumed = draftForEntry(changed, [], selection, context);
  assert.equal(resumed.model, "M2");
  assert.equal(resumed.effort, "low");
  assert.equal(selection.model, "M1");
});
test("preparing another work location starts from that entry's own choice", () => {
  const draft = draftForEntry(agent, [], selection, context);
  const changed = {
    ...agent,
    setupDraft: {
      ...draft,
      model: "M2",
      test: "passed",
      testFingerprint: "old",
    },
  };
  const other = draftForEntry(changed, [], selection, {
    ...context,
    folder: "/B",
  });
  assert.equal(other.model, "M1");
  assert.equal(other.folder, "/B");
  assert.equal(other.test, "idle");
});
test("distinct existing conversations do not share unfinished preparation", () => {
  assert.notEqual(
    preparationEntryKey(agent, selection, {
      view: "thread",
      active: "one",
      folder: "/A",
    }),
    preparationEntryKey(agent, selection, {
      view: "thread",
      active: "two",
      folder: "/A",
    }),
  );
});
test("explicit existing source drops an old saved-service ID", () => {
  const draft = draftForEntry(
    agent,
    [],
    { ...selection, serviceId: "stale" },
    context,
  );
  assert.equal(draft.access, "existing");
  assert.equal(draft.serviceId, "");
});
test("L01: entering preparation keeps the original API source snapshot", () => {
  const service = {
    id: "s",
    endpoint: "https://old.example/v1",
    format: "responses",
  };
  const selected = {
    ...selection,
    accessMode: "api",
    serviceId: "s",
    serviceSnapshot: service,
  };
  const result = draftForEntry(
    agent,
    [{ ...service, endpoint: "https://new.example/v1" }],
    selected,
    context,
  );
  assert.deepEqual(result.serviceSnapshot, service);
  assert.notEqual(result.serviceSnapshot, service);
});

test("an explicitly changed API source or configuration cannot reuse an older preparation draft", () => {
  const original = {
    ...selection,
    accessMode: "api",
    serviceId: "s",
    serviceSnapshot: {
      id: "s",
      name: "Original label",
      endpoint: "https://old.example/v1",
      format: "responses",
      revision: 1,
      secretRevision: 2,
    },
  };
  const saved = {
    ...agent,
    setupDraft: {
      ...draftForEntry(agent, [], original, context),
      model: "M2",
      test: "passed",
      testFingerprint: "older-source",
    },
  };
  for (const change of [
    { endpoint: "https://new.example/v1" },
    { format: "chat-completions" },
    { revision: 2 },
    { secretRevision: 3 },
  ]) {
    const current = {
      ...original,
      serviceSnapshot: { ...original.serviceSnapshot, ...change },
    };
    assert.notEqual(
      preparationEntryKey(agent, current, context),
      preparationEntryKey(agent, original, context),
    );
    const result = draftForEntry(saved, [], current, context);
    assert.deepEqual(result.serviceSnapshot, current.serviceSnapshot);
    assert.equal(result.model, current.model);
    assert.equal(result.test, "idle");
  }
});

test("an API display rename keeps the same suspended preparation and its unconfirmed model", () => {
  const original = {
    ...selection,
    accessMode: "api",
    serviceId: "s",
    serviceSnapshot: {
      id: "s",
      name: "Old label",
      endpoint: "https://a.example/v1",
      format: "responses",
      revision: 1,
    },
  };
  const renamed = {
    ...original,
    serviceSnapshot: { ...original.serviceSnapshot, name: "Renamed" },
  };
  const saved = {
    ...agent,
    setupDraft: { ...draftForEntry(agent, [], original, context), model: "M2" },
  };
  assert.equal(
    preparationEntryKey(agent, renamed, context),
    preparationEntryKey(agent, original, context),
  );
  assert.equal(draftForEntry(saved, [], renamed, context).model, "M2");
});
