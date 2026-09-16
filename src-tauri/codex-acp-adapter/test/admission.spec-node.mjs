import { test } from "node:test";
import assert from "node:assert/strict";
import { createAdmission, model } from "../admission.mjs";
const entry = () => ({
  id: "picker-a",
  model: "native-a",
  displayName: "A",
  description: "Synthetic only",
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "M" },
    { reasoningEffort: "high", description: "H" },
  ],
  defaultReasoningEffort: "medium",
  inputModalities: ["text", "image"],
});
const thread = { nativeThreadId: "thread", nativeSessionId: "tree" };
function fixture(change = () => {}) {
  const state = {
    account: { type: "apiKey" },
    entries: [entry(), { ...entry(), id: "hidden", hidden: true }],
    calls: [],
    cursor: null,
  };
  const a = createAdmission({
    enabled: true,
    launch: { cwd: "/work", scope: { profileId: "profile", generation: 1 } },
    retain: () => {},
    request: async (method, p) => {
      state.calls.push({ method, p });
      change(method, p, state, a);
      if (method === "account/read")
        return { account: state.account, requiresOpenaiAuth: true };
      return {
        data: [state.entries[p.cursor ? 1 : 0]],
        nextCursor: p.cursor ? null : "two",
      };
    },
  });
  return { a, state };
}
async function choose(a) {
  const s = await a.refresh();
  return a.choose({
    observationScope: s.scope,
    epoch: s.epoch,
    catalogHash: s.catalogHash,
    catalogModelId: "picker-a",
    provider: "synthetic",
    reasoningEffort: "medium",
  });
}
function confirm(a) {
  a.confirm(
    {
      model: "native-a",
      modelProvider: "synthetic",
      reasoningEffort: "medium",
      cwd: "/work",
      thread: { status: { type: "idle" }, modelProvider: "synthetic" },
    },
    thread,
  );
}
test("complete paginated native catalog keeps id/native model, hidden/default, efforts and modalities", async () => {
  const { a, state } = fixture();
  const s = await choose(a);
  assert.equal(s.catalog.length, 2);
  assert.equal(s.selection.nativeModel, "native-a");
  assert.equal(s.catalog[1].hidden, true);
  assert.deepEqual(s.catalog[0].inputModalities, ["text", "image"]);
  assert.deepEqual(
    state.calls.filter((c) => c.method === "model/list").map((c) => c.p.cursor),
    [null, "two"],
  );
  assert.throws(() =>
    a.choose({
      observationScope: s.scope,
      epoch: s.epoch,
      catalogHash: s.catalogHash,
      catalogModelId: "hidden",
      provider: "synthetic",
      reasoningEffort: "medium",
    }),
  );
  assert.throws(() =>
    a.choose({
      observationScope: s.scope,
      epoch: s.epoch,
      catalogHash: s.catalogHash,
      catalogModelId: "picker-a",
      provider: "synthetic",
      reasoningEffort: "unsupported",
    }),
  );
});
test("unauthenticated, malformed models, duplicate IDs and cycling cursors cannot become selection", async () => {
  const { a, state } = fixture();
  state.account = null;
  const s = await a.refresh();
  assert.throws(() =>
    a.choose({
      observationScope: s.scope,
      epoch: s.epoch,
      catalogHash: s.catalogHash,
      catalogModelId: "picker-a",
      provider: "synthetic",
      reasoningEffort: "medium",
    }),
  );
  state.account = { type: "apiKey" };
  state.entries[1].id = "picker-a";
  await assert.rejects(a.refresh());
  assert.throws(() => model({ ...entry(), inputModalities: ["audio"] }));
  assert.throws(() =>
    model({
      ...entry(),
      supportedReasoningEfforts: [
        { reasoningEffort: "high", description: "H" },
      ],
    }),
  );
  let n = 0;
  const loop = createAdmission({
    enabled: true,
    launch: {},
    retain: () => {},
    request: async (m) =>
      m === "account/read"
        ? { account: { type: "apiKey" }, requiresOpenaiAuth: true }
        : { data: [{ ...entry(), id: `m-${n++}` }], nextCursor: "same" },
  });
  await assert.rejects(loop.refresh());
  assert.equal(n, 2);
});
test("account events including login completion invalidate rather than authenticate; in-flight read is stale", async () => {
  const { a } = fixture();
  await choose(a);
  a.observe({ method: "account/login/completed", params: { success: true } });
  assert.equal(a.snapshot().selection, null);
  await assert.rejects(a.beforeStart());
  const racing = fixture((m, p, s, a) => {
    if (m === "model/list")
      a.observe({ method: "account/updated", params: { authMode: "apiKey" } });
  });
  await assert.rejects(racing.a.refresh());
  assert.equal(racing.a.snapshot().account, null);
});
test("catalog remapping and same-kind account identity change invalidate explicit selection", async () => {
  const { a, state } = fixture();
  await choose(a);
  state.entries[0].model = "native-b";
  await assert.rejects(a.beforeStart());
  assert.equal(a.snapshot().selection, null);
  const other = fixture();
  await choose(other.a);
  other.state.account = { type: "apiKey", identityMarker: "changed" };
  await assert.rejects(other.a.beforeStart());
});
test("new start passes exact native mapping and disables fallback; mismatched actual is rejected", async () => {
  const { a } = fixture();
  await choose(a);
  const p = await a.beforeStart();
  assert.deepEqual(p, {
    model: "native-a",
    modelProvider: "synthetic",
    allowProviderModelFallback: false,
    config: { model_reasoning_effort: "medium" },
  });
  assert.throws(() =>
    a.confirm(
      {
        model: "default",
        modelProvider: "synthetic",
        reasoningEffort: "medium",
      },
      thread,
    ),
  );
  confirm(a);
  assert.equal(a.snapshot().actual.catalogModelId, "picker-a");
});
test("preflight uses original snapshot plus fresh account/catalog/read identity and idle; ticket is exact", async () => {
  const { a } = fixture();
  await choose(a);
  confirm(a);
  const s = await a.prepare(thread, async () => ({
    thread: { status: { type: "idle" }, modelProvider: "synthetic" },
  }));
  a.ticket(s);
  const sorted = (v) =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sorted(v[k])]),
          )
        : v;
  a.ticket(sorted(s)); // Rust serde_json object ordering must not change typed identity.
  assert.throws(() => a.ticket({ ...s, scope: { ...s.scope, generation: 2 } }));
  assert.throws(() => a.ticket({ ...s, epoch: s.epoch + 1 }));
  await assert.rejects(
    a.prepare({ ...thread, nativeSessionId: "foreign" }, async () => {}),
  );
  await assert.rejects(
    a.prepare(thread, async () => ({
      thread: { status: { type: "active" }, modelProvider: "synthetic" },
    })),
  );
  a.observe({
    method: "thread/settings/updated",
    params: {
      threadId: "thread",
      threadSettings: {
        cwd: "/work",
        collaborationMode: {
          settings: { model: "changed", reasoning_effort: "medium" },
        },
      },
    },
  });
  assert.throws(() => a.ticket(s));
  await choose(a);
  await assert.rejects(
    a.prepare(thread, async () => ({
      thread: { status: { type: "idle" }, modelProvider: "synthetic" },
    })),
  );
});
test("production model gate makes zero native calls", async () => {
  let calls = 0;
  const a = createAdmission({
    request: () => {
      calls++;
    },
    retain: () => {},
    launch: {},
  });
  await assert.rejects(a.refresh());
  assert.throws(() => a.choose({}));
  await assert.rejects(a.beforeStart());
  assert.equal(calls, 0);
});
