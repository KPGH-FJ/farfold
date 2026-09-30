import test from "node:test";
import assert from "node:assert/strict";
import {
  initialApiDraft,
  changeApiDraft,
  confirmDemoKey,
  draftKeyReady,
  savedApiRecord,
  apiEndpointIssue,
  createDiagnosticScope,
  apiDraftIssue,
  filterApiServices,
} from "../src/api-editor-state.js";
import {
  continuationIssue,
  agentServiceFormats,
  compatibleServices,
} from "../src/service-access.js";

const service = {
  id: "service-one",
  name: "Shared",
  provider: "Team",
  endpoint: "https://example.test/v1",
  format: "responses",
  models: ["a", "b"],
  demoKey: true,
  revision: 0,
  secretRevision: 0,
};
const task = {
  accessMode: "api",
  serviceId: service.id,
  source: service.name,
  model: "a",
  serviceSnapshot: structuredClone(service),
};

test("multiple models and all diagnostic formats save independently of Agent support", () => {
  let draft = initialApiDraft({ ...service, id: null, format: "messages" });
  draft = confirmDemoKey(draft);
  const saved = savedApiRecord(draft);
  assert.deepEqual(saved.models, ["a", "b"]);
  assert.equal(saved.format, "messages");
  assert.deepEqual(
    compatibleServices(
      {
        serviceCapabilities: { status: "implemented", formats: ["responses"] },
      },
      [saved],
    ),
    [],
  );
});
test("source changes require a fresh demo key, even when changed back", () => {
  let draft = changeApiDraft(
    initialApiDraft(service),
    "endpoint",
    "https://other.test/v1",
  );
  assert.equal(draftKeyReady(draft), false);
  assert.throws(() => savedApiRecord(draft), /演示密钥/);
  draft = changeApiDraft(draft, "endpoint", service.endpoint);
  assert.equal(draftKeyReady(draft), false);
  assert.equal(draftKeyReady(confirmDemoKey(draft)), true);
  assert.equal(
    draftKeyReady(
      changeApiDraft(initialApiDraft(service), "format", "messages"),
    ),
    false,
  );
});
test("renaming does not change effective configuration or old conversation identity", () => {
  const saved = savedApiRecord(
    changeApiDraft(initialApiDraft(service), "name", "Renamed"),
  );
  assert.equal(saved.revision, service.revision);
  assert.equal(continuationIssue(task, [saved]), null);
  assert.equal(task.source, "Shared");
});
test("key rotation changes subsequent connection revision but preserves old source", () => {
  const saved = savedApiRecord(confirmDemoKey(initialApiDraft(service)));
  assert.equal(saved.secretRevision, 1);
  assert.equal(saved.revision, 1);
  assert.equal(continuationIssue(task, [saved]), null);
  assert.equal(task.serviceSnapshot.secretRevision, 0);
});
test("deletion, source replacement, model removal and missing key have distinct exits", () => {
  assert.match(continuationIssue(task, []), /删除/);
  assert.match(
    continuationIssue(task, [{ ...service, deleting: true }]),
    /删除/,
  );
  assert.match(
    continuationIssue(task, [
      { ...service, endpoint: "https://other.test/v1" },
    ]),
    /地址或接口/,
  );
  assert.match(
    continuationIssue(task, [{ ...service, format: "messages" }]),
    /地址或接口/,
  );
  assert.match(
    continuationIssue(task, [{ ...service, models: ["b"] }]),
    /模型已/,
  );
  assert.match(
    continuationIssue(task, [{ ...service, demoKey: false }]),
    /密钥/,
  );
  assert.equal(continuationIssue({ accessMode: "existing" }, []), null);
});
test("old records without a source snapshot never infer identity from a matching name", () => {
  assert.match(
    continuationIssue({ source: "Shared", model: "a" }, [service]),
    /未记录完整/,
  );
  assert.match(
    continuationIssue({ ...task, serviceSnapshot: undefined }, [service]),
    /未记录完整/,
  );
});
test("cancel, close or modification invalidate only the diagnostic they own", () => {
  const scope = createDiagnosticScope();
  const old = scope.begin();
  scope.invalidate();
  const next = scope.begin();
  assert.equal(scope.finish(old), false);
  assert.equal(scope.accepts(next), true);
  assert.equal(scope.finish(next), true);
  assert.equal(scope.finish(next), false);
});
test("catalog capability limits selection, never creates routes from a name", () => {
  assert.deepEqual(agentServiceFormats({ name: "Codex" }), []);
  assert.deepEqual(
    agentServiceFormats({
      serviceCapabilities: { status: "unknown", formats: ["responses"] },
    }),
    [],
  );
  assert.deepEqual(
    agentServiceFormats({
      serviceCapabilities: { status: "implemented", formats: ["responses"] },
    }),
    ["responses"],
  );
});
test("endpoint validation matches the safe production forms without using a network", () => {
  for (const value of [
    "http://example.test/v1",
    "https://user:pass@example.test",
    "https://example.test?token=x",
    "https://example.test/v1/responses",
    "https://example.test/#fragment",
  ])
    assert.ok(apiEndpointIssue(value));
  assert.equal(apiEndpointIssue("https://example.test/v1/"), null);
});
test("saved demonstration records do not retain supplied secret-like properties", () => {
  const record = savedApiRecord(
    initialApiDraft({
      ...service,
      key: "not-a-real-key",
      apiKey: "not-a-real-key",
    }),
  );
  assert.equal("key" in record, false);
  assert.equal("apiKey" in record, false);
  assert.equal("keySource" in record, false);
});
test("saving a valid existing configuration keeps an unadded model visible as a blocking input", () => {
  const draft = initialApiDraft(service);
  assert.equal(apiDraftIssue(draft, ""), null);
  assert.match(apiDraftIssue(draft, "new-model"), /尚未添加/);
  assert.equal(apiDraftIssue(draft, "  "), null);
  assert.deepEqual(draft.models, ["a", "b"]);
});
test("API search trims whitespace, includes provider and can recover after deleting the only match", () => {
  const other = {
    ...service,
    id: "second",
    name: "Other",
    provider: "Personal",
    models: ["z"],
  };
  assert.deepEqual(filterApiServices([service, other], " team "), [service]);
  assert.deepEqual(filterApiServices([other], "Shared"), []);
  assert.deepEqual(filterApiServices([other], ""), [other]);
});
