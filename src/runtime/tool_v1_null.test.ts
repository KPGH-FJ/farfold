import { expect, it } from "vitest";
import { applyUpdate, freshThreadState } from "./session_projection";
import { hasToolResult } from "./round_result";

function fixture() {
  const state = freshThreadState("k", "fixture", "/work", "n");
  applyUpdate(state, {
    sessionUpdate: "tool_call",
    toolCallId: "t",
    title: "Tool",
    status: "in_progress",
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: "reported output",
          _meta: { retained: "content" },
        },
      },
    ],
    locations: [{ path: "/work/a", line: 2, _meta: { retained: "location" } }],
    rawInput: { query: "input" },
    rawOutput: { result: "output" },
    _meta: { retained: "update" },
  });
  const item = state.items[0];
  if (item?.kind !== "tool") throw new Error("missing fixture tool");
  return { state, call: item.call };
}

it.each(["content", "locations", "rawInput", "rawOutput"] as const)(
  "ACP v1 null %s does not erase the previously reported value",
  (field) => {
    const { state, call } = fixture();
    const previous = structuredClone(call[field]);
    const details = structuredClone(call.reportedDetails);
    applyUpdate(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      [field]: null,
    });
    expect(call[field]).toEqual(previous);
    expect(call.reportedDetails).toEqual(details);
  },
);

it("omitted v1 fields retain their values and explicit empty lists replace collections", () => {
  const { state, call } = fixture();
  applyUpdate(state, {
    sessionUpdate: "tool_call_update",
    toolCallId: "t",
    status: "completed",
  });
  expect(call.content).toHaveLength(1);
  expect(call.locations).toHaveLength(1);
  applyUpdate(state, {
    sessionUpdate: "tool_call_update",
    toolCallId: "t",
    content: [],
    locations: [],
  });
  expect(call.content).toEqual([]);
  expect(call.locations).toEqual([]);
  expect(call.reportedDetails).toEqual({
    "/update/_meta": { retained: "update" },
  });
});

it("accepts concrete false and zero raw payloads without treating them as omitted", () => {
  const { state, call } = fixture();
  applyUpdate(state, {
    sessionUpdate: "tool_call_update",
    toolCallId: "t",
    rawInput: false,
    rawOutput: 0,
  });
  expect(call.rawInput).toBe(false);
  expect(call.rawOutput).toBe(0);
});

it("initial null raw values have the same absent meaning as omitted values", () => {
  const state = freshThreadState("k", "fixture", "/work", "n");
  applyUpdate(state, {
    sessionUpdate: "tool_call",
    toolCallId: "t",
    title: "Pending",
    content: null,
    locations: null,
    rawInput: null,
    rawOutput: null,
  });
  const item = state.items[0];
  if (item?.kind !== "tool") throw new Error("missing fixture tool");
  expect(item.call.rawInput).toBeUndefined();
  expect(item.call.rawOutput).toBeUndefined();
  expect(item.call.content).toEqual([]);
  expect(item.call.locations).toEqual([]);
  expect(hasToolResult(item.call)).toBe(false);
});

it("keeps explicit null in opaque extension details without assigning v2 clear semantics to known v1 fields", () => {
  const { state, call } = fixture();
  applyUpdate(state, {
    sessionUpdate: "tool_call_update",
    toolCallId: "t",
    rawOutput: null,
    _meta: null,
    future: null,
  });
  expect(call.rawOutput).toEqual({ result: "output" });
  expect(call.reportedDetails).toHaveProperty("/update/_meta", null);
  expect(call.reportedDetails).toHaveProperty("/update/future", null);
});
