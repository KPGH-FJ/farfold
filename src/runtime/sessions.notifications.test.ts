import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));

import { threads } from "./sessions";
import {
  applyConnectionLost,
  applyTurnEnd,
  applyUpdate,
  pushRaw,
} from "./session_projection";
import type { ThreadState } from "./session_types";

let sequence = 0;
function state() {
  const s = threads.markOpenFailed(
    `notifications:${++sequence}`,
    "fixture",
    "/p",
    "history",
    "fixture",
  );
  s.openError = null;
  return s;
}
function event(s: ThreadState, value: unknown) {
  (
    threads as unknown as {
      applyChannelEvent: (key: string, value: unknown) => void;
    }
  ).applyChannelEvent(s.key, value);
}
function chunk(s: ThreadState, text: string) {
  event(s, {
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });
}
function notification(s: ThreadState) {
  const params = { state: "complete", future: { retained: true } };
  event(s, { kind: "notification", method: "_future/status", params });
  return params;
}
function replies(s: ThreadState) {
  return s.items.filter((item) => item.kind === "agent");
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("keeps a word and Markdown intact across ordinary notifications without losing envelopes", () => {
  const s = state();
  chunk(s, "MARK");
  const first = notification(s);
  const second = notification(s);
  chunk(s, "ER\n**whole ");
  notification(s);
  chunk(s, "answer**");
  expect(replies(s)).toHaveLength(1);
  expect(replies(s)[0]).toMatchObject({
    text: "MARKER\n**whole answer**",
    streaming: true,
  });
  const raw = s.items.filter((item) => item.kind === "raw");
  expect(raw).toHaveLength(3);
  expect(raw[0].update).toEqual({ method: "_future/status", params: first });
  expect((raw[0].update as { params: unknown }).params).toBe(first);
  expect((raw[1].update as { params: unknown }).params).toBe(second);
});

it("keeps structured attachments with their still-open message across notifications", () => {
  const s = state();
  chunk(s, "before");
  notification(s);
  event(s, {
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource_link",
        uri: "file:///p/notes.md",
        name: "notes",
      },
    },
  });
  notification(s);
  chunk(s, "after");
  expect(replies(s)).toHaveLength(1);
  expect(replies(s)[0]).toMatchObject({
    text: "beforeafter",
    attachments: [
      { kind: "resource_link", uri: "file:///p/notes.md", name: "notes" },
    ],
  });
});

const tool = (s: ThreadState) =>
  applyUpdate(s, {
    sessionUpdate: "tool_call",
    toolCallId: "tool",
    title: "Fixture",
    kind: "read",
    status: "pending",
  });
it.each([
  ["tool", tool],
  [
    "old tool updated in place",
    (s: ThreadState) =>
      applyUpdate(s, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool",
        status: "completed",
      }),
  ],
  [
    "thought",
    (s: ThreadState) =>
      applyUpdate(s, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      }),
  ],
  [
    "user",
    (s: ThreadState) =>
      applyUpdate(s, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "question" },
      }),
  ],
  [
    "plan",
    (s: ThreadState) => applyUpdate(s, { sessionUpdate: "plan", entries: [] }),
  ],
  [
    "unknown update",
    (s: ThreadState) =>
      applyUpdate(s, { sessionUpdate: "_future/update", streamNeutral: true }),
  ],
  [
    "unsupported content",
    (s: ThreadState) =>
      applyUpdate(s, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "future", streamNeutral: true },
      }),
  ],
  [
    "completed request",
    (s: ThreadState) => applyTurnEnd(s, { stopReason: "end_turn" }),
  ],
  ["lost connection", (s: ThreadState) => applyConnectionLost(s)],
] as const)(
  "does not join replies across %s even with transparent notifications at the tail",
  (name, boundary) => {
    const s = state();
    if (name === "old tool updated in place") tool(s);
    chunk(s, "before");
    notification(s);
    boundary(s);
    notification(s);
    chunk(s, "after");
    expect(replies(s).map((item) => item.text)).toEqual(["before", "after"]);
  },
);

it("does not treat an old raw notification label as a transparent stream marker", () => {
  const s = state();
  chunk(s, "before");
  pushRaw(s, { method: "_future/status" }, "notification");
  notification(s);
  chunk(s, "after");
  expect(replies(s).map((item) => item.text)).toEqual(["before", "after"]);
});

it("does not reopen completed history when a notification precedes new text", () => {
  const s = state();
  s.items.push({
    kind: "agent",
    id: "history",
    text: "old",
    streaming: false,
    time: 0,
  });
  notification(s);
  chunk(s, "new");
  expect(replies(s).map((item) => item.text)).toEqual(["old", "new"]);
});
