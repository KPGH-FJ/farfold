import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
import { applySessionEvent } from "./session_event_projection";
import { getMessageUsage } from "./message_usage";
import {
  SessionOpenReplay,
  applyFailedHistoryEvent,
} from "./session_open_replay";
import { HistoryReplayProjection } from "./history_replay_projection";
import { freshThreadState } from "./session_projection";

const report = () => ({
  messageId: null,
  inputTokens: 10,
  outputTokens: null,
  totalTokens: 12,
  cacheReadTokens: null,
  cacheWriteTokens: 0,
  cost: 0.00001,
  costSource: "estimated",
  elapsedMs: 400,
  timeToFirstTokenMs: null,
  isCompaction: true,
});
function state(session = "one") {
  const s = freshThreadState(
    `agent:/owned:${session}`,
    "agent",
    "/owned",
    session,
  );
  s.connectionId = "connection";
  return s;
}
function event(s = state(), usage: unknown = report()) {
  return {
    kind: "notification",
    method: "_official/notification",
    params: { sessionId: s.nativeSessionId, original: { exact: true } },
    presentation: { kind: "messageUsage", connectionId: s.connectionId, usage },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockReset();
});
it("consumes normalized per-message usage without making it a raw card or cumulative/work authority", () => {
  const s = state();
  s.running = true;
  s.activeToolCallIds = ["real-tool"];
  const before = JSON.stringify(s);
  applySessionEvent(s, event(s), false);
  expect(s.items).toEqual([]);
  expect(JSON.stringify(s)).toBe(before);
  expect(h.invoke).not.toHaveBeenCalled();
});

it("keeps null distinct from zero, preserves per-message totals and never adds replayed reports", () => {
  const s = state();
  vi.spyOn(Date, "now").mockReturnValue(12345);
  applySessionEvent(s, event(s), false);
  expect(getMessageUsage(s)).toEqual({ ...report(), receivedAtMs: 12345 });
  applySessionEvent(
    s,
    event(s, {
      ...report(),
      totalTokens: 4,
      inputTokens: 999,
      isCompaction: null,
    }),
    false,
  );
  expect(getMessageUsage(s)).toMatchObject({
    totalTokens: 4,
    inputTokens: 999,
    outputTokens: null,
    cacheWriteTokens: 0,
    isCompaction: null,
  });
  expect(s.usage).toBeNull();
  expect(s.sessionTokens).toBeNull();
  expect(s.compactionActivity).toBeUndefined();
  expect(getMessageUsage({ ...s })).toBeNull();
});
it.each([
  null,
  {},
  [],
  { ...report(), inputTokens: -1 },
  { ...report(), totalTokens: Number.MAX_SAFE_INTEGER + 1 },
  { ...report(), outputTokens: 1.1 },
  { ...report(), cost: Infinity },
  { ...report(), cost: -1 },
  { ...report(), costSource: "USD" },
  { ...report(), isCompaction: "true" },
  { ...report(), messageId: "" },
  { ...report(), messageId: "bad\u0000" },
  { ...report(), messageId: "x".repeat(1025) },
  { ...report(), messageId: "\ud800" },
  { ...report(), future: 1 },
  { ...report(), elapsedMs: undefined },
])(
  "consumes invalid known hints without replacing a valid receipt: %j",
  (usage) => {
    const s = state();
    applySessionEvent(s, event(s), false);
    const before = getMessageUsage(s);
    applySessionEvent(s, event(s, usage), false);
    expect(getMessageUsage(s)).toBe(before);
    expect(s.items).toEqual([]);
  },
);
it("preserves an opaque Unicode message ID without claiming message association", () => {
  const s = state();
  const messageId = "🙂".repeat(1024);
  applySessionEvent(s, event(s, { ...report(), messageId }), false);
  expect(getMessageUsage(s)?.messageId).toBe(messageId);
});
it("rejects wrong connection/session, unpublished live effects and spoofed wrappers", () => {
  const s = state();
  const original = event(s);
  const bad = [
    {
      ...original,
      presentation: { ...original.presentation, connectionId: "old" },
    },
    { ...original, params: { sessionId: "other" } },
    { ...original, update: { kind: "connectionLost" } },
    { ...original, presentation: { ...original.presentation, future: true } },
  ];
  for (const e of bad) applySessionEvent(s, e, false);
  applySessionEvent(s, original, true, { owns: () => false } as never);
  applySessionEvent(s, original, false, undefined, "old");
  expect(getMessageUsage(s)).toBeNull();
  expect(s.items).toEqual([]);
  const b = state("other");
  applySessionEvent(b, original, false);
  expect(getMessageUsage(b)).toBeNull();
});
it("keeps unknown presentation raw and does not trust a standard envelope's hint", () => {
  const s = state();
  const original = event(s);
  applySessionEvent(
    s,
    { ...original, presentation: { kind: "futureUsage" } },
    false,
  );
  expect(s.items).toHaveLength(1);
  applySessionEvent(
    s,
    {
      ...original,
      sessionId: s.nativeSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Actual message" },
      },
    },
    false,
  );
  expect(s.items.at(-1)).toMatchObject({
    kind: "agent",
    text: "Actual message",
  });
  expect(getMessageUsage(s)).toBeNull();
});
it.each(["key", "agentId", "cwd", "nativeSessionId", "connectionId"] as const)(
  "invalidates changed %s without reviving an old receipt",
  (field) => {
    const s = state();
    applySessionEvent(s, event(s), false);
    const old = s[field];
    s[field] = "changed";
    expect(getMessageUsage(s)).toBeNull();
    Object.assign(s, { [field]: old });
    expect(getMessageUsage(s)).toBeNull();
  },
);
it.each([
  "connectionLost",
  "reconnecting",
  "sourceError",
  "openError",
  "historyUnavailable",
  "processEnded",
])("hides %s metadata and does not accept another report", (condition) => {
  const s = state();
  applySessionEvent(s, event(s), false);
  Object.assign(
    s,
    condition === "processEnded"
      ? { processEndedConnectionId: s.connectionId }
      : { [condition]: true },
  );
  expect(getMessageUsage(s)).toBeNull();
  applySessionEvent(s, event(s), false);
  expect(getMessageUsage(s)).toBeNull();
});
it("transfers the same passive receipt only with an accepted real history view", () => {
  const s = state();
  let current = true;
  const opening = new SessionOpenReplay(
    { agentId: s.agentId, cwd: s.cwd, nativeSessionId: s.nativeSessionId },
    undefined,
    undefined,
    "00000000-0000-4000-8000-000000000001",
    () => current,
  );
  opening.push({
    kind: "sessionOpening",
    openToken: opening.token,
    cwd: s.cwd,
    sessionId: s.nativeSessionId,
    connectionId: s.connectionId,
  });
  opening.push(event(s));
  opening.push({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Retained history" },
    },
  });
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
      service: { id: "service", fingerprint: "selected", model: "kept" },
      configOptions: [],
      warnings: [],
      configCheck: { status: "ready", current: { choices: [] }, issues: [] },
    },
    null,
  );
  expect(getMessageUsage(published)?.inputTokens).toBe(10);
  expect(published.items).toHaveLength(1);
  expect(JSON.stringify(published)).not.toContain("receivedAtMs");
  current = false;
  expect(opening.push(event(s))).toBe("discarded");
});
it("does not display metadata from retired or failed private history", () => {
  const s = state();
  let current = false;
  const retired = new HistoryReplayProjection(
    s,
    "owner",
    (state, e) => applySessionEvent(state, e, false),
    () => current,
  );
  expect(retired.push(event(s))).toBe("discarded");
  expect(getMessageUsage(s)).toBeNull();
  current = true;
  const failed = new HistoryReplayProjection(s, "owner", () => {
    throw new TypeError("actual failure");
  });
  failed.push({ update: { sessionUpdate: "future" } });
  const count = s.items.length;
  failed.push(event(s));
  expect(s.items).toHaveLength(count);
  const apply = vi.fn(),
    emit = vi.fn();
  applyFailedHistoryEvent(s, event(s), apply, emit);
  expect(apply).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
  expect(getMessageUsage(s)).toBeNull();
});
