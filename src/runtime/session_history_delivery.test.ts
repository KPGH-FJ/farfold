import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { historyReads } from "./session_history_admission";
import { threads, type IndexRow } from "./sessions";

type Port = { onmessage(value: unknown): void };
const opened: string[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function progress(channel: Port, token: string, receiptId: number) {
  channel.onmessage({
    kind: "session_history_admission",
    openToken: token,
    phase: "starting",
    historyDelivery: { receiptId, openToken: token },
  });
}
function reply(args: { receiptId: number; openToken: string }) {
  return {
    receiptId: args.receiptId,
    openToken: args.openToken,
    outcome: "acknowledged",
  };
}
const acks = () =>
  h.invoke.mock.calls.filter(
    ([name]) => name === "session_history_delivery_ack",
  );
afterEach(async () => {
  for (const key of opened.splice(0)) await threads.close(key);
  h.invoke.mockReset();
});

it("real open keeps original index-held replay and only acknowledges after install, without acknowledging raw control collisions", async () => {
  const index = deferred<IndexRow[]>();
  const staged = deferred<void>();
  let wire!: { channel: Port; admissionChannel: Port; openToken: string };
  const raw = {
    sessionUpdate: "owned_opaque",
    exact: [null, "🙂", { keep: true }],
  };
  h.invoke.mockImplementation((command, args) => {
    if (command === "session_open") {
      wire = args;
      progress(args.admissionChannel, args.openToken, 101);
      args.channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "original body" },
        },
      });
      args.channel.onmessage({
        kind: "session_history_admission",
        openToken: args.openToken,
        phase: "notStarted",
        historyDelivery: { receiptId: 999, openToken: args.openToken },
        update: raw,
      });
      args.channel.onmessage({
        kind: "session_history_complete",
        openToken: args.openToken,
      });
      args.channel.onmessage({
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "live-tool",
          title: "Public tool",
          status: "in_progress",
        },
      });
      args.channel.onmessage({
        kind: "toolActivity",
        toolCallIds: ["live-tool"],
      });
      return Promise.resolve({
        cwd: "/delivery",
        nativeSessionId: "index-held",
        connectionId: "held-owner",
        configOptions: [],
        warnings: [],
        resumed: true,
      });
    }
    if (command === "session_index_list") {
      staged.resolve();
      return index.promise;
    }
    if (command === "session_history_delivery_ack")
      return Promise.resolve(reply(args));
    return Promise.resolve(command === "settings_get" ? null : []);
  });
  const loading = threads.open({
    agentId: "owned-delivery",
    cwd: "/delivery",
    nativeSessionId: "index-held",
  });
  try {
    await staged.promise;
    expect(acks()).toHaveLength(0);
    expect(
      historyReads.getSnapshot().some((v) => v.token === wire.openToken),
    ).toBe(true);
    index.resolve([]);
    const state = await loading;
    opened.push(state.key);
    await vi.waitFor(() => expect(acks()).toHaveLength(1));
    expect(acks()[0][1]).toEqual({
      agentId: "owned-delivery",
      receiptId: 101,
      openToken: wire.openToken,
    });
    expect(state.items.some((v) => v.kind === "raw" && v.update === raw)).toBe(
      true,
    );
    expect(state.activeToolCallIds).toEqual(["live-tool"]);
    wire.channel.onmessage({ kind: "toolActivity", toolCallIds: [] });
  } finally {
    index.resolve([]);
    await loading.catch(() => undefined);
  }
});

it("failed ACK remains visible and an explicit retry uses the identical receipt without another read or clearing native work", async () => {
  const token = "retry-original";
  const owner = historyReads.begin(
    "retry",
    { agentId: "owned", cwd: "/delivery", nativeSessionId: "original" },
    token,
  )!;
  owner.dispatch();
  progress(owner.channel, token, 102);
  h.invoke.mockRejectedValueOnce(new Error("controlled IPC failure"));
  historyReads.finish("retry", owner);
  await vi.waitFor(() =>
    expect(
      historyReads.getSnapshot().find((v) => v.token === token)?.releaseRetry,
    ).toBe(true),
  );
  progress(owner.channel, token, 102);
  await Promise.resolve();
  expect(acks()).toHaveLength(1); // repeated progress is never a background retry
  h.invoke.mockImplementation((_command, args) => Promise.resolve(reply(args)));
  await historyReads.retryRelease(token);
  expect(acks()).toHaveLength(2);
  expect(acks()[0][1]).toEqual(acks()[1][1]);
  expect(
    h.invoke.mock.calls.every(
      ([name]) => name === "session_history_delivery_ack",
    ),
  ).toBe(true);
  expect(historyReads.getSnapshot().some((v) => v.token === token)).toBe(false);
});

it("local retirement before a late private receipt does not discard its owner or acknowledge a foreign token", async () => {
  const token = "late-original";
  const owner = historyReads.begin(
    "late",
    { agentId: "owned", cwd: "/delivery", nativeSessionId: "original" },
    token,
  )!;
  owner.dispatch();
  historyReads.finish("late", owner);
  expect(
    historyReads.getSnapshot().find((v) => v.token === token)?.notice,
  ).toBeTruthy();
  progress(owner.channel, "foreign", 103);
  expect(acks()).toHaveLength(0);
  h.invoke.mockImplementation((_command, args) => Promise.resolve(reply(args)));
  progress(owner.channel, token, 103);
  await vi.waitFor(() => expect(acks()).toHaveLength(1));
  await vi.waitFor(() =>
    expect(historyReads.getSnapshot().some((v) => v.token === token)).toBe(
      false,
    ),
  );
  progress(owner.channel, token, 104);
  expect(acks()).toHaveLength(1);
});

it("a malformed ACK result preserves exact receipt for retry, and a replacement operation never overwrites it", async () => {
  const old = historyReads.begin(
    "same-key",
    { agentId: "owned", cwd: "/delivery", nativeSessionId: "original" },
    "old-delivery",
  )!;
  old.dispatch();
  progress(old.channel, "old-delivery", 105);
  h.invoke.mockResolvedValueOnce({
    receiptId: 105,
    openToken: "other",
    outcome: "acknowledged",
  });
  historyReads.finish("same-key", old);
  await vi.waitFor(() =>
    expect(
      historyReads.getSnapshot().find((v) => v.token === "old-delivery")
        ?.releaseRetry,
    ).toBe(true),
  );
  const next = historyReads.begin(
    "same-key",
    { agentId: "owned", cwd: "/delivery", nativeSessionId: "original" },
    "new-delivery",
  )!;
  next.dispatch();
  progress(next.channel, "new-delivery", 106);
  h.invoke.mockImplementation((_command, args) => Promise.resolve(reply(args)));
  await historyReads.retryRelease("old-delivery");
  expect(
    historyReads.getSnapshot().some((v) => v.token === "new-delivery"),
  ).toBe(true);
  historyReads.finish("same-key", next);
  await vi.waitFor(() =>
    expect(
      historyReads.getSnapshot().some((v) => v.token === "new-delivery"),
    ).toBe(false),
  );
});

it("a real exact waiting-cancel reply may retire its original observer after the load rejection already settled", async () => {
  const token = "cancel-before-reply";
  const owner = historyReads.begin(
    "cancelled",
    { agentId: "owned", cwd: "/delivery", nativeSessionId: "original" },
    token,
  )!;
  const cancellation = deferred<unknown>();
  owner.dispatch();
  owner.channel.onmessage({
    kind: "session_history_admission",
    openToken: token,
    phase: "waiting",
  });
  h.invoke.mockReturnValue(cancellation.promise);
  const requested = historyReads.cancel(token);
  historyReads.finish("cancelled", owner);
  expect(historyReads.getSnapshot().some((v) => v.token === token)).toBe(true);
  cancellation.resolve({ openToken: token, outcome: "cancelledWaiting" });
  await requested;
  expect(historyReads.getSnapshot().some((v) => v.token === token)).toBe(false);
  expect(acks()).toHaveLength(0);
});

it("private notStarted qualifies only empty unarmed staging and cannot consume unowned raw or a different token", async () => {
  const empty = historyReads.begin(
    "empty-preflight",
    { agentId: "owned", cwd: "/delivery", nativeSessionId: "empty" },
    "empty-preflight",
  )!;
  empty.dispatch();
  empty.channel.onmessage({
    kind: "session_history_admission",
    openToken: "empty-preflight",
    phase: "notStarted",
  });
  historyReads.finish("empty-preflight", empty);
  expect(historyReads.getSnapshot().some((v) => v.token === empty.token)).toBe(
    false,
  );
  expect(acks()).toHaveLength(0);
  const raw = historyReads.begin(
    "unowned-raw",
    { agentId: "owned", cwd: "/delivery", nativeSessionId: "raw" },
    "unowned-raw",
  )!;
  raw.dispatch();
  raw.observeRaw();
  raw.channel.onmessage({
    kind: "session_history_admission",
    openToken: "foreign",
    phase: "notStarted",
  });
  historyReads.finish("unowned-raw", raw);
  raw.channel.onmessage({
    kind: "session_history_admission",
    openToken: raw.token,
    phase: "notStarted",
  });
  expect(
    historyReads.getSnapshot().find((v) => v.token === raw.token)?.notice,
  ).toBeTruthy();
  expect(acks()).toHaveLength(0);
  // Only the later exact native receipt permits acknowledgement of the
  // already-retired local buffer, never reinterpretation as successful work.
  h.invoke.mockImplementation((_command, args) => Promise.resolve(reply(args)));
  progress(raw.channel, raw.token, 107);
  await vi.waitFor(() =>
    expect(historyReads.getSnapshot().some((v) => v.token === raw.token)).toBe(
      false,
    ),
  );
});
