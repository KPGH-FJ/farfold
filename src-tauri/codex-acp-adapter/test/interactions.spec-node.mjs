import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInteractions,
  projectRequest,
  replyFor,
} from "../interactions.mjs";
const threadId = "019a0000-0000-7000-8000-000000000001",
  turnId = "019a0000-0000-7000-8000-000000000003";
const command = (id = 7) => ({
  id,
  method: "item/commandExecution/requestApproval",
  params: {
    threadId,
    turnId,
    itemId: "native-item",
    startedAtMs: 1,
    environmentId: null,
    approvalId: "callback",
    command: "printf synthetic",
    cwd: "/synthetic",
    reason: "synthetic",
    availableDecisions: [
      "decline",
      "accept",
      {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ["printf", "synthetic"],
        },
      },
    ],
    privateExtra: "PRIVATE-UNKNOWN",
  },
});
const question = () => ({
  id: "question-request",
  method: "item/tool/requestUserInput",
  params: {
    threadId,
    turnId,
    itemId: "native-question",
    questions: [
      {
        id: "one",
        header: "header",
        question: "choose",
        isOther: false,
        isSecret: false,
        options: [{ label: "A", description: "alpha" }],
      },
      {
        id: "two",
        header: "private",
        question: "enter",
        isOther: true,
        isSecret: true,
        options: null,
      },
    ],
    autoResolutionMs: null,
  },
});
const active = () => ({
  id: turnId,
  context: { thread: { nativeThreadId: threadId } },
  items: new Map(),
  mode: "plan",
  stopping: false,
});
function fixture(enabled = true) {
  const events = [],
    writes = [];
  const flow = createInteractions({
    enabled,
    emit: (e) => events.push(e),
    respond: (r) => writes.push(r),
  });
  return { events, writes, flow };
}
test("command decisions and necessary typed permission fields are preserved without private extras", () => {
  const frame = command();
  frame.params.additionalPermissions = {
    network: { enabled: true },
    fileSystem: {
      read: ["/synthetic"],
      write: null,
      entries: [
        {
          path: {
            type: "special",
            value: { kind: "project_roots", subpath: null },
          },
          access: "read",
        },
      ],
    },
  };
  frame.params.networkApprovalContext = {
    host: "example.com",
    protocol: "https",
  };
  const projected = projectRequest(frame, "default");
  assert.deepEqual(
    projected.params.availableDecisions,
    frame.params.availableDecisions,
  );
  assert.deepEqual(
    projected.params.additionalPermissions,
    frame.params.additionalPermissions,
  );
  assert.ok(!JSON.stringify(projected).includes("PRIVATE"));
  assert.deepEqual(
    replyFor(projected, { decision: frame.params.availableDecisions[2] }),
    { decision: frame.params.availableDecisions[2] },
  );
  assert.throws(() => replyFor(projected, { decision: "acceptForSession" }));
});
test("typed payload rejects unknown nested permissions and bounded malformed native choices", () => {
  const frame = command();
  frame.params.additionalPermissions = {
    network: { enabled: true, apiKey: "PRIVATE" },
    fileSystem: null,
  };
  assert.throws(() => projectRequest(frame, "default"));
  const bad = command();
  bad.params.availableDecisions = [
    {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["printf"],
        extra: "PRIVATE",
      },
    },
  ];
  assert.throws(() => projectRequest(bad, "default"));
  assert.throws(() =>
    projectRequest({ ...command(), id: 9007199254740992 }, "default"),
  );
});
test("Plan question flags/options remain exact; Default, missing IDs and unrelated answers are rejected", () => {
  const native = question(),
    projected = projectRequest(native, "plan");
  assert.deepEqual(projected, native);
  assert.throws(() => projectRequest(native, "default"));
  assert.throws(() =>
    replyFor(projected, {
      answers: {
        one: { answers: ["Other not offered"] },
        two: { answers: ["private"] },
      },
    }),
  );
  assert.throws(() =>
    replyFor(projected, { answers: { one: { answers: ["A"] } } }),
  );
  assert.deepEqual(
    replyFor(projected, {
      answers: {
        one: { answers: ["A"] },
        two: { answers: ["EPHEMERAL-ANSWER"] },
      },
    }).answers.two.answers,
    ["EPHEMERAL-ANSWER"],
  );
  native.params.questions[1].id = "one";
  assert.throws(() => projectRequest(native, "plan"));
});
test("file approval preview comes from the same active native item and is not a Host path grant", () => {
  const f = fixture(),
    a = active();
  const frame = {
    id: "file-request",
    method: "item/fileChange/requestApproval",
    params: {
      threadId,
      turnId,
      itemId: "native-file",
      startedAtMs: 1,
      grantRoot: "/synthetic",
      reason: null,
    },
  };
  a.items.set("native-file", {
    done: false,
    native: {
      type: "fileChange",
      changes: [
        {
          path: "/synthetic/x",
          kind: { type: "update", move_path: null },
          diff: "-old\n+new",
        },
      ],
    },
  });
  f.flow.observe(frame, a);
  assert.equal(f.events[0].fileChanges[0].diff, "-old\n+new");
  assert.deepEqual(
    replyFor(projectRequest(frame, "default"), {
      decision: "acceptForSession",
    }),
    { decision: "acceptForSession" },
  );
  a.items.get("native-file").done = true;
  assert.throws(() => f.flow.observe({ ...frame, id: "second" }, a));
});
test("response is exactly once, same numeric ID, and sent is not native resolved", () => {
  const f = fixture(),
    a = active();
  f.flow.observe(command(), a);
  const sent = f.flow.reply(
    {
      nativeRequestId: 7,
      itemId: "native-item",
      response: { decision: "decline" },
    },
    a,
  );
  assert.equal(sent.sent, true);
  assert.deepEqual(f.writes, [{ id: 7, result: { decision: "decline" } }]);
  assert.equal(f.events.length, 1);
  assert.throws(() =>
    f.flow.reply(
      {
        nativeRequestId: 7,
        itemId: "native-item",
        response: { decision: "accept" },
      },
      a,
    ),
  );
  f.flow.observe(
    { method: "serverRequest/resolved", params: { threadId, requestId: "7" } },
    a,
  );
  assert.equal(f.events.length, 1);
  f.flow.observe(
    { method: "serverRequest/resolved", params: { threadId, requestId: 7 } },
    a,
  );
  assert.equal(f.events[1].resolution, "native_resolved");
  assert.throws(() => f.flow.observe(command(), a));
});
test("multiple native callback IDs on one item stay separate; foreign turn and duplicate requests fail closed", () => {
  const f = fixture(),
    a = active();
  f.flow.observe(command(7), a);
  f.flow.observe(command("7"), a);
  assert.equal(f.events.length, 2);
  assert.throws(() => f.flow.observe(command(7), a));
  const wrong = command(8);
  wrong.params.turnId = "foreign";
  assert.throws(() => f.flow.observe(wrong, a));
  f.flow.reply(
    {
      nativeRequestId: "7",
      itemId: "native-item",
      response: { decision: "accept" },
    },
    a,
  );
  assert.equal(f.writes[0].id, "7");
  f.flow.stop();
  a.stopping = true;
  assert.throws(() =>
    f.flow.reply(
      {
        nativeRequestId: 7,
        itemId: "native-item",
        response: { decision: "accept" },
      },
      a,
    ),
  );
  assert.equal(f.writes.length, 1);
  f.flow.terminal();
  assert.ok(f.events.some((e) => e.resolution === "terminal"));
});
test("expiry invalidates only user reply and never generates a native answer", async () => {
  const f = fixture(),
    a = active(),
    q = question();
  q.params.autoResolutionMs = 20;
  f.flow.captured(q);
  f.flow.observe(q, a);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(f.events.at(-1).resolution, "expired");
  assert.equal(f.writes.length, 0);
  assert.throws(() =>
    f.flow.reply(
      {
        nativeRequestId: q.id,
        itemId: q.params.itemId,
        response: {
          answers: { one: { answers: ["A"] }, two: { answers: ["private"] } },
        },
      },
      a,
    ),
  );
  f.flow.observe(
    { method: "serverRequest/resolved", params: { threadId, requestId: q.id } },
    a,
  );
  assert.equal(f.events.at(-1).resolution, "native_resolved");
});
test("production interaction gate never replies or publishes", () => {
  const f = fixture(false);
  assert.throws(() => f.flow.observe(command(), active()));
  assert.equal(f.events.length, 0);
  assert.equal(f.writes.length, 0);
});

test("leaving Plan withdraws user reply without answering or claiming native resolution", () => {
  const f = fixture(),
    a = active(),
    q = question();
  f.flow.observe(q, a);
  f.flow.modeChanged("default");
  assert.equal(f.events.at(-1).resolution, "mode_changed");
  assert.equal(f.writes.length, 0);
  assert.throws(() =>
    f.flow.reply(
      {
        nativeRequestId: q.id,
        itemId: q.params.itemId,
        response: {
          answers: { one: { answers: ["A"] }, two: { answers: ["private"] } },
        },
      },
      a,
    ),
  );
  f.flow.observe(
    { method: "serverRequest/resolved", params: { threadId, requestId: q.id } },
    a,
  );
  assert.equal(f.events.at(-1).resolution, "native_resolved");
});
