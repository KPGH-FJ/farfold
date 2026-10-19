import { expect, it } from "vitest";
import {
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
} from "./session_projection";
import { settledRoundResults } from "./round_result";
import type { ThreadItem } from "./session_types";

function state() {
  const s = freshThreadState("agent:/p:result", "agent", "/p", "result");
  s.running = true;
  s.queued = [[{ type: "text", text: "Next request" }]];
  return s;
}

it.each([true, false])(
  "does not rescan every history item for each settled round (reply=%s)",
  (replyReceived) => {
    let kindReads = 0;
    const items = Array.from({ length: 512 }, (_, index): ThreadItem => {
      const item: ThreadItem = {
        kind: "settled",
        id: `end-${index}`,
        status: "done",
        diffCount: 0,
        artifactCount: 0,
        replyReceived,
        time: index,
      };
      return new Proxy(item, {
        get(target, property, receiver) {
          if (property === "kind") kindReads += 1;
          return Reflect.get(target, property, receiver);
        },
      });
    });
    const results = settledRoundResults({
      items,
      activeToolCallIds: [],
      connectionLost: false,
    });
    expect(results.size).toBe(items.length);
    expect([...results.values()]).toEqual(
      Array(items.length).fill(replyReceived ? "reply" : "none"),
    );
    expect(kindReads).toBeLessThanOrEqual(4 * items.length);
  },
);

it.each([
  { status: "completed", observation: undefined, expected: "maintenance" },
  { status: "failed", observation: undefined, expected: "maintenance_failed" },
  {
    status: "in_progress",
    observation: undefined,
    expected: "maintenance_pending",
  },
  {
    status: "completed",
    observation: "unknown" as const,
    expected: "maintenance_unknown",
  },
])(
  "keeps all duplicate compaction entries and result precedence for $expected",
  ({ status, observation, expected }) => {
    const compaction = (id: string, status: string): ThreadItem => ({
      kind: "compaction",
      id,
      compactionId: id,
      status,
      summary: [],
      details: { future: { retained: true } },
      summaryDetails: [],
    });
    const first = compaction("duplicate", status);
    if (first.kind === "compaction") first.observation = observation;
    const ending: ThreadItem = {
      kind: "settled",
      id: "ending",
      status: "done",
      replyReceived: false,
      artifactCount: 0,
      diffCount: 0,
      compactionItemIds: ["missing", "duplicate", "duplicate"],
      time: 1,
    };
    const items: ThreadItem[] = [
      first,
      compaction("unrelated", "in_progress"),
      compaction("duplicate", "completed"),
      ending,
      { ...ending, id: "reply", replyReceived: true },
      { ...ending, id: "legacy", replyReceived: undefined },
    ];
    const before = structuredClone(items);
    expect([
      ...settledRoundResults({
        items,
        activeToolCallIds: [],
        connectionLost: false,
      }),
    ]).toEqual([
      ["ending", expected],
      ["reply", "reply"],
    ]);
    expect(items).toEqual(before);
  },
);

it.each(
  [
    [],
    [
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "  " },
      },
    ],
    [
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking" },
      },
    ],
    [
      {
        sessionUpdate: "plan",
        entries: [{ content: "Plan", status: "completed" }],
      },
    ],
    [{ sessionUpdate: "_future_result", content: "Opaque extension" }],
    [
      {
        sessionUpdate: "tool_call",
        toolCallId: "thought-only",
        kind: "think",
        status: "completed",
      },
    ],
    [
      {
        sessionUpdate: "tool_call",
        toolCallId: "input-only",
        rawInput: { command: "echo input" },
      },
    ],
  ].map((updates) => ({ updates })),
)("does not call a normal ending a received result for %j", ({ updates }) => {
  const s = state();
  for (const update of updates) applyUpdate(s, update);
  expect(applyTurnEnd(s, { stopReason: "end_turn" })).toBe("none");
  expect(s.queuePaused).toBe("no_result");
  expect(s.queued).toHaveLength(1);
  expect(s.items.at(-1)).toMatchObject({
    status: "done",
    stopReason: "end_turn",
    replyReceived: false,
  });
});

it.each([
  { type: "text", text: "A real answer" },
  { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
  {
    type: "resource",
    resource: {
      uri: "file:///returned.txt",
      mimeType: "text/plain",
      text: "Returned content",
    },
  },
])("keeps real reply content %j even without accompanying prose", (content) => {
  const s = state();
  applyUpdate(s, { sessionUpdate: "agent_message_chunk", content });
  expect(applyTurnEnd(s, { stopReason: "end_turn" })).toBe("reply");
  expect(s.queuePaused).toBeNull();
});

it.each([
  { status: "completed" },
  { status: "failed" },
  { status: "in_progress", rawOutput: { exitCode: 0 } },
  {
    status: "in_progress",
    content: [
      { type: "content", content: { type: "text", text: "Actual output" } },
    ],
  },
])("preserves a genuine tool result %j without inventing a reply", (result) => {
  const s = state();
  applyUpdate(s, { sessionUpdate: "tool_call", toolCallId: "tool", ...result });
  expect(applyTurnEnd(s, { stopReason: "end_turn" })).toBe("tool");
  expect(s.items.at(-1)).toMatchObject({ replyReceived: false });
  const tool = s.items.find((item) => item.kind === "tool");
  expect(tool?.call.status).toBe(result.status);
});

it("keeps a delayed tool result with its original round without resuming the queue", () => {
  const s = state();
  applyUpdate(s, {
    sessionUpdate: "tool_call",
    toolCallId: "old-tool",
    status: "in_progress",
  });
  s.activeToolCallIds = ["old-tool"];
  expect(applyTurnEnd(s, { stopReason: "end_turn" })).toBe("pending");
  const oldEnd = s.items.at(-1)!;
  s.roundItemBase = s.items.length;
  applyUpdate(s, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Later answer" },
  });
  applyTurnEnd(s, { stopReason: "end_turn" });
  const nextEnd = s.items.at(-1)!;
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: "old-tool",
    status: "completed",
  });
  s.activeToolCallIds = [];
  expect(settledRoundResults(s).get(oldEnd.id)).toBe("tool");
  expect(settledRoundResults(s).get(nextEnd.id)).toBe("reply");
  expect(s.queuePaused).toBe("stopped");
});

it("does not borrow readable content from an earlier round", () => {
  const s = state();
  applyUpdate(s, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Earlier reply" },
  });
  applyTurnEnd(s, { stopReason: "end_turn" });
  s.roundItemBase = s.items.length;
  expect(applyTurnEnd(s, { stopReason: "end_turn" })).toBe("none");
});
