import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import {
  getSessionCumulativeTokens,
  receiveSessionUsage,
} from "./session_usage_notification";
import { freshThreadState } from "./session_projection";
import { applySessionEvent } from "./session_event_projection";
import { SessionOpenReplay } from "./session_open_replay";

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
  expect(getSessionCumulativeTokens(s)).toEqual({
    inputTokens: 0,
    outputTokens: 0,
  });
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

it.each([
  null,
  undefined,
  -1,
  0.5,
  "10",
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
])(
  "does not invent cumulative counters from malformed or absent input %s",
  (value) => {
    const s = state();
    const e: any = event();
    e.presentation.usage.accumulatedInputTokens = value;
    expect(receiveSessionUsage(s, e)).toBe(false);
    expect(getSessionCumulativeTokens(s)).toBeNull();
  },
);

it("retains the original report, does not mutate its numbers, and does not revive a retired connection's counters", () => {
  const s = state();
  const e = event();
  e.presentation.usage.accumulatedInputTokens = 123;
  e.presentation.usage.accumulatedOutputTokens = 456;
  const before = structuredClone(e);
  expect(receiveSessionUsage(s, e)).toBe(true);
  expect(e).toEqual(before);
  expect(getSessionCumulativeTokens(s)).toEqual({
    inputTokens: 123,
    outputTokens: 456,
  });
  s.connectionId = "replacement";
  expect(getSessionCumulativeTokens(s)).toBeNull();
  s.connectionId = "owned-connection";
  expect(getSessionCumulativeTokens(s)).toBeNull();
  expect(s.reportedDetails).toMatchObject({ "/usage_update/params": e.params });
});

it("keeps the passive counters when an accepted history open publishes its exact private view", () => {
  const s = state();
  let current = true;
  const opening = new SessionOpenReplay(
    { agentId: s.agentId, cwd: s.cwd, nativeSessionId: s.nativeSessionId },
    undefined,
    undefined,
    "00000000-0000-4000-8000-000000000002",
    () => current,
  );
  opening.push({
    kind: "sessionOpening",
    openToken: opening.token,
    cwd: s.cwd,
    sessionId: s.nativeSessionId,
    connectionId: s.connectionId,
  });
  opening.push(event());
  opening.receiveMarker({
    kind: "session_history_complete",
    openToken: opening.token,
  });
  const published = opening.accept(
    {
      cwd: s.cwd,
      nativeSessionId: s.nativeSessionId,
      connectionId: s.connectionId,
      resumed: true,
      historyEmptyConfirmed: true,
      configOptions: [],
      warnings: [],
      service: { id: "service", fingerprint: "selected", model: "kept" },
      configCheck: { status: "ready", current: { choices: [] }, issues: [] },
    },
    null,
  );
  expect(getSessionCumulativeTokens(published)).toEqual({
    inputTokens: 0,
    outputTokens: 0,
  });
  expect(published.items).toEqual([]);
  expect(published.running).toBe(false);
  current = false;
  expect(opening.push(event())).toBe("discarded");
});
