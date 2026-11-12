import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { receiveSessionUsage } from "./session_usage_notification";
import { freshThreadState } from "./session_projection";
import { applySessionEvent } from "./session_event_projection";

function state() {
  const s = freshThreadState("fixture:/p:owned", "fixture", "/p", "owned");
  s.connectionId = "owned-connection";
  return s;
}
function event() {
  return {
    kind: "notification",
    method: "official-notification",
    params: { sessionId: "owned", update: { original: "retained" } },
    presentation: {
      kind: "sessionUsage",
      connectionId: "owned-connection",
      usage: {
        used: 0,
        contextLimit: 1000000,
        accumulatedInputTokens: 0,
        accumulatedOutputTokens: 0,
        accumulatedCost: null,
      },
    },
  };
}
it("projects context metadata without creating a message or changing work guards", () => {
  const s = state();
  s.queued = [[{ type: "text", text: "Unsent" }]];
  s.queuePaused = "stopped";
  s.modelDrift = true;
  const e = event();
  applySessionEvent(s, e, false);
  expect(s.usage).toEqual({ used: 0, size: 1000000 });
  expect(s.items).toEqual([]);
  expect(s.reportedDetails).toMatchObject({ "/usage_update/params": e.params });
  expect(s.queued).toEqual([[{ type: "text", text: "Unsent" }]]);
  expect(s.queuePaused).toBe("stopped");
  expect(s.modelDrift).toBe(true);
  expect(s.sessionTokens).toBeNull();
});
it.each([
  "foreign session",
  "foreign connection",
  "own update",
  "invalid count",
  "unknown hint field",
])(
  "retains %s as raw rather than granting metadata classification",
  (change) => {
    const s = state();
    const e: any = event();
    if (change === "foreign session") e.params.sessionId = "other";
    if (change === "foreign connection") e.presentation.connectionId = "other";
    if (change === "own update") e.update = { sessionUpdate: "future_history" };
    if (change === "invalid count") e.presentation.usage.used = -1;
    if (change === "unknown hint field") e.presentation.extra = true;
    expect(receiveSessionUsage(s, e)).toBe(false);
    applySessionEvent(s, e, false);
    expect(s.usage).toBeNull();
    expect(s.items[0]?.kind).toBe("raw");
  },
);
it("requires the exact active delivery owner", () => {
  const s = state();
  expect(receiveSessionUsage(s, event(), () => false)).toBe(false);
  expect(receiveSessionUsage(s, event(), () => true, "other")).toBe(false);
  s.connectionLost = true;
  expect(receiveSessionUsage(s, event())).toBe(false);
  expect(s.usage).toBeNull();
});
