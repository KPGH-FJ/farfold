import { afterEach, expect, it, vi } from "vitest";
import { flush } from "./extension_inventory.test-support";
import {
  setup,
  reviewed,
  operation,
  written,
} from "./skill_management.test-support";
afterEach(() => vi.useRealTimers());
it("uses actual original inventory target and requires one separate explicit confirmation", async () => {
  const h = await setup();
  const review = await reviewed(h);
  expect(h.port.inspect).toHaveBeenCalledExactlyOnceWith({
    agentId: "fixture",
    requestId: h.client.get("fixture").request!.requestId,
    inventoryRequestId: h.result.request.requestId,
    itemId: 0,
    enabled: true,
  });
  expect(h.port.confirm).not.toHaveBeenCalled();
  expect(h.client.confirm(h.owner, review)).toBe(true);
  expect(h.client.confirm(h.owner, review)).toBe(false);
  await flush();
  const request = h.client.get("fixture").request!;
  expect(h.port.confirm).toHaveBeenCalledExactlyOnceWith({
    agentId: "fixture",
    requestId: request.requestId,
    reviewId: review.reviewId,
  });
  h.confirm.resolve(written(request));
  await flush();
  expect(h.client.get("fixture").operation?.outcome).toBe("verified");
  expect(h.inventory.get("fixture").results.skills?.stale).toBe(true);
});
it("retirement before delayed inspection cannot regrant review through status", async () => {
  const h = await setup();
  h.client.inspect(h.target);
  await flush();
  const r = h.client.get("fixture").request!;
  h.close();
  h.inspect.resolve(operation(r, "ready"));
  await flush();
  expect(h.client.get("fixture").review).toBeNull();
  expect(h.client.get("fixture").unresolved).toBe(false);
  expect(h.port.confirm).not.toHaveBeenCalled();
});
it("a still-live inspect can receive the original review after pending cleanup", async () => {
  const h = await setup();
  h.client.inspect(h.target);
  await flush();
  const r = h.client.get("fixture").request!;
  h.inspect.resolve({
    ...operation(r),
    state: "pendingCleanup",
    phase: "cleaning",
  });
  await flush();
  h.client.check("fixture", r.requestId);
  h.status.resolve(operation(r, "ready"));
  await flush();
  expect(h.client.canConfirm(h.owner, h.client.get("fixture").review!)).toBe(
    true,
  );
});
it("synchronous subscriber retirement fences inspection and confirmation before dispatch", async () => {
  const a = await setup();
  a.client.subscribe(a.close);
  expect(a.client.inspect(a.target)).toBe(false);
  await flush();
  expect(a.port.inspect).not.toHaveBeenCalled();
  const b = await setup(),
    review = await reviewed(b);
  b.client.subscribe(() => {
    if (b.client.get("fixture").request?.action === "setEnabled") b.close();
  });
  expect(b.client.confirm(b.owner, review)).toBe(false);
  await flush();
  expect(b.port.confirm).not.toHaveBeenCalled();
});
it("close after confirm dispatch cancels that exact independent request, not a new selection", async () => {
  const h = await setup(),
    review = await reviewed(h),
    inspectId = h.client.get("fixture").request!.requestId;
  h.client.confirm(h.owner, review);
  await flush();
  const r = h.client.get("fixture").request!;
  h.close();
  await flush();
  expect(h.port.cancel.mock.calls.map(([v]) => v.requestId)).toContain(
    r.requestId,
  );
  expect(h.port.cancel.mock.calls.map(([v]) => v.requestId)).toContain(
    inspectId,
  );
  h.confirm.resolve(written(r));
  await flush();
  expect(h.client.get("fixture").operation?.outcome).toBe("verified");
  expect(h.client.get("fixture").review).toBeNull();
});
it("lost acknowledgement stays unknown, explicit new-ID recheck never repeats a write", async () => {
  const h = await setup(),
    review = await reviewed(h);
  h.client.confirm(h.owner, review);
  await flush();
  const r = h.client.get("fixture").request!;
  h.confirm.resolve({
    ...written(r, "unknown"),
    state: "failed",
    code: "writeUncertain",
    observation: null,
  });
  await flush();
  expect(h.client.get("fixture").operation?.outcome).toBe("unknown");
  expect(h.client.recheck("fixture", r.requestId)).toBe(true);
  await flush();
  const check = h.client.get("fixture").request!;
  expect(check.requestId).not.toBe(r.requestId);
  expect(check.operationId).toBe(r.requestId);
  h.recheck.resolve(written(check, "unknown"));
  await flush();
  expect(h.client.get("fixture").operation).toMatchObject({
    outcome: "observed",
    writeAck: "unknown",
  });
  expect(h.port.confirm).toHaveBeenCalledTimes(1);
});
it("observer deadline and ordinary cancellation null never claim cleanup or no-write", async () => {
  vi.useFakeTimers();
  const h = await setup(),
    review = await reviewed(h);
  h.client.confirm(h.owner, review);
  await flush();
  const r = h.client.get("fixture").request!;
  await vi.advanceTimersByTimeAsync(101);
  expect(h.client.get("fixture").unresolved).toBe(true);
  expect(h.inventory.get("fixture").results.skills?.stale).toBe(true);
  h.client.cancel("fixture", r.requestId);
  h.cancel.resolve({
    agentId: "fixture",
    requestId: r.requestId,
    cancelRequested: true,
    operation: null,
  });
  await flush();
  expect(h.client.get("fixture").unresolved).toBe(true);
  expect(h.port.confirm).toHaveBeenCalledTimes(1);
});
it("explicit exact cancel after unknown status retires tracking without resurrecting late ready", async () => {
  const h = await setup(),
    review = await reviewed(h);
  h.client.confirm(h.owner, review);
  await flush();
  const r = h.client.get("fixture").request!;
  h.client.check("fixture", r.requestId);
  h.status.reject({ code: "unknownRequest" });
  await flush();
  expect(h.client.get("fixture").unresolved).toBe(true);
  h.client.cancel("fixture", r.requestId);
  h.cancel.resolve({
    agentId: "fixture",
    requestId: r.requestId,
    cancelRequested: true,
    operation: null,
  });
  await flush();
  expect(h.client.get("fixture").trackingReleased).toBe(true);
  h.confirm.resolve(written(r));
  await flush();
  expect(h.client.get("fixture").operation).toBeNull();
  expect(h.client.get("fixture").error).toBe("unknownRequest");
});
it("old request callbacks cannot control a successor; expired review never confirms", async () => {
  vi.useFakeTimers();
  const h = await setup(),
    review = await reviewed(h),
    old = h.client.get("fixture").request!;
  await vi.advanceTimersByTimeAsync(300001);
  expect(h.client.confirm(h.owner, review)).toBe(false);
  expect(h.client.inspect(h.target)).toBe(true);
  const current = h.client.get("fixture").request!;
  h.client.cancel("fixture", old.requestId);
  h.client.check("fixture", old.requestId);
  await flush();
  expect(h.client.get("fixture").request).toBe(current);
  expect(h.port.status).not.toHaveBeenCalled();
  expect(h.port.confirm).not.toHaveBeenCalled();
});
it("a reported write acknowledgement cannot be erased by a later running response", async () => {
  const h = await setup(),
    review = await reviewed(h);
  h.client.confirm(h.owner, review);
  await flush();
  const r = h.client.get("fixture").request!;
  h.client.check("fixture", r.requestId);
  h.status.resolve({
    ...operation(r),
    phase: "checking",
    writeDispatched: true,
    writeAck: "ok",
  });
  await flush();
  h.confirm.resolve(operation(r));
  await flush();
  expect(h.client.get("fixture").operation?.writeAck).toBe("ok");
});
it("cancel of one in-flight inspection sends one exact cancellation", async () => {
  const h = await setup();
  h.client.inspect(h.target);
  await flush();
  const r = h.client.get("fixture").request!;
  h.client.cancel("fixture", r.requestId);
  await flush();
  expect(h.port.cancel).toHaveBeenCalledExactlyOnceWith({
    agentId: "fixture",
    requestId: r.requestId,
  });
  h.cancel.resolve({
    agentId: "fixture",
    requestId: r.requestId,
    cancelRequested: true,
    operation: {
      ...operation(r),
      state: "cancelled",
      phase: "complete",
      settled: true,
      code: "cancelled",
    },
  });
  await flush();
  expect(h.client.get("fixture").unresolved).toBe(false);
});
it("recheck rejects an invented successful acknowledgement for the original lost write", async () => {
  const h = await setup(),
    review = await reviewed(h);
  h.client.confirm(h.owner, review);
  await flush();
  const r = h.client.get("fixture").request!;
  h.confirm.resolve({
    ...written(r, "unknown"),
    state: "failed",
    code: "writeUncertain",
    observation: null,
  });
  await flush();
  h.client.recheck("fixture", r.requestId);
  await flush();
  h.recheck.resolve(written(h.client.get("fixture").request!, "ok"));
  await flush();
  expect(h.client.get("fixture").error).toBe("invalidOutput");
  expect(h.client.get("fixture").unresolved).toBe(true);
});
it.each(["reviewExpired", "reviewConsumed"])(
  "fresh direct %s rejection records no write without inventing a worker result",
  async (code) => {
    const h = await setup(),
      review = await reviewed(h);
    h.client.confirm(h.owner, review);
    await flush();
    h.confirm.reject({ code });
    await flush();
    expect(h.client.get("fixture")).toMatchObject({
      unresolved: false,
      admissionRejected: true,
      error: code,
      operation: null,
    });
    expect(h.inventory.get("fixture").results.skills?.stale).toBe(false);
    expect(h.port.confirm).toHaveBeenCalledTimes(1);
  },
);
it("a review rejection after the observer deadline cannot erase uncertainty", async () => {
  vi.useFakeTimers();
  const h = await setup(),
    review = await reviewed(h);
  h.client.confirm(h.owner, review);
  await flush();
  await vi.advanceTimersByTimeAsync(101);
  h.confirm.reject({ code: "reviewExpired" });
  await flush();
  expect(h.client.get("fixture").unresolved).toBe(true);
  expect(h.client.get("fixture").admissionRejected).not.toBe(true);
});
it.each(["status", "cancel"] as const)(
  "%s errors cannot borrow the fresh-confirm refusal exception",
  async (method) => {
    const h = await setup(),
      review = await reviewed(h);
    h.client.confirm(h.owner, review);
    await flush();
    const r = h.client.get("fixture").request!;
    if (method === "status") h.client.check("fixture", r.requestId);
    else h.client.cancel("fixture", r.requestId);
    h[method].reject({ code: "reviewExpired" });
    await flush();
    expect(h.client.get("fixture")).toMatchObject({
      unresolved: true,
      admissionRejected: false,
    });
    h.confirm.reject({ code: "reviewConsumed" });
    await flush();
    expect(h.client.get("fixture")).toMatchObject({
      unresolved: true,
      admissionRejected: false,
    });
  },
);
it("an observed running operation prevents later direct refusal from erasing admitted work", async () => {
  const h = await setup(),
    review = await reviewed(h);
  h.client.confirm(h.owner, review);
  await flush();
  const r = h.client.get("fixture").request!;
  h.client.check("fixture", r.requestId);
  h.status.resolve(operation(r));
  await flush();
  h.confirm.reject({ code: "reviewExpired" });
  await flush();
  expect(h.client.get("fixture")).toMatchObject({
    unresolved: true,
    admissionRejected: false,
    operation: { state: "running" },
  });
});
