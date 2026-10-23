import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emitOpeningHeader } from "./session_open_test_fixture";

const h = vi.hoisted(() => ({
  channels: [] as { onmessage: (event: unknown) => void }[],
  frames: [] as FrameRequestCallback[],
  denied: 0,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "session_open") {
      const channel = args.channel as { onmessage: (event: unknown) => void };
      h.channels.push(channel);
      const result = {
        cwd: args.cwd as string,
        nativeSessionId: args.nativeSessionId as string,
        connectionId: `notification-connection-${h.channels.length}`,
        resumed: true,
        configOptions: [],
      };
      emitOpeningHeader(
        { channel, openToken: args.openToken as string },
        result,
      );
      channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "owned-history",
          content: { type: "text", text: "Owned history" },
        },
      });
      channel.onmessage({
        kind: "session_history_complete",
        openToken: args.openToken,
      });
      return result;
    }
    if (command === "settings_get" && args.key === "autoArchiveDays")
      return null;
    if (
      command === "session_close" ||
      command === "session_touch" ||
      command === "session_index_list"
    )
      return [];
    h.denied++;
    throw new Error("Unexpected external command in notification fixture");
  }),
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));

import { threads } from "./sessions";

let sequence = 0;
const keys = new Set<string>();
const subscriptions: (() => void)[] = [];
const store = threads as unknown as {
  notifications: {
    versions: Map<string, number>;
    pending: Set<string>;
  };
  applyChannelEvent(key: string, event: unknown, live: boolean): void;
};
function state(key = `notification-lifetime-${++sequence}`) {
  keys.add(key);
  const result = threads.markOpenFailed(
    key,
    "notification-lifetime-fixture",
    "/owned-public-fixture",
    "history",
    "fixture",
  );
  result.openError = null;
  return result;
}
function chunk(key: string, text = "Owned text") {
  store.applyChannelEvent(
    key,
    {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
    false,
  );
}
function subscribe(key: string, callback: () => void) {
  const stop = threads.subscribeThread(key, callback);
  subscriptions.push(stop);
  return stop;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.frames = [];
  h.channels = [];
  h.denied = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    h.frames.push(callback);
    return h.frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(async () => {
  for (const stop of subscriptions.splice(0)) stop();
  for (const key of keys) await threads.close(key);
  keys.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(h.denied).toBe(0);
});

it.each([8, 64])(
  "releases display-key retention after %s actual store conversations close",
  async (count) => {
    const closed = [];
    for (let i = 0; i < count; i++) {
      const current = state();
      const unknown = { sessionUpdate: "_owned_future", exact: [i, true] };
      store.applyChannelEvent(current.key, { update: unknown }, false);
      chunk(current.key);
      expect(current.items.some((item) => item.kind === "agent")).toBe(true);
      expect(
        current.items.some(
          (item) => item.kind === "raw" && item.update === unknown,
        ),
      ).toBe(true);
      await threads.close(current.key);
      expect(threads.thread(current.key)).toBeUndefined();
      closed.push(current.key);
    }
    const retainedDisplayKeys = closed.filter((key) =>
      store.notifications.versions.has(key),
    ).length;
    console.info(
      JSON.stringify({
        kind: "OwnedNotificationLifetimeCounts",
        actualStoreCloseCycles: count,
        statesRemaining: closed.filter((key) => threads.thread(key)).length,
        pendingKeys: closed.filter((key) =>
          store.notifications.pending.has(key),
        ).length,
        retainedDisplayKeys,
      }),
    );
    expect(retainedDisplayKeys).toBe(0);
  },
);

it("detects a store update between render snapshot and subscription", async () => {
  const current = state();
  const renderedVersion = threads.threadVersion(current.key);
  chunk(current.key);
  await vi.advanceTimersByTimeAsync(32);
  const notify = vi.fn();
  subscribe(current.key, notify);
  expect(threads.threadVersion(current.key)).not.toBe(renderedVersion);
  expect(current.items).toEqual([
    expect.objectContaining({ kind: "agent", text: "Owned text" }),
  ]);
  expect(notify).not.toHaveBeenCalled();
});

it("detects an immediate store change before the first subscription", () => {
  const current = state();
  const renderedVersion = threads.threadVersion(current.key);
  threads.markOpenFailed(
    current.key,
    current.agentId,
    current.cwd,
    current.nativeSessionId,
    "Owned open failure",
  );
  subscribe(current.key, vi.fn());
  expect(threads.threadVersion(current.key)).not.toBe(renderedVersion);
  expect(threads.thread(current.key)?.openError).toBe("Owned open failure");
});

it("keeps a subscribed snapshot stable across another conversation's chunks", async () => {
  const first = state();
  const other = state();
  const notify = vi.fn();
  subscribe(first.key, notify);
  const snapshot = threads.threadVersion(first.key);
  chunk(other.key);
  await vi.advanceTimersByTimeAsync(32);
  expect(threads.threadVersion(first.key)).toBe(snapshot);
  expect(notify).not.toHaveBeenCalled();
});

it("publishes a closed state while subscribed, then releases its display key", async () => {
  const current = state();
  const other = state();
  const seen: unknown[] = [];
  const stop = subscribe(current.key, () =>
    seen.push(threads.thread(current.key)),
  );
  const before = threads.threadVersion(current.key);
  await threads.close(current.key);
  expect(seen).toEqual([undefined]);
  const closedSnapshot = threads.threadVersion(current.key);
  expect(closedSnapshot).not.toBe(before);
  chunk(other.key);
  await vi.advanceTimersByTimeAsync(32);
  expect(threads.threadVersion(current.key)).toBe(closedSnapshot);
  stop();
  expect(store.notifications.versions.has(current.key)).toBe(false);
});

it("does not remove a second registration of the same callback", async () => {
  const current = state();
  const notify = vi.fn();
  const first = subscribe(current.key, notify);
  const second = subscribe(current.key, notify);
  first();
  first();
  chunk(current.key);
  await vi.advanceTimersByTimeAsync(32);
  expect(notify).toHaveBeenCalledOnce();
  second();
  chunk(current.key, "Still retained as input");
  await vi.advanceTimersByTimeAsync(32);
  expect(notify).toHaveBeenCalledOnce();
});

it("an old duplicate cleanup cannot remove a newly subscribed owner", async () => {
  const current = state();
  const notify = vi.fn();
  const old = subscribe(current.key, notify);
  old();
  subscribe(current.key, notify);
  old();
  chunk(current.key);
  await vi.advanceTimersByTimeAsync(32);
  expect(notify).toHaveBeenCalledOnce();
});

it("releases different subscribers independently", async () => {
  const current = state();
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = subscribe(current.key, first);
  const stopSecond = subscribe(current.key, second);
  stopFirst();
  chunk(current.key);
  await vi.advanceTimersByTimeAsync(32);
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
  stopSecond();
  expect(store.notifications.versions.has(current.key)).toBe(false);
});

it("defers subscribers added by a notification until the next store update", async () => {
  const current = state();
  const added = vi.fn();
  subscribe(current.key, () => subscribe(current.key, () => added()));
  chunk(current.key);
  await vi.advanceTimersByTimeAsync(32);
  expect(added).not.toHaveBeenCalled();
  chunk(current.key, "Next update");
  await vi.advanceTimersByTimeAsync(32);
  expect(added).toHaveBeenCalledOnce();
});

it("a late old frame preserves the reopened key's current update", async () => {
  const old = state();
  chunk(old.key, "Old text");
  const oldFrame = h.frames[0];
  await threads.close(old.key);
  const reopened = state(old.key);
  const notify = vi.fn();
  subscribe(reopened.key, notify);
  chunk(reopened.key, "Current text");
  oldFrame(0);
  await vi.advanceTimersByTimeAsync(64);
  expect(threads.thread(old.key)).toBe(reopened);
  expect(reopened.items).toEqual([
    expect.objectContaining({ kind: "agent", text: "Current text" }),
  ]);
  expect(notify).toHaveBeenCalledOnce();
  expect(store.notifications.pending.has(reopened.key)).toBe(false);
});

it("a closed channel cannot update a reopened store key or its display snapshot", async () => {
  const input = {
    agentId: "notification-lifetime-fixture",
    cwd: "/owned-public-fixture",
    nativeSessionId: "reused-channel",
  };
  const old = await threads.open(input);
  keys.add(old.key);
  const oldChannel = h.channels[0];
  await threads.close(old.key);
  const reopened = await threads.open(input);
  const notify = vi.fn();
  subscribe(reopened.key, notify);
  const snapshot = threads.threadVersion(reopened.key);
  const items = [...reopened.items];
  oldChannel.onmessage({ update: { sessionUpdate: "_owned_old_channel" } });
  await vi.advanceTimersByTimeAsync(64);
  expect(threads.thread(old.key)).toBe(reopened);
  expect(reopened.items).toEqual(items);
  expect(threads.threadVersion(reopened.key)).toBe(snapshot);
  expect(notify).not.toHaveBeenCalled();
});
