import { expect, it } from "vitest";
import {
  appendToolOutput,
  COMMAND_OUTPUT_CAP as CAP,
  paneCards,
} from "./artifacts";
import { applyUpdate, freshThreadState } from "./session_projection";
import type { ThreadState, ToolCallView } from "./session_types";

type Route = "raw string" | "output field" | "content fallback" | "terminal";
type Kind = "execute" | "read";
const routes: Route[] = [
  "raw string",
  "output field",
  "content fallback",
  "terminal",
];
const kinds: Kind[] = ["execute", "read"];
const cases = kinds.flatMap((kind) => routes.map((route) => ({ kind, route })));
const toolId = "owned-output-tool";
const terminalId = "owned-output-terminal";

function subject(kind: Kind, route: Route, output: string) {
  const state = freshThreadState(
    "output-owner",
    "controlled",
    "/owned-output",
    "output-session",
  );
  state.connectionId = "output-connection";
  state.running = true;
  applyUpdate(state, {
    sessionUpdate: "tool_call",
    toolCallId: toolId,
    title: "Owned current output",
    kind,
    status: "in_progress",
    rawInput: { command: "INPUT_IS_NOT_OUTPUT" },
    rawOutput:
      route === "raw string"
        ? output
        : route === "output field"
          ? { output }
          : route === "content fallback"
            ? { output: "" }
            : "OTHER_RAW_OUTPUT",
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: route === "content fallback" ? output : "OTHER_TEXT_OUTPUT",
        },
      },
      { type: "terminal", terminalId },
    ],
  });
  state.activeToolCallIds = [toolId];
  if (route === "terminal") append(state, output);
  return state;
}

function append(state: ThreadState, data: string) {
  appendToolOutput(state, { toolCallId: toolId, terminalId, data });
}

function call(state: ThreadState): ToolCallView {
  const item = state.items.find((item) => item.kind === "tool");
  if (item?.kind !== "tool") throw new Error("Missing actual tool projection");
  return item.call;
}

function card(state: ThreadState) {
  const before = JSON.stringify(state.items);
  const cards = paneCards(state);
  expect(cards).toHaveLength(1);
  expect(JSON.stringify(state.items)).toBe(before);
  const result = cards[0];
  if (result.kind === "diff") throw new Error("Expected output card");
  expect(result.status).toBe("in_progress");
  return result;
}

function expectOutput(
  state: ThreadState,
  kind: Kind,
  expected: string,
  outputTruncated: boolean,
  scalarText = true,
) {
  const result = card(state);
  expect(result.kind).toBe(kind === "execute" ? "command" : "log");
  expect(result.output).toBe(expected);
  expect(result.output.length).toBeLessThanOrEqual(CAP);
  expect(result.outputTruncated).toBe(outputTruncated);
  if (scalarText)
    expect(
      new TextDecoder().decode(new TextEncoder().encode(result.output)),
    ).toBe(result.output);
}

it.each(cases)(
  "$kind $route drops only the split pair at a CAP+1 suffix boundary",
  ({ kind, route }) => {
    const original = "🙂" + "x".repeat(CAP - 1);
    expect(original.length).toBe(CAP + 1);
    const state = subject(kind, route, original);
    expectOutput(state, kind, "x".repeat(CAP - 1), true);
    if (route !== "terminal") {
      const source = call(state);
      if (route === "raw string") expect(source.rawOutput).toBe(original);
      if (route === "output field")
        expect(source.rawOutput).toEqual({ output: original });
      if (route === "content fallback")
        expect(source.content[0]).toEqual({ type: "text", text: original });
    }
  },
);

it.each(cases)(
  "$kind $route keeps an exact-CAP complete pair without claiming clipping",
  ({ kind, route }) => {
    const original = "🙂" + "x".repeat(CAP - 2);
    expect(original.length).toBe(CAP);
    expectOutput(subject(kind, route, original), kind, original, false);
  },
);

it.each(cases)(
  "$kind $route keeps a full pair exactly at a clipped suffix start",
  ({ kind, route }) => {
    const expected = "🙂" + "x".repeat(CAP - 2);
    expectOutput(
      subject(kind, route, "discarded-prefix" + expected),
      kind,
      expected,
      true,
    );
  },
);

it.each(kinds)(
  "%s terminal keeps the truncation fact after a later small or empty chunk",
  (kind) => {
    const state = subject(kind, "terminal", "🙂" + "x".repeat(CAP - 1));
    expect(call(state).terminalOutputTruncated).toBe(true);
    append(state, "!");
    expectOutput(state, kind, "x".repeat(CAP - 1) + "!", true);
    append(state, "");
    expect(call(state).terminalOutputTruncated).toBe(true);
    expectOutput(state, kind, "x".repeat(CAP - 1) + "!", true);
  },
);

it.each(kinds)(
  "%s terminal joins a pair delivered across two direct append chunks",
  (kind) => {
    // Direct reducer inputs, not a claim about admission of lone units by the
    // official JSON parser. Do not sanitize a source chunk before its partner.
    const state = subject(kind, "terminal", "");
    append(state, "\ud83d");
    expect(call(state).terminalOutput).toBe("\ud83d");
    expect(call(state).terminalOutputTruncated).toBe(false);
    append(state, "\ude42" + "x".repeat(CAP - 2));
    expectOutput(state, kind, "🙂" + "x".repeat(CAP - 2), false);
  },
);

it.each(kinds)(
  "%s still bounds a prior terminal value when projecting a card",
  (kind) => {
    const state = subject(kind, "raw string", "OTHER_RAW_OUTPUT");
    // An existing/hand-supplied in-memory value must not bypass card bounds.
    call(state).terminalOutput = "🙂" + "x".repeat(CAP - 1);
    expectOutput(state, kind, "x".repeat(CAP - 1), true);
  },
);

it.each(kinds)(
  "%s rejects mismatched tool or terminal append ownership without mutation",
  (kind) => {
    const state = subject(kind, "terminal", "🙂" + "x".repeat(CAP - 1));
    for (const owner of [
      { toolCallId: "other-tool", terminalId },
      { toolCallId: toolId, terminalId: "other-terminal" },
    ]) {
      const before = JSON.stringify(state.items);
      appendToolOutput(state, { ...owner, data: "WRONG_OWNER" });
      expect(JSON.stringify(state.items)).toBe(before);
      expectOutput(state, kind, "x".repeat(CAP - 1), true);
    }
  },
);

it("preserves source-isolated code units rather than sanitizing retained text", () => {
  for (const { kind, route } of cases) {
    const short = "\ud83dSOURCE\ude42";
    expectOutput(subject(kind, route, short), kind, short, false, false);
    const original = "p\ude42" + "x".repeat(CAP - 1);
    const expected = "\ude42" + "x".repeat(CAP - 1);
    expectOutput(subject(kind, route, original), kind, expected, true, false);
  }
});
