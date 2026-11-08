import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));

import { getProgramStatus } from "./program_status";
import {
  applySessionEvent,
  type SessionEventEffects,
} from "./session_event_projection";
import { applyPermissionRequest, freshThreadState } from "./session_projection";
import {
  applyFailedHistoryEvent,
  SessionOpenReplay,
} from "./session_open_replay";
import { HistoryReplayProjection } from "./history_replay_projection";
import type { ThreadState } from "./session_types";

afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockReset();
});

function state(session = "one") {
  const s = freshThreadState(
    `agent:/owned:${session}`,
    "agent",
    "/owned",
    session,
  );
  s.connectionId = "connection";
  s.identity = "established";
  s.serviceContext = "source";
  s.service = { id: "service", fingerprint: "fingerprint", model: "selected" };
  return s;
}
function effects(owns = () => true): SessionEventEffects {
  return {
    owns,
    promptOwner: vi.fn(),
    configurationChanging: vi.fn(() => false),
    receiveConfigCheck: vi.fn(() => false),
    finishActivity: vi.fn(),
    permissionChanged: vi.fn(),
    clearStop: vi.fn(),
    closeChannel: vi.fn(),
    emit: vi.fn(),
    drain: vi.fn(),
    refresh: vi.fn(),
    schedule: vi.fn(),
  };
}
function notification(s: ThreadState, message = "Program-reported notice") {
  return {
    kind: "notification",
    method: "_official/notification",
    params: { sessionId: s.nativeSessionId, original: { exact: true } },
    presentation: {
      kind: "liveStatus",
      status: { type: "notice", message, truncated: false },
    },
  };
}
function receive(s: ThreadState, event: unknown = notification(s)) {
  const fx = effects();
  applySessionEvent(s, event, true, fx, s.connectionId);
  return fx;
}

it.each(["notice", "progress"])(
  "stores the latest %s receipt outside state without execution or metadata effects",
  (type) => {
    vi.spyOn(Date, "now").mockReturnValue(12_345);
    const s = state();
    s.running = true;
    s.workEnabled = false;
    s.activeToolCallIds = ["actual-tool"];
    s.compactionActivity = {
      connectionId: s.connectionId!,
      sessionId: s.nativeSessionId,
      compactionIds: ["actual-compaction"],
      uncertain: true,
    };
    s.queuePaused = "stopped";
    s.queued = [[{ type: "text", text: "Unsent input" }]];
    applyPermissionRequest(s, {
      requestId: "actual-permission",
      toolCall: { toolCallId: "actual-tool", title: "Actual tool" },
      options: [{ optionId: "once", name: "Once", kind: "allow_once" }],
    });
    s.metaDirty = true;
    const before = JSON.stringify(s);
    const event = notification(s);
    event.presentation.status.type = type;
    const fx = receive(s, event);
    expect(getProgramStatus(s)).toEqual({
      type,
      message: "Program-reported notice",
      truncated: false,
      receivedAtMs: 12_345,
    });
    expect(JSON.stringify(s)).toBe(before);
    expect(fx.emit).toHaveBeenCalledOnce();
    for (const callback of [
      fx.finishActivity,
      fx.permissionChanged,
      fx.clearStop,
      fx.closeChannel,
      fx.drain,
      fx.refresh,
      fx.schedule,
    ])
      expect(callback).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  },
);

it("isolates exact thread objects and replaces only their own latest receipt", () => {
  const a = state("a");
  const b = state("b");
  receive(a, notification(a, "A first"));
  receive(b, notification(b, "B retained"));
  receive(a, notification(a, "A latest"));
  expect(getProgramStatus(a)?.message).toBe("A latest");
  expect(getProgramStatus(b)?.message).toBe("B retained");
  expect(getProgramStatus({ ...a })).toBeNull();
  expect(a.items).toEqual([]);
  expect(b.items).toEqual([]);
});

it.each([
  null,
  [],
  { type: "other", message: "wrong type", truncated: false },
  { type: "notice", message: "", truncated: false },
  { type: "notice", message: "   ", truncated: false },
  { type: "notice", message: "NUL\u0000", truncated: false },
  { type: "notice", message: "ESC\u001b", truncated: false },
  { type: "notice", message: "C1\u0085", truncated: false },
  { type: "notice", message: "\ud800", truncated: false },
  { type: "notice", message: "x".repeat(2049), truncated: true },
  { type: "notice", message: "kept", truncated: "false" },
  { type: "notice", message: "kept", truncated: false, future: true },
  { message: "missing type", truncated: false },
])(
  "consumes malformed known status without replacing the previous receipt: %j",
  (status) => {
    const s = state();
    receive(s, notification(s, "Previous receipt"));
    const previous = getProgramStatus(s);
    receive(s, {
      ...notification(s),
      presentation: { kind: "liveStatus", status },
    });
    expect(getProgramStatus(s)).toBe(previous);
    expect(s.items).toEqual([]);
  },
);

it("accepts the backend Unicode-scalar limit and rejects an overlong hint or extra hint fields", () => {
  const s = state();
  const message = "🙂".repeat(2048);
  receive(s, notification(s, message));
  expect(getProgramStatus(s)?.message).toBe(message);
  receive(s, notification(s, `${message}🙂`));
  const extra = notification(s, "Must not replace");
  receive(s, {
    ...extra,
    presentation: { ...extra.presentation, future: true },
  });
  expect(getProgramStatus(s)?.message).toBe(message);
  expect(s.items).toEqual([]);
});

it("preserves allowed multiline, bidi and emoji text without interpreting it", () => {
  const s = state();
  const message = "First\r\n\tSecond\u202e👩‍💻";
  receive(s, notification(s, message));
  expect(getProgramStatus(s)?.message).toBe(message);
  expect(s.items).toEqual([]);
});

it.each([undefined, null, { kind: "futureStatus", status: {} }, {}])(
  "keeps unknown or absent presentation as an ordinary raw notification: %j",
  (presentation) => {
    const s = state();
    const event = { ...notification(s), presentation };
    receive(s, event);
    expect(getProgramStatus(s)).toBeNull();
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({
      kind: "raw",
      update: { method: event.method, params: event.params },
    });
    if (s.items[0]?.kind === "raw")
      expect((s.items[0].update as { params: unknown }).params).toBe(
        event.params,
      );
  },
);

it("refuses foreign session IDs, old delivery connections and unpublished or historical effects", () => {
  const s = state();
  const fx = effects();
  applySessionEvent(
    s,
    { ...notification(s), params: { sessionId: "foreign" } },
    true,
    fx,
    s.connectionId,
  );
  applySessionEvent(s, notification(s), true, fx, "old-connection");
  applySessionEvent(
    s,
    notification(s),
    true,
    effects(() => false),
  );
  applySessionEvent(s, notification(s), false, fx);
  applySessionEvent(s, notification(s), true);
  expect(getProgramStatus(s)).toBeNull();
  expect(s.items).toEqual([]);
});

it("does not execute an own update or nested controls from a recognized status wrapper", () => {
  const s = state();
  s.activeToolCallIds = ["retained-tool"];
  s.permissionState = "unknown";
  const before = JSON.stringify(s);
  for (const update of [
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "spoof" },
    },
    { kind: "permissionState", permissionState: "ready" },
    { kind: "toolActivity", toolCallIds: [] },
  ])
    receive(s, { ...notification(s), update });
  expect(JSON.stringify(s)).toBe(before);
  expect(getProgramStatus(s)).toBeNull();
  const event = notification(s);
  receive(s, {
    ...event,
    params: { ...event.params, update: { kind: "connectionLost" } },
  });
  expect(getProgramStatus(s)).not.toBeNull();
  expect(JSON.stringify(s)).toBe(before);
});

it("does not trust or swallow presentation fields on a standard session/update envelope", () => {
  const s = state();
  const original = {
    ...notification(s, "Untrusted Agent-provided hint"),
    sessionId: s.nativeSessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Actual standard message" },
    },
  };
  receive(s, original);
  expect(getProgramStatus(s)).toBeNull();
  expect(s.items).toMatchObject([
    { kind: "agent", text: "Actual standard message" },
  ]);

  const failed = state("failed");
  const raw = { ...original, sessionId: failed.nativeSessionId };
  const history = new HistoryReplayProjection(failed, "owner", () => {
    throw new TypeError("actual conversion failure");
  });
  history.push({ update: { sessionUpdate: "future" } });
  history.push(raw);
  expect(failed.items.at(-1)).toMatchObject({ kind: "raw", update: raw });
  const emit = vi.fn();
  applyFailedHistoryEvent(failed, raw, vi.fn(), emit);
  expect(failed.items.at(-1)).toMatchObject({ kind: "raw", update: raw });
  expect(emit).toHaveBeenCalledOnce();
  expect(getProgramStatus(failed)).toBeNull();
});

it.each([
  "key",
  "agentId",
  "cwd",
  "nativeSessionId",
  "connectionId",
  "serviceContext",
] as const)(
  "invalidates a receipt after %s changes without reviving it on restoration",
  (field) => {
    const s = state();
    receive(s);
    const original = s[field];
    s[field] = "changed";
    expect(getProgramStatus(s)).toBeNull();
    Object.assign(s, { [field]: original });
    expect(getProgramStatus(s)).toBeNull();
  },
);

it.each(["id", "fingerprint"] as const)(
  "invalidates a changed service %s",
  (field) => {
    const s = state();
    receive(s);
    s.service![field] = "changed";
    expect(getProgramStatus(s)).toBeNull();
  },
);

it.each([
  "connectionLost",
  "reconnecting",
  "historyUnavailable",
  "processEnded",
])("does not expose or accept a receipt for a %s owner", (condition) => {
  const s = state();
  receive(s);
  if (condition === "connectionLost") s.connectionLost = true;
  if (condition === "reconnecting") s.reconnecting = true;
  if (condition === "historyUnavailable")
    s.historyUnavailable = { reason: "incomplete", sourceKnown: true };
  if (condition === "processEnded") s.processEndedConnectionId = s.connectionId;
  expect(getProgramStatus(s)).toBeNull();
  receive(s);
  expect(getProgramStatus(s)).toBeNull();
  expect(s.items).toEqual([]);
});

it("invalidates an owner removed from the published map", () => {
  const s = state();
  let current = s;
  applySessionEvent(
    s,
    notification(s),
    true,
    effects(() => current === s),
  );
  current = { ...s };
  expect(getProgramStatus(s)).toBeNull();
});

it("hides the old receipt after the actual source-unavailable event without changing its guards", () => {
  const s = state();
  receive(s);
  const source = s.service;
  const context = s.serviceContext;
  const fx = effects();
  applySessionEvent(s, { kind: "serviceUnavailable" }, true, fx);
  expect(s.sourceError).toBe(true);
  expect(s.service).toBe(source);
  expect(s.serviceContext).toBe(context);
  expect(s.queuePaused).toBe("unavailable");
  expect(getProgramStatus(s)).toBeNull();
  receive(s, notification(s, "Must not replace from an unavailable source"));
  expect(getProgramStatus(s)).toBeNull();
  expect(fx.drain).not.toHaveBeenCalled();
});

it("never transfers temporary hints from actual private replay, including live following", () => {
  const s = state();
  const opening = new SessionOpenReplay(
    { agentId: s.agentId, cwd: s.cwd, nativeSessionId: s.nativeSessionId },
    undefined,
    undefined,
    "00000000-0000-4000-8000-000000000001",
  );
  opening.push({
    kind: "sessionOpening",
    openToken: opening.token,
    cwd: s.cwd,
    sessionId: s.nativeSessionId,
    connectionId: s.connectionId,
  });
  opening.push(notification(s, "Historical hint"));
  opening.push({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Real retained history" },
    },
  });
  opening.receiveMarker({
    kind: "session_history_complete",
    openToken: opening.token,
  });
  opening.push(notification(s, "Following hint"));
  const published = opening.accept(
    {
      cwd: s.cwd,
      nativeSessionId: s.nativeSessionId,
      connectionId: s.connectionId,
      resumed: true,
      service: null,
      configOptions: [],
      warnings: [],
      configCheck: { status: "ready", current: { choices: [] }, issues: [] },
    },
    null,
  );
  expect(getProgramStatus(published)).toBeNull();
  expect(published.items).toHaveLength(1);
  expect(JSON.stringify(published)).not.toContain("hint");
  receive(published, notification(published, "Actually live"));
  expect(getProgramStatus(published)?.message).toBe("Actually live");
});

it("excludes known hints from both failed raw-history fallbacks without losing unknown notifications", () => {
  const s = state();
  const history = new HistoryReplayProjection(s, "owned", () => {
    throw new TypeError("actual conversion failure");
  });
  history.push({ update: { sessionUpdate: "future", actual: "failure" } });
  const before = s.items.length;
  const spoof = {
    ...notification(s),
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "spoof" },
    },
  };
  history.push(spoof);
  const apply = vi.fn();
  const emit = vi.fn();
  applyFailedHistoryEvent(s, spoof, apply, emit);
  expect(s.items).toHaveLength(before);
  expect(apply).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
  expect(getProgramStatus(s)).toBeNull();
  const unknown = {
    ...notification(s),
    presentation: { kind: "futureStatus" },
  };
  history.push(unknown);
  expect(s.items).toHaveLength(before + 1);
  applyFailedHistoryEvent(s, unknown, apply, emit);
  expect(apply).toHaveBeenCalledWith(unknown);
});
