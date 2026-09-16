import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateEnvelopes } from "../events.mjs";
test("unknown/private envelopes are retained with a hard bound, never exposed", () => {
  const store = createPrivateEnvelopes();
  store.retain({
    method: "future/native",
    params: { key: "SYNTHETIC-PRIVATE" },
  });
  assert.equal(store.count(), 1);
  assert.equal(JSON.stringify(store), "{}");
  for (let i = 1; i < 128; i++) store.retain({ opaque: i });
  assert.throws(() => store.retain({ overflow: true }));
});
