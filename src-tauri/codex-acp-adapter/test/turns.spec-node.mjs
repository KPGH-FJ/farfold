import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurns, projectItem } from "../turns.mjs";
const nativeThreadId = "019a0000-0000-7000-8000-000000000001";
const nativeSessionId = "019a0000-0000-7000-8000-000000000002";
const turnId = "019a0000-0000-7000-8000-000000000003";
const metadata = {
  nativeThreadId,
  nativeSessionId,
  cwd: process.cwd(),
  path: null,
  status: "idle",
  cliVersion: "0.143.0",
};
const context = {
  farfoldSessionId: "farfold-session",
  hostTurnId: "host-turn",
  workingCopyId: "worktree",
  thread: metadata,
};
const nativeTurn = (status = "inProgress", items = []) => ({
  id: turnId,
  items,
  itemsView: "full",
  status,
  error: null,
});
function fixture(
  enabled = true,
  native = async () => ({ turn: nativeTurn() }),
) {
  const calls = [],
    retained = [],
    events = [];
  const turns = createTurns({
    request: async (method, params) => {
      calls.push({ method, params });
      return native(method, params);
    },
    launch: {
      cwd: process.cwd(),
      codexHome: "/synthetic",
      workingCopyId: "worktree",
    },
    threads: { bound: () => metadata },
    enabled,
    retain: (v) => retained.push(v),
    publish: (v) => events.push(v),
  });
  const observe = (method, params) => turns.observe({ method, params });
  return { turns, calls, retained, events, observe };
}
test("production capability gate rejects Turn and history without a native request", async () => {
  const f = fixture(false);
  await assert.rejects(
    f.turns.command({ action: "start", context, text: "test" }),
  );
  await assert.rejects(f.turns.history(metadata));
  assert.equal(f.calls.length, 0);
});
test("early completion is correlated only after native start reply; foreign/late never drives the next reservation", async () => {
  let finish;
  const f = fixture(
    true,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.turns.command({ action: "start", context, text: "test" });
  f.observe("turn/started", { threadId: nativeThreadId, turn: nativeTurn() });
  f.observe("turn/completed", {
    threadId: nativeThreadId,
    turn: nativeTurn("completed"),
  });
  assert.equal(f.events.length, 0);
  finish({ turn: nativeTurn() });
  await pending;
  assert.deepEqual(
    f.events.map((e) => e.kind),
    ["started", "terminal"],
  );
  f.observe("turn/completed", {
    threadId: nativeThreadId,
    turn: nativeTurn("completed"),
  });
  assert.equal(f.events.length, 2);
  assert.equal(f.turns.pending(), false);
});
test("native item IDs are opaque and validated; unknown fields remain private", async () => {
  const f = fixture();
  await f.turns.command({ action: "start", context, text: "test" });
  const p = { threadId: nativeThreadId, turnId };
  const item = {
    type: "agentMessage",
    id: "native-item-not-an-index",
    text: "answer",
    apiKey: "PRIVATE-EXTRA",
  };
  f.observe("item/started", { ...p, item, startedAtMs: 1 });
  f.observe("item/agentMessage/delta", {
    ...p,
    itemId: item.id,
    delta: "answer",
    extra: "PRIVATE-DELTA",
  });
  f.observe("item/completed", { ...p, item, completedAtMs: 2 });
  assert.ok(!JSON.stringify(f.events).includes("PRIVATE"));
  assert.ok(JSON.stringify(f.retained).includes("PRIVATE"));
  assert.throws(() =>
    f.observe("item/agentMessage/delta", {
      ...p,
      itemId: "inferred-item-0",
      delta: "wrong",
    }),
  );
});
test("unsupported items are retained but do not authorize a terminal or item projection", async () => {
  const f = fixture();
  await f.turns.command({ action: "start", context, text: "test" });
  f.observe("item/started", {
    threadId: nativeThreadId,
    turnId,
    item: { type: "future", id: "unknown", secret: "PRIVATE" },
    startedAtMs: 1,
  });
  assert.equal(f.events.length, 0);
  assert.equal(f.turns.pending(), true);
  assert.equal(f.retained.length, 2);
  assert.deepEqual(
    projectItem({
      type: "commandExecution",
      id: "native-command",
      status: "completed",
      command: "PRIVATE",
      aggregatedOutput: "PRIVATE",
    }),
    { type: "commandExecution", id: "native-command", status: "completed" },
  );
});
test("unknown start outcome blocks a second native request; terminal state is never synthesized", async () => {
  const f = fixture(true, async () => {
    throw Error("synthetic native failure");
  });
  await assert.rejects(
    f.turns.command({ action: "start", context, text: "test" }),
  );
  await assert.rejects(
    f.turns.command({ action: "start", context, text: "retry" }),
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.turns.pending(), true);
  assert.equal(f.events.length, 0);
});
test("unresolved known command cannot be hidden by a terminal envelope", async () => {
  const f = fixture();
  await f.turns.command({ action: "start", context, text: "test" });
  f.observe("item/started", {
    threadId: nativeThreadId,
    turnId,
    item: {
      type: "commandExecution",
      id: "native-command",
      status: "inProgress",
    },
    startedAtMs: 1,
  });
  assert.throws(() =>
    f.observe("turn/completed", {
      threadId: nativeThreadId,
      turn: nativeTurn("completed"),
    }),
  );
  assert.ok(f.events.every((e) => e.kind !== "terminal"));
});
