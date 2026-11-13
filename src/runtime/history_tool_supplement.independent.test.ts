import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { SessionOpenReplay } from "./session_open_replay";
import { STRINGS } from "./strings";
import type { ThreadState } from "./session_types";

type Anchor = { role: "user" | "assistant"; text: string };
function begin() {
  const replay = new SessionOpenReplay(
    { agentId: "fixture", cwd: "/owned", nativeSessionId: "sid" },
    undefined,
    undefined,
    "token",
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
function body(anchor: Anchor, messageId?: string) {
  return {
    sessionId: "sid",
    update: {
      sessionUpdate:
        anchor.role === "user" ? "user_message_chunk" : "agent_message_chunk",
      ...(messageId === undefined ? {} : { messageId }),
      content: { type: "text", text: anchor.text },
    },
  };
}
function supplement(anchors: Anchor[], gap: number) {
  return {
    kind: "historyToolSupplement",
    openToken: "token",
    connectionId: "connection",
    sessionId: "sid",
    cwd: "/owned",
    anchors,
    tools: [
      {
        toolCallId: "export-call",
        name: "public_tool",
        arguments: {},
        callAfterAnchor: gap,
        resultAfterAnchor: gap,
        outcome: "success",
        content: [{ type: "text", text: "Official exported result" }],
        rawCall: { type: "function_call", call_id: "export-call" },
        rawResult: { type: "function_call_output", call_id: "export-call" },
      },
    ],
  };
}
function finish(replay: SessionOpenReplay) {
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
const toolIds = (state: ThreadState) =>
  state.items.flatMap((item) =>
    item.kind === "tool" ? [item.call.toolCallId] : [],
  );

it("uses the complete ordered prefix when two requests and answers have identical text", () => {
  const replay = begin();
  const anchors: Anchor[] = [
    { role: "user", text: "Again" },
    { role: "assistant", text: "Done" },
    { role: "user", text: "Again" },
    { role: "assistant", text: "Done" },
  ];
  for (const [index, anchor] of anchors.entries())
    replay.push(body(anchor, `message-${index}`));
  replay.push(supplement(anchors, 3));
  const state = finish(replay);
  expect(state.items.map((item) => item.kind)).toEqual([
    "user",
    "agent",
    "user",
    "tool",
    "agent",
    "notice",
  ]);
  expect(toolIds(state)).toEqual(["export-call"]);
  expect(state.items[3]).toMatchObject({ call: { rawInput: {} } });
});

it("matches chunked content and distinct adjacent message IDs at the actual reducer boundary", () => {
  const replay = begin();
  const anchors: Anchor[] = [
    { role: "user", text: "Check" },
    { role: "assistant", text: "First🙂" },
    { role: "assistant", text: "Second" },
  ];
  replay.push(body(anchors[0], "user"));
  replay.push(body({ role: "assistant", text: "First" }, "first"));
  replay.push(supplement(anchors, 2));
  replay.push(body({ role: "assistant", text: "🙂" }, "first"));
  replay.push(body(anchors[2], "second"));
  const state = finish(replay);
  expect(state.items.map((item) => item.kind)).toEqual([
    "user",
    "agent",
    "tool",
    "agent",
    "notice",
  ]);
  expect(state.items[1]).toMatchObject({ text: "First🙂", messageId: "first" });
  expect(state.items[3]).toMatchObject({ text: "Second", messageId: "second" });
});

it("preserves a coalesced official message and refuses to guess an absent boundary", () => {
  const replay = begin();
  const anchors: Anchor[] = [
    { role: "user", text: "Check" },
    { role: "assistant", text: "First" },
    { role: "assistant", text: "Second" },
  ];
  for (const anchor of anchors) replay.push(body(anchor));
  replay.push(supplement(anchors, 2));
  const state = finish(replay);
  expect(toolIds(state)).toEqual([]);
  expect(state.items.filter((item) => item.kind === "agent")).toMatchObject([
    { text: "FirstSecond" },
  ]);
  expect(state.items.at(-1)).toMatchObject({
    message: STRINGS.historySupplement.partial,
  });
});

it("projects a real tool carrying a lookalike local kind, retaining extras and preferring official content", () => {
  const replay = begin();
  const anchors: Anchor[] = [
    { role: "user", text: "Check" },
    { role: "assistant", text: "Done" },
  ];
  for (const anchor of anchors) replay.push(body(anchor));
  replay.push(supplement(anchors, 1));
  const disguised = {
    ...supplement(anchors, 1),
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "actual-call",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "Actual ACP result" },
        },
      ],
    },
  };
  replay.push(disguised);
  const state = finish(replay);
  expect(toolIds(state)).toEqual(["actual-call"]);
  const tool = state.items.find((item) => item.kind === "tool");
  expect(tool).toMatchObject({
    call: {
      content: [{ type: "text", text: "Actual ACP result" }],
      reportedDetails: {
        "/kind": "historyToolSupplement",
        "/tools": disguised.tools,
      },
    },
  });
});

it("retains an unknown local status unchanged without consuming the valid one-shot result", () => {
  const replay = begin();
  const anchors: Anchor[] = [
    { role: "user", text: "Check" },
    { role: "assistant", text: "Done" },
  ];
  for (const anchor of anchors) replay.push(body(anchor));
  const unknown = {
    kind: "historyToolSupplementStatus",
    openToken: "token",
    connectionId: "connection",
    sessionId: "sid",
    cwd: "/owned",
    reason: "future_reason",
    extra: { retained: true },
  };
  replay.push(unknown);
  replay.push(supplement(anchors, 1));
  const state = finish(replay);
  expect(toolIds(state)).toEqual(["export-call"]);
  expect(
    state.items.some((item) => item.kind === "raw" && item.update === unknown),
  ).toBe(true);
});
