import { expect, it } from "vitest";
import { paneCards, COMMAND_OUTPUT_CAP as CAP } from "./artifacts";
import { applySessionEvent } from "./session_event_projection";
import { applyUpdate, freshThreadState } from "./session_projection";
import { hasToolResult } from "./round_result";
import { transcriptMarkdown } from "./conversation_export";

function subject() {
  const s = freshThreadState("reported-output", "fixture", "/work", "one");
  s.running = true;
  s.activeToolCallIds = ["reported-tool"];
  applyUpdate(s, {
    sessionUpdate: "tool_call",
    toolCallId: "reported-tool",
    kind: "other",
    status: "in_progress",
    rawInput: { command: "INPUT_NOT_OUTPUT" },
  });
  return s;
}
type State = ReturnType<typeof subject>;
function append(s: State, data: string, sequence = 1, truncated = false) {
  applySessionEvent(
    s,
    {
      kind: "toolOutput",
      source: "reported",
      toolCallId: "reported-tool",
      data,
      sequence,
      truncated,
    },
    true,
  );
}
function call(s: State) {
  const item = s.items.find((item) => item.kind === "tool");
  if (item?.kind !== "tool") throw new Error("Missing tool");
  return item.call;
}

it("makes declared streamed output reachable for an otherwise unknown tool without changing its status or input", () => {
  const s = subject();
  append(s, "🙂LIVE\n");
  expect(paneCards(s)).toMatchObject([
    {
      kind: "log",
      output: "🙂LIVE\n",
      status: "in_progress",
      outputTruncated: false,
      outputIncomplete: false,
    },
  ]);
  expect(call(s)).toMatchObject({
    kind: "other",
    status: "in_progress",
    rawInput: { command: "INPUT_NOT_OUTPUT" },
  });
  expect(hasToolResult(call(s))).toBe(true);
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: "reported-tool",
    status: "completed",
    content: [
      { type: "content", content: { type: "text", text: "SHORTENED_FINAL" } },
    ],
  });
  expect(paneCards(s)[0]).toMatchObject({
    output: "🙂LIVE\n",
    status: "completed",
  });
});

it.each([0, 1, 2])(
  "keeps the scalar suffix at capacity plus %i UTF-16 units",
  (extra) => {
    const s = subject();
    const text = "🙂" + "X".repeat(CAP - 3) + "\n";
    append(s, text);
    if (extra) append(s, "Z".repeat(extra), 2);
    const original = text + "Z".repeat(extra);
    expect(paneCards(s)[0]).toMatchObject({
      output: extra ? original.slice(2) : original,
      outputTruncated: extra > 0,
      outputIncomplete: false,
    });
  },
);

it("ignores stale sequences and exposes missing chunks separately from local tail clipping", () => {
  const s = subject();
  append(s, "FIRST", 1);
  append(s, "DUPLICATE", 1);
  append(s, "THIRD", 3);
  append(s, "STALE", 2);
  append(s, "", 4, true);
  expect(paneCards(s)[0]).toMatchObject({
    output: "FIRSTTHIRD",
    outputTruncated: false,
    outputIncomplete: true,
  });
  const exported = transcriptMarkdown(s, "Output", "Fixture", {
    includeLoadedToolDetails: true,
  });
  expect(exported).toContain("FIRSTTHIRD");
  expect(exported).toContain("已接收的运行输出不完整");
  expect(exported).not.toContain("DUPLICATE");
});

it("requires an existing tool and a valid reported-output receipt", () => {
  const s = subject();
  for (const patch of [
    { toolCallId: "foreign" },
    { source: "future" },
    { sequence: 0 },
    { sequence: 1.5 },
    { sequence: "1" },
    { truncated: "false" },
  ])
    applySessionEvent(
      s,
      {
        kind: "toolOutput",
        source: "reported",
        toolCallId: "reported-tool",
        data: "INVALID",
        sequence: 1,
        truncated: false,
        ...patch,
      },
      true,
    );
  expect(paneCards(s)).toEqual([]);
  expect(hasToolResult(call(s))).toBe(false);
});

it("keeps a reported tool result unknown after connection loss without inventing completion", () => {
  const s = subject();
  append(s, "PARTIAL");
  applySessionEvent(s, { kind: "connectionLost" }, true);
  expect(paneCards(s)[0]).toMatchObject({
    output: "PARTIAL",
    status: "unknown",
  });
  expect(call(s).status).toBe("in_progress");
  expect(s.connectionOutcomeUnknown).toBe(true);
});

it("keeps initial gaps and upstream truncation visible even before any text", () => {
  const s = subject();
  append(s, "", 2, true);
  expect(paneCards(s)[0]).toMatchObject({
    output: "",
    outputTruncated: false,
    outputIncomplete: true,
  });
  expect(hasToolResult(call(s))).toBe(false);
  applyUpdate(s, {
    sessionUpdate: "tool_call_update",
    toolCallId: "reported-tool",
    rawOutput: "ACTUAL_FINAL_TEXT",
  });
  expect(paneCards(s)[0]).toMatchObject({
    output: "ACTUAL_FINAL_TEXT",
    outputTruncated: false,
  });
  expect(paneCards(s)[0]).not.toMatchObject({ outputIncomplete: true });
});
