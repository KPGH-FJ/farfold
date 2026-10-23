import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));

import { HistoryReplayProjection } from "./history_replay_projection";
import { applyUpdate, freshThreadState, pushRaw } from "./session_projection";
import { historyFailureKey, isHistoryReadFailure } from "./session_recovery";
import type { OpenResult } from "./session_open_types";
import type { ThreadState } from "./session_types";
import { STRINGS } from "./strings";
import { SessionDeliveryFlow } from "./session_delivery_flow";

afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockReset();
});

const result: OpenResult = {
  cwd: "/known",
  nativeSessionId: "known-history",
  resumed: true,
  configOptions: [],
  warnings: [],
};
const fresh = () =>
  freshThreadState(
    "agent:/known:known-history",
    "agent",
    "/known",
    "known-history",
  );
const message = (text: string) => ({
  update: {
    sessionUpdate: "agent_message_chunk",
    messageId: text,
    content: { type: "text", text },
  },
});
function apply(state: ThreadState, event: unknown) {
  if (event && typeof event === "object" && Object.hasOwn(event, "update"))
    applyUpdate(state, (event as { update: unknown }).update, event);
  else pushRaw(state, event);
}
function failure(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected local history failure");
}

it("projects each delivered event once and transfers that same full private view", () => {
  const state = fresh();
  const items = state.items;
  const project = vi.fn(apply);
  const history = new HistoryReplayProjection(state, "owner", project);
  for (let index = 0; index < 2048; index++) {
    expect(history.push(message(`owned-${index}`))).toBe("consumed");
    expect(items).toHaveLength(index + 1);
  }
  history.mark("owner");
  history.requireReadable("agent", result, false);
  // Revalidating must neither project nor allocate another item list.
  history.requireReadable("agent", result, false);
  const transferred = history.take();
  expect(transferred).toBe(state);
  expect(transferred.items).toBe(items);
  expect(project).toHaveBeenCalledTimes(2048);
  expect(items[2047]).toMatchObject({ text: "owned-2047", time: 0 });
  expect(history.state).toBeUndefined();
  expect(history.push(message("retired"))).toBe("discarded");
  expect(items).toHaveLength(2048);
});

it("retains unknown raw payload and envelope details through the actual reducer once", () => {
  const state = fresh();
  const unknown = {
    update: { sessionUpdate: "future_history", exact: [null, "中文🙂", false] },
    opaqueEnvelope: { original: "retained" },
  };
  const history = new HistoryReplayProjection(state, "owner", apply);
  history.push(message("readable"));
  history.push(unknown);
  history.mark("owner");
  history.requireReadable("agent", result, false);
  const transferred = history.take();
  const raw = transferred.items.filter((item) => item.kind === "raw");
  expect(raw).toHaveLength(1);
  expect(raw[0]?.update).toBe(unknown.update);
  expect(JSON.stringify(transferred)).toContain("opaqueEnvelope");
  expect(JSON.stringify(transferred)).toContain("retained");
});

it("seals the prefix once and projects following into the same state with its actual phase", () => {
  vi.spyOn(Date, "now").mockReturnValue(30_000);
  const state = fresh();
  const phases: string[] = [];
  const history = new HistoryReplayProjection(
    state,
    "owner",
    (target, event, phase) => {
      phases.push(phase);
      apply(target, event);
    },
  );
  history.push(message("prefix"));
  expect(history.mark("other-owner")).toBe(false);
  expect(history.complete).toBe(false);
  expect(history.mark("owner")).toBe(true);
  history.push(message("following"));
  expect(history.mark("owner")).toBe(true);
  history.requireReadable("agent", result, false);
  expect(phases).toEqual(["history", "following"]);
  expect(history.take().items).toEqual([
    expect.objectContaining({ text: "prefix", streaming: false, time: 0 }),
    expect.objectContaining({
      text: "following",
      streaming: true,
      time: 30_000,
    }),
  ]);
});

it("does not let post-marker text or a repeated marker repair an empty historical prefix", () => {
  const history = new HistoryReplayProjection(fresh(), "owner", apply);
  history.mark("owner");
  history.push(message("new live body"));
  history.mark("owner");
  const error = failure(() => history.requireReadable("agent", result, false));
  expect(isHistoryReadFailure(error)).toBe(true);
  expect(error).toMatchObject({ reason: "empty" });
  expect(historyFailureKey(error)).toBe("agent:/known:known-history");
});

it("retains incomplete failure despite readable unacknowledged content", () => {
  const history = new HistoryReplayProjection(fresh(), "owner", apply);
  history.push(message("unconfirmed"));
  history.mark("someone-else");
  const error = failure(() => history.requireReadable("agent", result, false));
  expect(error).toMatchObject({ reason: "incomplete" });
  expect(isHistoryReadFailure(error)).toBe(true);
});

it("keeps missing marker ahead of a conversion failure, while a complete empty preview stays representable", () => {
  const failed = new HistoryReplayProjection(fresh(), "owner", () => {
    throw new TypeError("actual earlier conversion");
  });
  failed.push({});
  expect(
    failure(() => failed.requireReadable("agent", result, false)),
  ).toMatchObject({ reason: "incomplete" });
  const empty = new HistoryReplayProjection(fresh(), "owner", apply);
  empty.mark("owner");
  expect(() => empty.requireComplete("agent", result, false)).not.toThrow();
  expect(empty.take().items).toEqual([]);
});

it("keeps the first actual JSON conversion failure private and typed without reprojecting", () => {
  const old = fresh();
  apply(old, message("keep old"));
  old.queued = [[{ type: "text", text: "keep draft" }]];
  const oldItems = old.items;
  const oldQueue = old.queued;
  const staged = fresh();
  const project = vi.fn(apply);
  const history = new HistoryReplayProjection(staged, "owner", project);
  history.push(message("new before failure"));
  expect(
    history.push({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: JSON.parse('{"toString":null,"valueOf":null}'),
      },
    }),
  ).toBe("consumed");
  const following = message("retained raw, never admitted as readable");
  expect(history.push(following)).toBe("consumed");
  expect(staged.items.at(-1)).toMatchObject({ kind: "raw", update: following });
  history.mark("owner");
  const error = failure(() => history.requireReadable("agent", result, false));
  expect(error).toBeInstanceOf(TypeError);
  expect(error).toMatchObject({
    reason: "unreadable",
    cause: expect.any(TypeError),
  });
  expect(isHistoryReadFailure(error)).toBe(true);
  expect(project).toHaveBeenCalledTimes(2);
  expect(() => history.take()).toThrow(TypeError);
  history.clear();
  expect(old.items).toBe(oldItems);
  expect(old.queued).toBe(oldQueue);
  expect(old.items[0]).toMatchObject({ text: "keep old" });
});

it("keeps genuine connection loss separate from a previously recorded conversion failure", () => {
  const history = new HistoryReplayProjection(fresh(), "owner", () => {
    throw new TypeError("local conversion");
  });
  expect(history.push({})).toBe("consumed");
  history.mark("owner");
  const error = failure(() => history.requireReadable("agent", result, true));
  expect(error).toMatchObject({ message: STRINGS.thread.connectionLost });
  expect(isHistoryReadFailure(error)).toBe(false);
});

it("does not reinterpret arbitrary local errors as an Agent-reported history classification", () => {
  const original = new Error("original local reducer failure");
  const history = new HistoryReplayProjection(fresh(), "owner", () => {
    throw original;
  });
  history.push({});
  history.mark("owner");
  expect(failure(() => history.requireReadable("agent", result, false))).toBe(
    original,
  );
  expect(isHistoryReadFailure(original)).toBe(false);
});

it("rejects an obsolete owner before receipt, marker, validation, and transfer", () => {
  let current = true;
  const state = fresh();
  const history = new HistoryReplayProjection(
    state,
    "owner",
    apply,
    () => current,
  );
  history.push(message("owned"));
  current = false;
  expect(history.push(message("obsolete"))).toBe("discarded");
  expect(history.mark("owner")).toBe(false);
  expect(() => history.requireReadable("agent", result, false)).toThrow(
    STRINGS.repair.reconnectFailed,
  );
  expect(() => history.take()).toThrow(STRINGS.repair.reconnectFailed);
  expect(state.items).toHaveLength(1);
  history.clear();
  current = true;
  expect(history.push(message("cannot reopen"))).toBe("discarded");
  expect(history.mark("owner")).toBe(false);
});

it("allows metadata merge on the same private owner and releases it exactly once", () => {
  const state = fresh();
  const history = new HistoryReplayProjection(state, "owner", apply);
  history.push(message("body"));
  history.mark("owner");
  expect(history.state).toBe(state);
  history.state!.connectionId = "actual-returned-connection";
  history.state!.cwd = "/canonical";
  history.requireReadable("agent", { ...result, cwd: "/canonical" }, false);
  expect(history.take()).toBe(state);
  expect(state.connectionId).toBe("actual-returned-connection");
  expect(() => history.take()).toThrow(STRINGS.repair.reconnectFailed);
});

it("keeps the real delivery flow draining through a failed projection to its marker and fork result", async () => {
  const state = fresh();
  const history = new HistoryReplayProjection(state, "owner", apply);
  const malformed = {
    update: {
      sessionUpdate: "tool_call",
      toolCallId: JSON.parse('{"toString":null,"valueOf":null}'),
    },
  };
  const events = [
    message("readable first"),
    malformed,
    { kind: "session_history_complete", openToken: "owner" },
    { kind: "forkResult", stage: "finished" },
  ];
  let sequence = 0;
  const receipts: unknown[] = [];
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_delivery_pull") {
      const event = events.shift();
      return event === undefined
        ? null
        : { sequence: String(++sequence), event };
    }
    if (command === "session_delivery_ack") {
      receipts.push(args.receipt);
      return true;
    }
    return true;
  });
  let finished = 0;
  const flow = new SessionDeliveryFlow("agent", "owner");
  flow.receive(
    { farfoldDeliveryWake: { openToken: "owner", queueId: "a".repeat(32) } },
    (event) => {
      const value = event as { kind?: string; openToken?: string };
      if (value.kind === "session_history_complete") {
        expect(history.mark(value.openToken!)).toBe(true);
        return "consumed";
      }
      if (value.kind === "forkResult") {
        finished++;
        return "consumed";
      }
      return history.push(event);
    },
  );
  await vi.waitFor(() => expect(receipts).toHaveLength(4));
  expect(finished).toBe(1);
  expect(history.complete).toBe(true);
  expect(
    state.items.some(
      (item) => item.kind === "raw" && item.update === malformed,
    ),
  ).toBe(true);
  expect(receipts).toEqual(
    [1, 2, 3, 4].map((number) => ({
      sequence: String(number),
      outcome: "consumed",
    })),
  );
  expect(() => history.requireReadable("agent", result, false)).toThrow(
    TypeError,
  );
  expect(
    h.invoke.mock.calls.some(
      ([command]) => command === "session_delivery_retire",
    ),
  ).toBe(false);
  flow.dispose();
});
