import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewAgents,
  managementRequest,
  preparationSelection,
} from "../src/review-navigation.js";
import { firstUseState, exampleState } from "../src/scene-state.js";
import { setupContextForEntry } from "../src/preparation-navigation.js";
import { preparationReturn } from "../src/workbench-state.js";
const base = firstUseState().agents;
const demo = exampleState().agents;
test("guided examples do not restore explicitly removed agents", () => {
  const removed = { ...base.find((a) => a.name === "Codex"), removed: true };
  assert.deepEqual(reviewAgents([removed], demo, base)[0], removed);
});
test("guided examples preserve an unfinished preparation and its program choice", () => {
  const preparing = {
    ...base.find((a) => a.name === "Codex"),
    setupDraft: { model: "user choice" },
    accessJob: { kind: "install" },
  };
  assert.deepEqual(reviewAgents([preparing], demo, base)[0], preparing);
});
test("guided examples can initialize only untouched baseline fixtures", () => {
  assert.equal(
    reviewAgents(base, demo, base).find((a) => a.name === "Codex").connected,
    true,
  );
});
test("global management reached from a conversation drops its editing context", () => {
  const entry = {
    view: "thread",
    active: "old",
    folder: "/example/project",
    choice: { agent: "Codex", model: "old" },
    ...managementRequest(),
  };
  const context = setupContextForEntry(entry);
  assert.equal(context.view, "agents");
  assert.equal(context.active, null);
  assert.equal(context.folder, "");
  assert.equal(preparationSelection(entry, { agent: "Pi" }), null);
  assert.deepEqual(preparationReturn(entry), { view: "agents", active: null });
});
test("conversation repair keeps its precise choice", () => {
  const selected = { agent: "Codex", model: "old" };
  assert.equal(
    preparationSelection({ view: "thread", choice: selected }, { agent: "Pi" }),
    selected,
  );
});
