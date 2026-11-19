import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { SessionOpenReplay } from "./session_open_replay";
import { PNG_IMAGE_TEST_DATA } from "./image_fixtures.test-support";
import { STRINGS } from "./strings";
import type { ThreadState } from "./session_types";

function payload(): any {
  return {
    kind: "historyToolSupplement",
    openToken: "token",
    connectionId: "connection",
    sessionId: "sid",
    cwd: "/owned",
    anchors: [
      { role: "user", text: "请查看🙂" },
      { role: "assistant", text: "完成" },
    ],
    tools: [
      {
        toolCallId: "call",
        name: "observe_page",
        arguments: { screenshot: true },
        callAfterAnchor: 1,
        resultAfterAnchor: 1,
        outcome: "success",
        content: [
          { type: "text", text: "公开网页" },
          { type: "image", mimeType: "image/png", data: PNG_IMAGE_TEST_DATA },
        ],
        rawCall: { type: "function_call", call_id: "call" },
        rawResult: { type: "function_call_output", call_id: "call" },
      },
    ],
  };
}
function message(
  role: "user" | "agent",
  text: string,
  id: string | null = role,
) {
  return {
    sessionId: "sid",
    update: {
      sessionUpdate: `${role}_message_chunk`,
      ...(id === null ? {} : { messageId: id }),
      content: { type: "text", text },
    },
  };
}
function begin(current = () => true) {
  const replay = new SessionOpenReplay(
    { agentId: "fixture", cwd: "/owned", nativeSessionId: "sid" },
    undefined,
    undefined,
    "token",
    current,
  );
  replay.push({
    kind: "sessionOpening",
    openToken: "token",
    cwd: "/owned",
    sessionId: "sid",
    connectionId: "connection",
  });
  return replay;
}
function open(current = () => true) {
  const replay = begin(current);
  replay.push(message("user", "请查看🙂"));
  replay.push(message("agent", "完成"));
  return replay;
}
function accept(replay: SessionOpenReplay): ThreadState {
  replay.receiveMarker({
    kind: "session_history_complete",
    openToken: "token",
  });
  return replay.accept(
    {
      cwd: "/owned",
      nativeSessionId: "sid",
      connectionId: "connection",
      resumed: true,
      configOptions: [],
      warnings: [],
    },
    null,
  );
}
const tools = (s: ThreadState) => s.items.filter((i) => i.kind === "tool");

const stoppedInput = "请运行一次命令🙂";
const stoppedResult = "Tool execution interrupted by user.";

function stoppedPayload() {
  const source = payload();
  const args = { command: "/bin/sh ./task.sh" };
  source.anchors = [
    { role: "user", text: stoppedInput },
    { role: "user", text: stoppedResult },
  ];
  Object.assign(source.tools[0], {
    name: "execute",
    arguments: args,
    resultAfterAnchor: 2,
    outcome: "error",
    content: [{ type: "text", text: stoppedResult }],
    rawCall: {
      type: "function_call",
      call_id: "call",
      name: "execute",
      arguments: JSON.stringify(args),
    },
    rawResult: {
      type: "function_call_output",
      call_id: "call",
      status: "error",
      output: stoppedResult,
    },
  });
  return source;
}

function stoppedReplay() {
  const replay = begin();
  replay.push({
    ...message("user", stoppedInput, null),
    futureEnvelope: { owner: "first" },
  });
  replay.push(message("user", stoppedResult, null));
  return replay;
}

it("restores an interrupted historical tool between two coalesced user anchors", () => {
  const replay = stoppedReplay();
  const source = stoppedPayload();
  replay.push(source);
  const state = accept(replay);
  expect(state.items.map((item) => item.kind)).toEqual([
    "user",
    "tool",
    "user",
    "notice",
  ]);
  expect(state.items[0]).toMatchObject({
    text: stoppedInput,
    reportedDetails: { "/futureEnvelope": { owner: "first" } },
  });
  expect(state.items[2]).toMatchObject({ text: stoppedResult });
  expect(state.items[2].reportedDetails).toBeUndefined();
  expect(state.items[0].id).not.toBe(state.items[2].id);
  expect(tools(state)[0].call).toMatchObject({
    toolCallId: "call",
    status: "failed",
    startedAt: 0,
    content: [{ type: "text", text: stoppedResult }],
    rawOutput: { result: source.tools[0].rawResult },
  });
  expect(state.activeToolCallIds).toEqual([]);
  expect(state.pendingPermissions).toEqual([]);
});

it.each([
  [
    "different result",
    (p: any) => {
      p.tools[0].content[0].text += "!";
    },
  ],
  [
    "changed anchor",
    (p: any) => {
      p.anchors[1].text += "!";
    },
  ],
  [
    "successful outcome",
    (p: any) => {
      p.tools[0].outcome = "success";
    },
  ],
  [
    "result at the first anchor",
    (p: any) => {
      p.tools[0].resultAfterAnchor = 1;
    },
  ],
  [
    "two candidate tools",
    (p: any) => {
      const second = structuredClone(p.tools[0]);
      second.toolCallId = "other";
      second.rawCall.call_id = "other";
      second.rawResult.call_id = "other";
      p.tools.push(second);
    },
  ],
] as const)(
  "preserves an unproven coalesced user item on %s",
  (_name, mutate) => {
    const replay = stoppedReplay();
    const source = stoppedPayload();
    mutate(source);
    replay.push(source);
    const state = accept(replay);
    expect(tools(state)).toHaveLength(0);
    expect(state.items[0]).toMatchObject({
      kind: "user",
      text: stoppedInput + stoppedResult,
    });
    expect(state.items.at(-1)).toMatchObject({
      message: STRINGS.historySupplement.partial,
    });
  },
);

it("leaves a coalesced user item with an attachment intact", () => {
  const replay = stoppedReplay();
  replay.push({
    sessionId: "sid",
    update: {
      sessionUpdate: "user_message_chunk",
      content: {
        type: "image",
        mimeType: "image/png",
        data: PNG_IMAGE_TEST_DATA,
      },
    },
  });
  replay.push(stoppedPayload());
  const state = accept(replay);
  expect(tools(state)).toHaveLength(0);
  expect(state.items[0]).toMatchObject({
    kind: "user",
    text: stoppedInput + stoppedResult,
    attachments: [{ data: PNG_IMAGE_TEST_DATA }],
  });
  expect(state.items.at(-1)).toMatchObject({
    message: STRINGS.historySupplement.partial,
  });
});

const successPreamble = "我会先核对文件。🙂";
const successFinal = "核对完成。";
const successResult =
  "OWNED_MARKER\nprocess_id: process-1\nprocess exit code was 0";

function successfulPayload() {
  const source = payload();
  const args = { command: "/bin/cat ./marker.txt" };
  source.anchors = [
    { role: "user", text: "请查看🙂" },
    { role: "assistant", text: successPreamble },
    { role: "assistant", text: successFinal },
  ];
  Object.assign(source.tools[0], {
    name: "bash",
    arguments: args,
    callAfterAnchor: 2,
    resultAfterAnchor: 2,
    content: [{ type: "text", text: successResult }],
    rawCall: {
      type: "function_call",
      call_id: "call",
      name: "bash",
      arguments: JSON.stringify(args),
    },
    rawResult: {
      type: "function_call_output",
      call_id: "call",
      status: "success",
      output: successResult,
    },
  });
  return source;
}

function successfulReplay(messageId: string | null = null) {
  const replay = begin();
  replay.push(message("user", "请查看🙂"));
  replay.push({
    ...message("agent", successPreamble, messageId),
    futureEnvelope: { owner: "first" },
  });
  replay.push(message("agent", successFinal, messageId));
  return replay;
}

it("restores a successful historical tool between the coalesced preamble and final response", () => {
  const replay = successfulReplay();
  const source = successfulPayload();
  replay.push(source);
  const state = accept(replay);
  expect(state.items.map((item) => item.kind)).toEqual([
    "user",
    "agent",
    "tool",
    "agent",
    "notice",
  ]);
  expect(state.items[1]).toMatchObject({
    text: successPreamble,
    contentOrder: [{ kind: "text", start: 0, end: successPreamble.length }],
    reportedDetails: { "/futureEnvelope": { owner: "first" } },
  });
  expect(state.items[3]).toMatchObject({
    text: successFinal,
    contentOrder: [{ kind: "text", start: 0, end: successFinal.length }],
    streaming: false,
  });
  expect(state.items[3].reportedDetails).toBeUndefined();
  expect(state.items[1].id).not.toBe(state.items[3].id);
  expect(tools(state)[0].call).toMatchObject({
    toolCallId: "call",
    status: "completed",
    startedAt: 0,
    content: [{ type: "text", text: successResult }],
    rawOutput: { result: source.tools[0].rawResult },
  });
  expect(state.activeToolCallIds).toEqual([]);
  expect(state.pendingPermissions).toEqual([]);
});

it.each([
  [
    "different anchor",
    (p: any) => {
      p.anchors[2].text += "!";
    },
  ],
  [
    "result beyond the boundary",
    (p: any) => {
      p.tools[0].resultAfterAnchor = 3;
    },
  ],
  [
    "different raw result",
    (p: any) => {
      p.tools[0].rawResult.output += "!";
    },
  ],
  [
    "second tool at the boundary",
    (p: any) => {
      const duplicate = structuredClone(p.tools[0]);
      duplicate.toolCallId = "other";
      duplicate.rawCall.call_id = "other";
      duplicate.rawResult.call_id = "other";
      p.tools.push(duplicate);
    },
  ],
] as const)("preserves a coalesced assistant item on %s", (_name, mutate) => {
  const replay = successfulReplay();
  const source = successfulPayload();
  mutate(source);
  replay.push(source);
  const state = accept(replay);
  expect(tools(state)).toHaveLength(0);
  expect(state.items[1]).toMatchObject({
    kind: "agent",
    text: successPreamble + successFinal,
  });
  expect(state.items.at(-1)).toMatchObject({
    message: STRINGS.historySupplement.partial,
  });
});

it("preserves an assistant item with a claimed message ID", () => {
  const replay = successfulReplay("claimed");
  replay.push(successfulPayload());
  const state = accept(replay);
  expect(tools(state)).toHaveLength(0);
  expect(state.items[1]).toMatchObject({
    kind: "agent",
    messageId: "claimed",
    text: successPreamble + successFinal,
  });
  expect(state.items.at(-1)).toMatchObject({
    message: STRINGS.historySupplement.partial,
  });
});

it("preserves an annotated assistant item whose content cannot be split safely", () => {
  const replay = begin();
  replay.push(message("user", "请查看🙂"));
  replay.push({
    sessionId: "sid",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: successPreamble,
        annotations: { audience: ["user"] },
      },
    },
  });
  replay.push(message("agent", successFinal, null));
  replay.push(successfulPayload());
  const state = accept(replay);
  expect(tools(state)).toHaveLength(0);
  expect(state.items[1]).toMatchObject({
    kind: "agent",
    text: successPreamble + successFinal,
    reportedDetails: { "/update/content/annotations": { audience: ["user"] } },
  });
});

it("merges an official export in its original gap without execution, activity, or fabricated timing", () => {
  const replay = open();
  const source = payload();
  const original = JSON.stringify(source);
  replay.push(source);
  const s = accept(replay);
  expect(s.items.map((i) => i.kind)).toEqual([
    "user",
    "tool",
    "agent",
    "notice",
  ]);
  expect(tools(s)[0].call).toMatchObject({
    toolCallId: "call",
    status: "completed",
    startedAt: 0,
    locations: [],
    content: [
      { type: "text", text: "公开网页" },
      { type: "attachment", attachment: { data: PNG_IMAGE_TEST_DATA } },
    ],
    rawOutput: {
      source: "officialHistoryExport",
      call: source.tools[0].rawCall,
      result: source.tools[0].rawResult,
    },
  });
  expect(s.activeToolCallIds).toEqual([]);
  expect(s.pendingPermissions).toEqual([]);
  expect(s.pendingElicitations).toEqual([]);
  expect(s.items.at(-1)).toMatchObject({
    message: STRINGS.historySupplement.snapshot,
    time: 0,
  });
  expect(JSON.stringify(source)).toBe(original);
});

it.each(["openToken", "connectionId", "sessionId", "cwd"])(
  "preserves foreign %s as raw without accepting its tools",
  (field) => {
    const replay = open();
    const p = payload();
    p[field] = "foreign";
    replay.push(p);
    const s = accept(replay);
    expect(tools(s)).toHaveLength(0);
    expect(s.items.some((i) => i.kind === "raw" && i.update === p)).toBe(true);
  },
);

it.each([
  [
    "changed text",
    (p: any) => {
      p.anchors[1].text = "不同";
    },
  ],
  [
    "missing anchor",
    (p: any) => {
      p.anchors.pop();
    },
  ],
  [
    "wrong role",
    (p: any) => {
      p.anchors[0].role = "system";
    },
  ],
  [
    "unknown anchor field",
    (p: any) => {
      p.anchors[0].source = "invented";
    },
  ],
  [
    "negative gap",
    (p: any) => {
      p.tools[0].callAfterAnchor = -1;
    },
  ],
  [
    "fractional gap",
    (p: any) => {
      p.tools[0].callAfterAnchor = 0.5;
    },
  ],
  [
    "result before call",
    (p: any) => {
      p.tools[0].resultAfterAnchor = 0;
    },
  ],
  [
    "gap past history",
    (p: any) => {
      p.tools[0].resultAfterAnchor = 3;
    },
  ],
  [
    "duplicate ID",
    (p: any) => {
      p.tools.push(structuredClone(p.tools[0]));
    },
  ],
  [
    "unsafe image",
    (p: any) => {
      p.tools[0].content[1].mimeType = "image/svg+xml";
    },
  ],
  [
    "remote media",
    (p: any) => {
      p.tools[0].content[1] = {
        type: "image",
        uri: "https://example.com/image.png",
      };
    },
  ],
  [
    "partial media",
    (p: any) => {
      p.tools[0].content[1].data = "invalid";
    },
  ],
  [
    "extra tool field",
    (p: any) => {
      p.tools[0].permission = "allow";
    },
  ],
  [
    "oversize payload",
    (p: any) => {
      p.tools[0].content[0].text = "x".repeat(8 * 1024 * 1024);
    },
  ],
] as const)(
  "keeps readable history with a partial notice on %s",
  (_label, mutate) => {
    const replay = open();
    const p = payload();
    mutate(p);
    replay.push(p);
    const s = accept(replay);
    expect(tools(s)).toHaveLength(0);
    expect(
      s.items
        .filter((i) => i.kind === "user" || i.kind === "agent")
        .map((i) => i.text),
    ).toEqual(["请查看🙂", "完成"]);
    expect(s.items.at(-1)).toMatchObject({
      message: STRINGS.historySupplement.partial,
    });
  },
);

it("validates the final prefix and refuses intervening changed text", () => {
  const replay = open();
  replay.push(payload());
  replay.push(message("agent", "后来变化", "extra"));
  expect(tools(accept(replay))).toHaveLength(0);
});
it("lets any official tool replay win even when it arrives after the supplement", () => {
  const replay = open();
  replay.push(payload());
  replay.push({
    sessionId: "sid",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "official",
      title: "Actual",
      status: "completed",
      content: [],
    },
  });
  expect(tools(accept(replay)).map((i) => i.call.toolCallId)).toEqual([
    "official",
  ]);
});
it("admits one supplement and does not apply duplicate or following controls", () => {
  const replay = open();
  replay.push(payload());
  replay.push(payload());
  replay.receiveMarker({
    kind: "session_history_complete",
    openToken: "token",
  });
  const late = payload();
  late.tools[0].toolCallId = "late";
  replay.push(late);
  const s = accept(replay);
  expect(tools(s).map((i) => i.call.toolCallId)).toEqual(["call"]);
});
it("does not authorize an Agent lookalike carrying an own update", () => {
  const replay = open();
  const p = {
    ...payload(),
    update: { sessionUpdate: "future", opaque: "unchanged" },
  };
  replay.push(p);
  expect(tools(accept(replay))).toHaveLength(0);
});
it.each(["unavailable", "changed", "invalid", "limit", "cancelled"])(
  "retains the body on an owned %s receipt",
  (reason) => {
    const replay = open();
    const p = payload();
    const { anchors: _a, tools: _t, ...owner } = p;
    replay.push({ ...owner, kind: "historyToolSupplementStatus", reason });
    const s = accept(replay);
    expect(tools(s)).toHaveLength(0);
    expect(s.items.at(-1)).toMatchObject({
      message: STRINGS.historySupplement.partial,
    });
  },
);
it("cannot publish after its original opening is abandoned", () => {
  let current = true;
  const replay = open(() => current);
  replay.push(payload());
  current = false;
  expect(() => accept(replay)).toThrow();
  replay.clear();
});
it("keeps the official failed outcome and its result in the original call position", () => {
  const replay = open();
  const p = payload();
  p.tools[0].outcome = "error";
  p.tools[0].resultAfterAnchor = 2;
  replay.push(p);
  const s = accept(replay);
  expect(tools(s)[0].call.status).toBe("failed");
  expect(s.items[1].kind).toBe("tool");
});
