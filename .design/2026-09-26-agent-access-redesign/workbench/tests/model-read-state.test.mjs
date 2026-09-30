import test from "node:test";
import assert from "node:assert/strict";
import {
  beginModelRead,
  finishModelRead,
  modelReadScope,
  currentModelOptions,
} from "../src/model-read-state.js";
import {
  normalizeAgent,
  preparedAgent,
  setupChoiceIssue,
  setupCompletionIssue,
  initialSetupDraft,
} from "../src/agent-setup-state.js";
import { admittedConversation, makeAttempt } from "../src/workbench-state.js";
import { serviceChoiceIssue } from "../src/service-access.js";
const agent = {
    id: "sample",
    connected: true,
    models: [],
    selectedInstallationId: "one",
  },
  choice = { access: "existing", folder: "/a" };
test("unknown model capability can resolve to options or explicitly unavailable", () => {
  for (const [outcome, status] of [
    ["choices", "ready"],
    ["none", "not-provided"],
    ["failure", "failed"],
  ]) {
    const next = finishModelRead(
      beginModelRead(agent, choice, outcome),
      choice,
      modelReadScope(agent, choice),
    );
    assert.equal(next.modelCatalog.status, status);
    assert.equal(next.model, undefined, "reading does not select a model");
    assert.equal(
      currentModelOptions(next, choice).length,
      outcome === "choices" ? 2 : 0,
    );
  }
});
test("an old read cannot populate a different program or working folder", () => {
  const started = beginModelRead(agent, choice);
  const scope = modelReadScope(agent, choice);
  assert.equal(
    finishModelRead(started, { ...choice, folder: "/b" }, scope),
    started,
  );
  const changed = { ...started, connectionRevision: 1 };
  assert.equal(finishModelRead(changed, choice, scope), changed);
  const completed = finishModelRead(started, choice, scope);
  assert.deepEqual(
    currentModelOptions(completed, { ...choice, folder: "/b" }),
    [],
  );
});
test("failure keeps selected model and permits explicit retry", () => {
  const selected = { ...agent, model: "chosen", models: ["chosen"] };
  const failed = finishModelRead(
    beginModelRead(selected, choice, "failure"),
    choice,
    modelReadScope(selected, choice),
  );
  assert.equal(failed.model, "chosen");
  assert.deepEqual(currentModelOptions(failed, choice), ["chosen"]);
  assert.equal(beginModelRead(failed, choice).modelCatalog.status, "loading");
});

test("newly read choices govern preparation: empty or unknown models are rejected and the selected model survives return and send", () => {
  const ready = finishModelRead(
    beginModelRead(
      normalizeAgent({
        ...agent,
        name: "Sample",
        installed: true,
        registered: true,
      }),
      choice,
    ),
    choice,
    modelReadScope(agent, choice),
  );
  assert.match(
    setupCompletionIssue(ready, { ...choice, model: "" }, []),
    /模型/,
  );
  assert.match(
    setupChoiceIssue(ready, { ...choice, model: "unlisted" }, []),
    /模型/,
  );
  const selected = { ...choice, model: "演示模型 A", effort: "" };
  assert.equal(setupChoiceIssue(ready, selected, []), null);
  const prepared = preparedAgent(ready, selected, []);
  assert.equal(prepared.model, "演示模型 A");
  assert.equal(initialSetupDraft(prepared).model, "演示模型 A");
  const sendChoice = {
    agent: prepared.name,
    accessMode: "existing",
    model: prepared.model,
    effort: prepared.effort,
  };
  assert.equal(serviceChoiceIssue(sendChoice, prepared, []), null);
  const admitted = admittedConversation(
    makeAttempt({
      id: "model-read-send",
      text: "hello",
      files: [],
      folder: choice.folder,
      choice: sendChoice,
      outcome: "success",
    }),
  );
  assert.equal(admitted.model, "演示模型 A");
});

test("refresh failure preserves the same selection's last successful list while an explicit no-list result allows Agent settings", () => {
  const prepared = normalizeAgent({
    ...agent,
    installed: true,
    registered: true,
    models: ["outdated"],
    modelCatalog: {
      scope: modelReadScope(agent, choice),
      status: "ready",
      values: ["new A", "new B"],
    },
  });
  const refreshing = beginModelRead(prepared, choice, "failure");
  assert.deepEqual(currentModelOptions(refreshing, choice), ["new A", "new B"]);
  const failed = finishModelRead(
    refreshing,
    choice,
    modelReadScope(agent, choice),
  );
  assert.deepEqual(currentModelOptions(failed, choice), ["new A", "new B"]);
  assert.equal(
    setupChoiceIssue(failed, { ...choice, model: "new B" }, []),
    null,
  );
  assert.match(
    setupChoiceIssue(failed, { ...choice, model: "outdated" }, []),
    /模型/,
  );
  const unavailable = finishModelRead(
    beginModelRead(prepared, choice, "none"),
    choice,
    modelReadScope(agent, choice),
  );
  assert.deepEqual(currentModelOptions(unavailable, choice), []);
  assert.equal(
    setupCompletionIssue(unavailable, { ...choice, model: "" }, []),
    null,
  );
});
