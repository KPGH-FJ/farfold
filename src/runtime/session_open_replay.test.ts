import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RawBlock } from "../components/thread-items";
import { TranscriptSearchContext } from "../components/transcript-search";

const renderSearchableRaw = (update: unknown) =>
  renderToStaticMarkup(
    createElement(
      TranscriptSearchContext.Provider,
      { value: true },
      createElement(RawBlock, { update }),
    ),
  );

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));
import { threads } from "./sessions";
import { HistoryReplayBuffer } from "./history_replay";
import { STRINGS } from "./strings";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  h.invoke.mockReset();
});

const message = (id: string, text: string) => ({
  update: {
    sessionUpdate: "agent_message_chunk",
    messageId: id,
    content: { type: "text", text },
  },
});

it.each([false, true])(
  "shares the exact opening promise and retains replay/live/unknown order (response first=%s)",
  async (responseFirst) => {
    const native = `extracted-replay-${responseFirst}`;
    let deliver!: (event: unknown) => void;
    let finish!: () => void;
    let marker!: unknown;
    h.invoke.mockImplementation((command, args) => {
      if (command !== "session_open") return Promise.resolve([]);
      deliver = args.channel.onmessage;
      marker = {
        kind: "session_history_complete",
        openToken: args.openToken,
      };
      return new Promise((resolve) => {
        finish = () =>
          resolve({ cwd: "/replay", nativeSessionId: native, resumed: true });
      });
    });
    const input = {
      agentId: "extracted-replay",
      cwd: "/replay",
      nativeSessionId: native,
    };
    threads.markOpenFailed(
      `${input.agentId}:${input.cwd}:${native}`,
      input.agentId,
      input.cwd,
      native,
      "retry",
    );
    const first = threads.open(input);
    const second = threads.open(input);
    expect(second).toBe(first);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    const unknown = {
      sessionUpdate: "future_replay_control",
      value: { ordered: [null, "原值🙂", 7] },
    };
    if (responseFirst) {
      finish();
      await Promise.resolve();
    }
    deliver(message("old", "Historical body"));
    deliver({ update: unknown });
    deliver(marker);
    deliver(message("live", "Live following body"));
    deliver(marker);
    if (!responseFirst) finish();
    const state = await first;
    expect(await second).toBe(state);
    expect(
      state.items.flatMap((item) => (item.kind === "agent" ? [item.text] : [])),
    ).toEqual(["Historical body", "Live following body"]);
    const retained = state.items.find((item) => item.kind === "raw");
    expect(retained?.kind === "raw" && retained.update).toBe(unknown);
  },
);

it("keeps the 30 second marker deadline and rejects late replay after timeout", async () => {
  vi.useFakeTimers();
  let deliver!: (event: unknown) => void;
  let marker!: unknown;
  h.invoke.mockImplementation(async (command, args) => {
    if (command !== "session_open") return [];
    deliver = args.channel.onmessage;
    marker = {
      kind: "session_history_complete",
      openToken: args.openToken,
    };
    deliver(message("unconfirmed", "Unconfirmed replay"));
    return { cwd: "/replay", nativeSessionId: "marker-timeout", resumed: true };
  });
  threads.markOpenFailed(
    "extracted-replay:/replay:marker-timeout",
    "extracted-replay",
    "/replay",
    "marker-timeout",
    "retry",
  );
  const first = threads.open({
    agentId: "extracted-replay",
    cwd: "/replay",
    nativeSessionId: "marker-timeout",
  });
  let settled = false;
  const rejected = first.then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await vi.advanceTimersByTimeAsync(29_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await rejected).toMatchObject({
    message: STRINGS.repair.historyUnavailable,
  });
  const state = threads.thread("extracted-replay:/replay:marker-timeout");
  expect(state?.historyUnavailable?.reason).toBe("incomplete");
  expect(state?.items).toEqual([]);
  deliver(marker);
  deliver(message("late", "Cannot repair a failed replay"));
  expect(state?.items).toEqual([]);
  deliver({ kind: "connectionLost", closeReason: "unexpected" });
  expect(state?.connectionCloseReason).toBe("unexpected");
});

// Controlled transport only; ThreadsStore/open/replay/projection/render are real.
function wireReplay(native: string) {
  let deliver!: (event: unknown) => void;
  let finish!: () => void;
  let marker!: { kind: string; openToken: string };
  h.invoke.mockImplementation((command, args) => {
    if (command !== "session_open") return Promise.resolve([]);
    deliver = args.channel.onmessage;
    marker = { kind: "session_history_complete", openToken: args.openToken };
    return new Promise((resolve) => {
      finish = () =>
        resolve({ cwd: "/replay", nativeSessionId: native, resumed: true });
    });
  });
  const input = {
    agentId: "wire-raw-fidelity",
    cwd: "/replay",
    nativeSessionId: native,
  };
  threads.markOpenFailed(
    `${input.agentId}:${input.cwd}:${native}`,
    input.agentId,
    input.cwd,
    native,
    "fixture",
  );
  const promise = threads.open(input);
  return {
    promise,
    deliver: (e: unknown) => deliver(e),
    finish: () => finish(),
    marker: () => marker,
  };
}

it.each([false, true])(
  "preserves same-kind raw replay and bound live values (response first=%s)",
  async (responseFirst) => {
    const w = wireReplay(`same-kind-fidelity-${responseFirst}`);
    const unknown = {
      sessionUpdate: "future_wire_update",
      value: [null, "RAW_REPLAY_OWNED_VISIBLE", { exact: true }],
    };
    if (responseFirst) {
      w.finish();
      await Promise.resolve();
    }
    w.deliver({
      sessionId: `same-kind-fidelity-${responseFirst}`,
      kind: "session_history_complete",
      openToken: "foreign-owner",
      update: unknown,
    });
    w.deliver({
      sessionId: `same-kind-fidelity-${responseFirst}`,
      kind: "session_history_complete",
      update: message("missing-token", "Missing-token body survives").update,
    });
    w.deliver({
      sessionId: `same-kind-fidelity-${responseFirst}`,
      ...w.marker(),
      update: message("same-token-data", "Same-token data is not a marker")
        .update,
    });
    w.deliver(w.marker());
    if (!responseFirst) w.finish();
    const s = await w.promise;
    const raw = s.items.find((item) => item.kind === "raw");
    expect(raw?.kind === "raw" && raw.update).toBe(unknown);
    expect(
      s.items
        .filter((item) => item.kind === "agent")
        .map((item) => item.text)
        .join("|"),
    ).toContain("Missing-token body survives");
    expect(
      s.items
        .filter((item) => item.kind === "agent")
        .map((item) => item.text)
        .join("|"),
    ).toContain("Same-token data is not a marker");
    expect(
      renderSearchableRaw(raw?.kind === "raw" ? raw.update : undefined),
    ).toContain("RAW_REPLAY_OWNED_VISIBLE");
    const live = { sessionUpdate: "future_live_wire", exact: [7, null, false] };
    w.deliver({ sessionId: s.nativeSessionId, ...w.marker(), update: live });
    expect(
      s.items.some((item) => item.kind === "raw" && item.update === live),
    ).toBe(true);
    await threads.close(s.key);
  },
);

it.each([
  "turnEnd",
  "connectionLost",
  "permissionState",
  "configOptions",
  "toolActivity",
  "elicitation",
])(
  "prioritizes own update over internal %s without state mutation",
  async (kind) => {
    const w = wireReplay(`control-collision-${kind}`);
    w.deliver(message("history", "Readable owned history"));
    w.deliver(w.marker());
    w.finish();
    const s = await w.promise;
    const before = structuredClone({
      connectionLost: s.connectionLost,
      running: s.running,
      permissionState: s.permissionState,
      permissionConfigId: s.permissionConfigId,
      queuePaused: s.queuePaused,
      configOptions: s.configOptions,
      activeToolCallIds: s.activeToolCallIds,
      pendingElicitations: s.pendingElicitations,
    });
    const raw = {
      sessionUpdate: "future_topkind_collision",
      kind,
      nested: [null, "RAW_CONTROL_OWNED_VISIBLE"],
    };
    w.deliver({
      sessionId: s.nativeSessionId,
      update: raw,
      kind,
      permissionConfigId: "not-local-authority",
      permissionState: "unknown",
      options: [],
      toolCallIds: ["not-local-work"],
      closeReason: "unexpected",
      requestId: "not-local-question",
    });
    expect(
      s.items.some((item) => item.kind === "raw" && item.update === raw),
    ).toBe(true);
    expect({
      connectionLost: s.connectionLost,
      running: s.running,
      permissionState: s.permissionState,
      permissionConfigId: s.permissionConfigId,
      queuePaused: s.queuePaused,
      configOptions: s.configOptions,
      activeToolCallIds: s.activeToolCallIds,
      pendingElicitations: s.pendingElicitations,
    }).toEqual(before);
    await threads.close(s.key);
  },
);

it.each([null, {}, ["future", null]])(
  "keeps own partial/null update as raw despite top kind",
  async (payload) => {
    const w = wireReplay(`partial-update-${JSON.stringify(payload)}`);
    w.deliver(message("history", "Readable history"));
    w.deliver(w.marker());
    w.finish();
    const s = await w.promise;
    w.deliver({ kind: "turnEnd", update: payload });
    expect(
      s.items.some((item) => item.kind === "raw" && item.update === payload),
    ).toBe(true);
    await threads.close(s.key);
  },
);

it("old owner markers and callbacks cannot finish or mutate a reopened current channel", async () => {
  vi.useFakeTimers();
  const old = wireReplay("reopen-same-key");
  old.deliver(message("old", "Old owner"));
  old.deliver(old.marker());
  old.finish();
  const a = await old.promise;
  await threads.close(a.key);
  const current = wireReplay("reopen-same-key");
  current.deliver(message("current", "Current owner"));
  current.finish();
  let settled = false;
  void current.promise.then(() => {
    settled = true;
  });
  current.deliver(old.marker());
  current.deliver({ kind: "session_history_complete" });
  current.deliver({
    ...current.marker(),
    update: { sessionUpdate: "future_same_token_raw", value: null },
  });
  // Even the new marker sent through the retired channel belongs to that old callback.
  old.deliver(current.marker());
  old.deliver(message("late-old", "Retired content"));
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(false);
  current.deliver(current.marker());
  const b = await current.promise;
  expect(
    b.items.some(
      (item) => item.kind === "agent" && item.text === "Current owner",
    ),
  ).toBe(true);
  expect(
    b.items.some(
      (item) => item.kind === "agent" && item.text === "Retired content",
    ),
  ).toBe(false);
  expect(
    b.items.some(
      (item) =>
        item.kind === "raw" &&
        (item.update as { sessionUpdate?: string } | null)?.sessionUpdate ===
          "future_same_token_raw",
    ),
  ).toBe(true);
  await threads.close(b.key);
});

it.each([false, true])(
  "same-kind raw loss during replay cannot end marker wait (response first=%s)",
  async (responseFirst) => {
    vi.useFakeTimers();
    const w = wireReplay(`replay-loss-collision-${responseFirst}`);
    const raw = {
      sessionUpdate: "future_replay_loss",
      value: [null, "RAW_REPLAY_LOSS_VISIBLE"],
    };
    let settled = false;
    // Observe rejection before timer progression: setup errors cannot become unhandled RED.
    const terminal = w.promise.then(
      (state) => {
        settled = true;
        return { state };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    if (responseFirst) w.finish();
    w.deliver({
      kind: "connectionLost",
      update: raw,
      closeReason: "unexpected",
    });
    if (!responseFirst) w.finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    w.deliver(message("owned-after-loss", "Owned history remains readable"));
    w.deliver(w.marker());
    const result = await terminal;
    expect("state" in result).toBe(true);
    if (!("state" in result)) throw result.error;
    const s = result.state;
    expect(s.connectionLost).toBe(false);
    expect(
      s.items.some((item) => item.kind === "raw" && item.update === raw),
    ).toBe(true);
    expect(
      s.items.some(
        (item) =>
          item.kind === "agent" &&
          item.text === "Owned history remains readable",
      ),
    ).toBe(true);
    await threads.close(s.key);
  },
);

it("timed-out replay rejects late raw loss but accepts genuine local loss", async () => {
  vi.useFakeTimers();
  const w = wireReplay("failed-raw-loss-collision");
  const terminal = w.promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  w.finish();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await terminal).toMatchObject({
    message: STRINGS.repair.historyUnavailable,
  });
  const s = threads.thread(
    "wire-raw-fidelity:/replay:failed-raw-loss-collision",
  )!;
  expect(s.items).toEqual([]);
  const before = structuredClone({
    lost: s.connectionLost,
    reason: s.connectionCloseReason,
    history: s.historyUnavailable,
  });
  w.deliver({
    kind: "connectionLost",
    update: { sessionUpdate: "future_late_loss", body: "RETIRED_RAW" },
  });
  expect(s.items).toEqual([]);
  expect({
    lost: s.connectionLost,
    reason: s.connectionCloseReason,
    history: s.historyUnavailable,
  }).toEqual(before);
  w.deliver({ kind: "connectionLost", closeReason: "unexpected" });
  expect(s.connectionCloseReason).toBe("unexpected");
  await threads.close(s.key);
});

it("same owner token with opaque extra fields is raw and cannot acknowledge history", async () => {
  vi.useFakeTimers();
  const w = wireReplay("extra-marker-fields");
  let settled = false;
  void w.promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  w.deliver(message("owned", "Owned replay body"));
  const raw = { ...w.marker(), future: [null, "OPAQUE_MARKER_EXTRA"] };
  w.deliver(raw);
  w.finish();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(false);
  w.deliver(w.marker());
  const s = await w.promise;
  expect(
    s.items.some((item) => item.kind === "raw" && item.update === raw),
  ).toBe(true);
  expect(renderSearchableRaw(raw)).toContain("OPAQUE_MARKER_EXTRA");
  await threads.close(s.key);
});

it("rejects a non-coercible JSON tool field before replacing prior readable history", async () => {
  const native = "noncoercible-history-owner";
  const key = `wire-raw-fidelity:/replay:${native}`;
  const w = wireReplay(native);
  const prior = threads.thread(key)!;
  const priorItem = {
    kind: "agent" as const,
    id: "owned-prior",
    text: "OWNED_PRIOR_BODY",
    streaming: false,
    time: 0,
  };
  prior.items.push(priorItem);
  const rejected = expect(w.promise).rejects.toThrow();
  // These are ordinary JSON fields, not a hostile getter/function fixture.
  const malformed = JSON.parse('{"toString":null,"valueOf":null}');
  w.deliver({ update: { sessionUpdate: "tool_call", toolCallId: malformed } });
  w.deliver(message("readable-after-malformed", "OWNED_NEW_BODY"));
  w.deliver(w.marker());
  w.finish();
  try {
    await rejected;
    expect(threads.thread(key)).toBe(prior);
    expect(prior.items).toEqual([priorItem]);
    expect(prior.items[0]).toBe(priorItem);
    expect(prior.openError).toBeTruthy();
  } finally {
    await threads.close(key);
  }
});

it.each([false, true])(
  "borrows the acknowledged precheck prefix without calling the copying prefix API (response first=%s)",
  async (responseFirst) => {
    const copying = vi.spyOn(HistoryReplayBuffer.prototype, "prefix");
    const w = wireReplay(`borrowed-prefix-${responseFirst}`);
    const unknown = {
      sessionUpdate: "owned_borrow_future",
      exact: [null, "OWNED_PREFIX_RAW", false],
    };
    if (responseFirst) {
      w.finish();
      await Promise.resolve();
    }
    w.deliver(message("old", "OWNED_PREFIX_BODY"));
    w.deliver({ update: unknown });
    w.deliver(w.marker());
    w.deliver(message("live", "OWNED_FOLLOWING_BODY"));
    w.deliver(w.marker());
    if (!responseFirst) w.finish();
    const state = await w.promise;
    const copies = copying.mock.calls.length;
    try {
      expect(
        state.items.filter((i) => i.kind === "agent").map((i) => i.text),
      ).toEqual(["OWNED_PREFIX_BODY", "OWNED_FOLLOWING_BODY"]);
      expect(
        state.items.some((i) => i.kind === "raw" && i.update === unknown),
      ).toBe(true);
      expect(state.items.find((i) => i.kind === "agent")).toMatchObject({
        time: 0,
        streaming: false,
      });
    } finally {
      await threads.close(state.key);
    }
    // This observes only one avoidable array-copy API, not all allocations/RSS.
    expect(copies).toBe(0);
  },
);
