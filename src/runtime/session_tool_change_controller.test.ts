import { afterEach, expect, it, vi } from "vitest";
import {
  changeFixture,
  changeInput,
  changed,
  changeOperation,
  managedItem,
  inspected,
} from "./session_tool_change.test-support";
import { deferred, flush } from "./session_tools.test-support";
import { composerDrafts } from "./drafts";

afterEach(() => {
  vi.useRealTimers();
  composerDrafts.clear("session:owned");
});

it("claims the existing gate, dispatches the exact reviewed URL once, and releases only confirmed persistence plus activity", async () => {
  const h = changeFixture();
  composerDrafts.update("session:owned", () => ({
    text: "keep this draft",
    attachments: [],
  }));
  const before = {
    queued: h.owner.queued,
    paused: h.owner.queuePaused,
    draft: composerDrafts.read("session:owned"),
  };
  expect(h.controller.start(changeInput)).toBe(true);
  expect(h.owner.configuring).toBe(true);
  expect(h.controller.start(changeInput)).toBe(false);
  await flush();
  expect(h.port.start).toHaveBeenCalledExactlyOnceWith(
    h.request(),
    changeInput,
  );
  expect(JSON.stringify(h.controller.getSnapshot())).not.toContain(
    changeInput.url,
  );
  h.start.resolve(changed(h.request()));
  await flush();
  expect(h.owner.configuring).toBe(false);
  expect(h.controller.getSnapshot()).toMatchObject({
    unresolved: false,
    items: [managedItem],
    itemsRead: true,
  });
  expect({
    queued: h.owner.queued,
    paused: h.owner.queuePaused,
    draft: composerDrafts.read("session:owned"),
  }).toEqual(before);
});
it("reads only backend-owned item references and withdraws by the opaque reference, never the displayed name", async () => {
  const h = changeFixture();
  expect(
    h.controller.start({ kind: "remove", itemRef: managedItem.name }),
  ).toBe(false);
  expect(h.controller.list()).toBe(true);
  await flush();
  expect(h.port.start.mock.calls[0][1]).toEqual({ kind: "inspect" });
  expect(h.owner.configuring).toBe(false);
  h.start.resolve(inspected(h.request()));
  await flush();
  const removal = deferred();
  h.port.start.mockReturnValueOnce(removal.promise);
  expect(
    h.controller.start({ kind: "remove", itemRef: managedItem.itemRef }),
  ).toBe(true);
  await flush();
  expect(h.port.start.mock.calls[1][1]).toEqual({
    kind: "remove",
    itemRef: managedItem.itemRef,
  });
  removal.resolve({
    ...changed(h.request()),
    kind: "remove",
    activity: "absentReported",
    items: [],
  });
  await flush();
  expect(h.controller.getSnapshot().unresolved).toBe(false);
  expect(h.owner.configuring).toBe(false);
});
it("keeps a pending operation through unsubscribe and checks only its ID without replaying the mutation", async () => {
  const h = changeFixture(),
    listener = vi.fn();
  const unsubscribe = h.controller.subscribe(listener);
  h.controller.start(changeInput);
  await flush();
  const request = h.request();
  h.start.resolve(changeOperation(request));
  await flush();
  unsubscribe();
  expect(h.owner.configuring).toBe(true);
  expect(h.controller.check()).toBe(true);
  expect(h.controller.check()).toBe(false);
  await flush();
  expect(h.port.status).toHaveBeenCalledExactlyOnceWith(request);
  h.status.resolve(changed(request));
  await flush();
  expect(h.port.start).toHaveBeenCalledOnce();
  expect(h.controller.getSnapshot().unresolved).toBe(false);
});
it("unknown remains protected even when the backend has settled, and separate confirmed recovery reopens local controls", async () => {
  const h = changeFixture();
  h.controller.start(changeInput);
  await flush();
  const request = h.request();
  h.start.resolve(
    changeOperation(request, {
      state: "unknown",
      settled: true,
      mutationSent: true,
      persistence: "unknown",
    }),
  );
  await flush();
  expect(h.controller.getSnapshot()).toMatchObject({
    unresolved: true,
    error: "unknown",
  });
  expect(h.owner.sessionToolRecoveryRequired).toBe(true);
  expect(h.owner.configuring).toBe(true);
  expect(h.controller.start(changeInput)).toBe(false);
  expect(h.protection.settle(h.owner, request.operationId)).toBe(true);
  expect(h.controller.getSnapshot()).toMatchObject({
    unresolved: false,
    recovered: true,
    itemsRead: false,
  });
  expect(
    h.controller.start({ kind: "remove", itemRef: managedItem.itemRef }),
  ).toBe(false);
});
it.each([
  {
    state: "ready",
    settled: true,
    mutationSent: true,
    persistence: "confirmed",
    activity: "unreported",
  },
  {
    state: "ready",
    settled: true,
    mutationSent: true,
    persistence: "confirmed",
    activity: "absentReported",
  },
  { state: "failed", settled: true, mutationSent: true },
])(
  "does not treat empty items or an inconsistent outcome as removal or a released write: %o",
  async (patch) => {
    const h = changeFixture();
    h.controller.start(changeInput);
    await flush();
    h.start.resolve({ ...changeOperation(h.request()), ...patch, items: [] });
    await flush();
    expect(h.controller.getSnapshot().unresolved).toBe(true);
    expect(h.owner.configuring).toBe(true);
    expect(h.owner.sessionToolRecoveryRequired).toBe(true);
  },
);
it("releases an explicit not-dispatched failure but not an IPC rejection with the same code", async () => {
  const a = changeFixture();
  a.controller.start(changeInput);
  await flush();
  a.start.resolve({
    ...changeOperation(a.request(), { state: "failed", settled: true }),
    error: { code: "busy", message: "PRIVATE" },
  });
  await flush();
  expect(a.controller.getSnapshot()).toMatchObject({
    unresolved: false,
    error: "busy",
  });
  expect(a.owner.configuring).toBe(false);
  expect(JSON.stringify(a.controller.getSnapshot())).not.toContain("PRIVATE");
  const b = changeFixture();
  b.controller.start(changeInput);
  await flush();
  b.start.reject({ code: "busy", message: "PRIVATE" });
  await flush();
  expect(b.controller.getSnapshot().unresolved).toBe(true);
  expect(b.owner.configuring).toBe(true);
  expect(b.owner.sessionToolRecoveryRequired).toBe(true);
});
it("timeout keeps status available and a later exact ready result can settle without automatic retry", async () => {
  vi.useFakeTimers();
  const h = changeFixture();
  h.controller.start(changeInput);
  await flush();
  await vi.advanceTimersByTimeAsync(101);
  expect(h.controller.getSnapshot()).toMatchObject({
    unresolved: true,
    checking: false,
    error: "timeout",
  });
  expect(h.controller.check()).toBe(true);
  await flush();
  h.start.resolve(changed(h.request()));
  await flush();
  expect(h.owner.configuring).toBe(false);
  expect(h.controller.getSnapshot().unresolved).toBe(false);
  h.status.resolve(changeOperation(h.request()));
  await flush();
  expect(h.controller.getSnapshot().unresolved).toBe(false);
  expect(h.port.start).toHaveBeenCalledOnce();
});
it.each(["connectionId", "cwd", "nativeSessionId"] as const)(
  "rejects stale %s ownership before dispatch and ignores results after replacement",
  async (field) => {
    const h = changeFixture();
    h.owner[field] = "changed";
    expect(h.controller.start(changeInput)).toBe(false);
    expect(h.port.start).not.toHaveBeenCalled();
    const a = changeFixture();
    a.controller.start(changeInput);
    await flush();
    a.owner[field] = "changed";
    a.start.resolve(changed(a.request()));
    await flush();
    expect(a.controller.getSnapshot().operation).toBeNull();
    expect(a.controller.check()).toBe(false);
  },
);
it("blocks non-capable, busy, unpaused-queue and raw-input extensions without changing the owner", () => {
  for (const mutate of [
    (h: ReturnType<typeof changeFixture>) => {
      h.owner.sessionToolInventory = null;
    },
    (h: ReturnType<typeof changeFixture>) => {
      h.owner.running = true;
    },
    (h: ReturnType<typeof changeFixture>) => {
      h.owner.configuring = true;
    },
    (h: ReturnType<typeof changeFixture>) => {
      h.owner.queued = [{}] as never;
      h.owner.queuePaused = null;
    },
  ]) {
    const h = changeFixture();
    mutate(h);
    expect(h.controller.start(changeInput)).toBe(false);
    expect(h.port.start).not.toHaveBeenCalled();
  }
  const h = changeFixture();
  expect(
    h.controller.start({
      ...changeInput,
      headers: { Authorization: "PRIVATE" },
    } as never),
  ).toBe(false);
  expect(
    h.controller.start({
      ...changeInput,
      url: "https://user:password@example.test",
    }),
  ).toBe(false);
});
it("checks the same timed-out inspection without manufacturing a durable write recovery or replaying the query", async () => {
  vi.useFakeTimers();
  const h = changeFixture();
  h.controller.list();
  await flush();
  await vi.advanceTimersByTimeAsync(101);
  expect(h.controller.list()).toBe(false);
  expect(h.owner.configuring).toBe(false);
  expect(h.owner.sessionToolRecoveryRequired).not.toBe(true);
  expect(h.controller.check()).toBe(true);
  await flush();
  h.status.resolve(inspected(h.request()));
  await flush();
  expect(h.controller.getSnapshot().items).toEqual([managedItem]);
  h.start.resolve(changeOperation(h.request(), { kind: "inspect" }));
  await flush();
  expect(h.controller.getSnapshot().unresolved).toBe(false);
  expect(h.port.start).toHaveBeenCalledOnce();
});
it("releases only an explicit native pre-dispatch refusal and allows a corrected attempt", async () => {
  const h = changeFixture();
  h.controller.start(changeInput);
  await flush();
  h.start.reject({
    code: "invalidInput",
    message: "static",
    notDispatched: true,
  });
  await flush();
  expect(h.owner.configuring).toBe(false);
  expect(h.controller.getSnapshot().unresolved).toBe(false);
  expect(h.owner.sessionToolRecoveryRequired).not.toBe(true);
  expect(h.controller.start(changeInput)).toBe(true);
});
it("never interprets a status-query refusal as proof the original write was not dispatched", async () => {
  const h = changeFixture();
  expect(h.controller.start(changeInput)).toBe(true);
  await flush();
  h.start.resolve(changeOperation(h.request()));
  await flush();
  expect(h.controller.check()).toBe(true);
  await flush();
  h.status.reject({
    code: "queryFailed",
    message: "PRIVATE",
    notDispatched: true,
  });
  await flush();
  expect(h.controller.getSnapshot()).toMatchObject({
    unresolved: true,
    error: "queryFailed",
  });
  expect(h.owner.configuring).toBe(true);
  expect(h.owner.sessionToolRecoveryRequired).toBe(true);
  expect(h.controller.start(changeInput)).toBe(false);
  expect(h.port.start).toHaveBeenCalledOnce();
});
it.each(["replace", "connection", "source"])(
  "drops a %s owner before the invoke microtask and releases only its unsent guard",
  async (change) => {
    const h = changeFixture();
    h.controller.start(changeInput);
    const replacement = { ...h.owner };
    if (change === "replace") {
      replacement.configuring = true;
      h.replace(replacement);
    } else if (change === "connection") h.owner.connectionId = "new";
    else h.owner.serviceContext = "new";
    await flush();
    expect(h.port.start).not.toHaveBeenCalled();
    expect(h.owner.configuring).toBe(false);
    if (change === "replace") expect(replacement.configuring).toBe(true);
  },
);
it("shows an ambiguous existing item but never dispatches its removal", async () => {
  const h = changeFixture();
  h.controller.list();
  await flush();
  h.start.resolve(
    inspected(h.request(), [{ ...managedItem, canRemove: false }]),
  );
  await flush();
  expect(h.controller.getSnapshot().items).toHaveLength(1);
  expect(
    h.controller.start({ kind: "remove", itemRef: managedItem.itemRef }),
  ).toBe(false);
});
