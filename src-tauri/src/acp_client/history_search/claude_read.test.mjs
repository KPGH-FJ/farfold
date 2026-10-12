import test from "node:test";
import assert from "node:assert/strict";
import { project, readProjection, LIMITS } from "./claude_read.mjs";
const id = "12345678-1234-1234-1234-123456789abc";
const request = { rowId: "saved-1", sessionId: id, cwd: "/synthetic" };
const info = {
  sessionId: id,
  cwd: request.cwd,
  lastModified: 10,
  fileSize: 500,
};
const msg = (extra = {}) => ({
  type: "user",
  uuid: id,
  session_id: id,
  message: { role: "user", content: "hello" },
  parent_tool_use_id: null,
  parent_agent_id: null,
  ...extra,
});
for (const extra of [
  { isCompletedLocalCommand: true },
  { isQueuedCommand: true },
  { origin: { kind: "task-notification" } },
  { origin: { kind: "future-origin" } },
]) {
  test(
    "official transformed command/origin is not user prose " +
      JSON.stringify(extra),
    () => {
      const v = project(
        [msg(extra), msg({ uuid: "00000000-0000-0000-0000-000000000001" })],
        request,
      );
      assert.equal(v.blocks.length, 1);
      assert.equal(
        v.blocks[0].messageLocator.messageId,
        "00000000-0000-0000-0000-000000000001",
      );
    },
  );
}
test("public wrapper required nullable parent fields stay strict", () => {
  assert.throws(() => project([msg({ parent_agent_id: undefined })], request), {
    code: "invalidOutput",
  });
  assert.throws(() => project([msg({ session_id: "different" })], request), {
    code: "invalidOutput",
  });
});
test("actual API order/options, metadata drift and empty projection", async () => {
  const calls = [];
  const api = {
    getSessionInfo: async (...args) => {
      calls.push(["info", ...args]);
      return info;
    },
    getSessionMessages: async (...args) => {
      calls.push(["messages", ...args]);
      return [msg()];
    },
  };
  const value = await readProjection(api, request, async (v) => v);
  assert.equal(value.coverage, "partial");
  assert.deepEqual(
    calls.map((x) => x[0]),
    ["info", "messages", "info"],
  );
  assert.deepEqual(calls[1], [
    "messages",
    id,
    { dir: "/synthetic", offset: 0, limit: 401, includeSystemMessages: false },
  ]);
  api.getSessionMessages = async () => [];
  await assert.rejects(
    readProjection(api, request, async (v) => v),
    { code: "sourceUnconfirmed" },
  );
  let n = 0;
  api.getSessionMessages = async () => [msg()];
  api.getSessionInfo = async () => ({ ...info, lastModified: ++n });
  await assert.rejects(
    readProjection(api, request, async (v) => v),
    { code: "sourceChanged" },
  );
});
test("meta compact nontext and distinct assistant parts", () => {
  const m = msg({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "PRIVATE" },
        { type: "text", text: "😀 Hello" },
        { type: "tool_result", content: "PRIVATE" },
        { type: "text", text: "world" },
      ],
    },
  });
  const v = project(
    [
      m,
      msg({
        uuid: "00000000-0000-0000-0000-000000000001",
        isCompactSummary: true,
        is_meta: true,
      }),
    ],
    request,
  );
  assert.deepEqual(
    v.blocks.map((x) => x.messageLocator.partIndex),
    [1, 3],
  );
  assert(!JSON.stringify(v).includes("PRIVATE"));
});
test("bounded unicode byte projection and sentinel always partial", () => {
  const v = project(
    [msg({ message: { role: "user", content: "😀".repeat(20000) } })],
    request,
  );
  assert(v.limited);
  assert.equal(Buffer.byteLength(v.blocks[0].text), LIMITS.blockBytes);
  assert.equal(v.blocks[0].text.length % 2, 0);
  const messages = Array.from({ length: 401 }, (_, i) =>
    msg({ uuid: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}` }),
  );
  assert(project(messages, request).limited);
});
test("unknown record semantics and malformed command flags are not original prose", () => {
  assert.throws(
    () => project([msg({ isFutureGeneratedSummary: true })], request),
    { code: "invalidOutput" },
  );
  assert.throws(() => project([msg({ isQueuedCommand: "yes" })], request), {
    code: "invalidOutput",
  });
});
