import { afterEach, expect, it, vi } from "vitest";
import { flush } from "./extension_inventory.test-support";
import {
  setup,
  reviewed,
  operation,
  written,
  snapshot,
} from "./mcp_remove.test-support";
import { isRemoveRequest } from "./extension_management_types";
afterEach(() => vi.useRealTimers());
it("keeps null removal in its exact port through inspection and separate one-shot confirmation", async () => {
  const h = await setup(),
    rev = await reviewed(h);
  expect(h.port.inspect).toHaveBeenCalledExactlyOnceWith({
    agentId: h.owner.agentId,
    requestId: h.controller.get(h.owner.agentId).request!.requestId,
    inventoryRequestId: h.result.request.requestId,
    itemId: 0,
  });
  expect(h.skills.inspect).not.toHaveBeenCalled();
  expect(h.port.confirm).not.toHaveBeenCalled();
  expect(h.controller.confirm(h.owner, rev)).toBe(true);
  expect(h.controller.confirm(h.owner, rev)).toBe(false);
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  expect(r).toMatchObject({
    action: "remove",
    requestedEnabled: null,
    target: { kind: "mcpRemoval" },
  });
  expect(h.port.confirm).toHaveBeenCalledExactlyOnceWith({
    agentId: r.agentId,
    requestId: r.requestId,
    reviewId: rev.reviewId,
  });
  h.pending.confirm.resolve(written(r));
  await flush();
  expect(h.controller.get(h.owner.agentId).operation?.outcome).toBe("verified");
  expect(h.inventory.get(h.owner.agentId).results.mcp?.stale).toBe(true);
});
it.each(["unknown", "rejected"] as const)(
  "retains original %s while explicit readonly rechecks yield observed, mismatch or failure",
  async (ack) => {
    const h = await setup(),
      rev = await reviewed(h);
    h.controller.confirm(h.owner, rev);
    await flush();
    const r = h.controller.get(h.owner.agentId).request!;
    const original = {
      ...written(r),
      state: "failed",
      outcome: ack,
      writeAck: ack,
      code: ack === "unknown" ? "writeUncertain" : "configurationChanged",
      observation: null,
    };
    h.pending.confirm.resolve(original);
    await flush();
    const before = structuredClone(h.controller.get(h.owner.agentId).operation);
    expect(h.controller.recheck(h.owner.agentId, r.requestId)).toBe(true);
    await flush();
    const next = h.controller.get(h.owner.agentId).request!;
    expect(next.operationId).toBe(r.requestId);
    expect(next.requestId).not.toBe(r.requestId);
    h.pending.recheck.resolve({ ...written(next), writeAck: ack });
    await flush();
    expect(h.controller.get(h.owner.agentId).operation).toMatchObject({
      outcome: "observed",
      writeAck: ack,
    });
    expect(h.controller.get(h.owner.agentId).originalOperation).toEqual(before);
    h.port.recheck = vi.fn(async () => ({
      ...written(h.controller.get(h.owner.agentId).request!),
      writeAck: ack,
      outcome: "mismatch",
      observation: {
        ...written(next).observation,
        configuration: "different",
        mcp: "present",
        reportedEnabled: false,
        configuredEnabled: false,
        parentOutcome: "nonempty",
      },
    }));
    h.controller.recheck(h.owner.agentId, next.requestId);
    await flush();
    expect(h.controller.get(h.owner.agentId).operation?.outcome).toBe(
      "mismatch",
    );
    expect(h.controller.get(h.owner.agentId).originalOperation).toEqual(before);
    h.port.recheck = vi.fn(async () => ({
      ...written(h.controller.get(h.owner.agentId).request!),
      writeAck: ack,
      state: "failed",
      outcome: "unknown",
      code: "queryFailed",
      observation: null,
    }));
    h.controller.recheck(
      h.owner.agentId,
      h.controller.get(h.owner.agentId).request!.requestId,
    );
    await flush();
    expect(h.controller.get(h.owner.agentId).originalOperation).toEqual(before);
    expect(h.port.confirm).toHaveBeenCalledTimes(1);
  },
);
it("rejects recheck changing the original acknowledgement", async () => {
  const h = await setup(),
    rev = await reviewed(h);
  h.controller.confirm(h.owner, rev);
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  h.pending.confirm.resolve({
    ...written(r),
    state: "failed",
    outcome: "unknown",
    code: "writeUncertain",
    writeAck: "unknown",
    observation: null,
  });
  await flush();
  h.controller.recheck(h.owner.agentId, r.requestId);
  await flush();
  h.pending.recheck.resolve(
    written(h.controller.get(h.owner.agentId).request!),
  );
  await flush();
  expect(h.controller.get(h.owner.agentId)).toMatchObject({
    unresolved: true,
    error: "invalidOutput",
    originalOperation: { writeAck: "unknown" },
  });
  h.close();
});
it("retires a late review across same-field A-B-A selection without using bool ports", async () => {
  const h = await setup();
  h.controller.inspect(h.target);
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  h.controller.retire(h.owner);
  const returnedOwner = { ...h.owner, token: {} };
  h.pending.inspect.resolve(operation(r, true));
  await flush();
  expect(h.controller.get(h.owner.agentId).review).toBeNull();
  expect(
    h.controller.canConfirm(returnedOwner, operation(r, true).review!),
  ).toBe(false);
  expect(h.port.cancel).toHaveBeenCalledWith({
    agentId: r.agentId,
    requestId: r.requestId,
  });
  expect(h.skills.cancel).not.toHaveBeenCalled();
});
it("observer timeout preserves exact cancellation/status and never automatically rewrites", async () => {
  vi.useFakeTimers();
  const h = await setup(),
    rev = await reviewed(h);
  h.controller.confirm(h.owner, rev);
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  await vi.advanceTimersByTimeAsync(101);
  expect(h.controller.get(h.owner.agentId)).toMatchObject({
    unresolved: true,
    error: "timedOut",
  });
  expect(h.inventory.get(h.owner.agentId).results.mcp?.stale).toBe(true);
  h.controller.cancel(r.agentId, r.requestId);
  await flush();
  h.pending.cancel.resolve({
    agentId: r.agentId,
    requestId: r.requestId,
    cancelRequested: true,
    operation: {
      ...operation(r),
      state: "pendingCleanup",
      phase: "cleaning",
      writeDispatched: true,
      writeAck: "unknown",
      code: "pendingCleanup",
    },
  });
  await flush();
  expect(h.controller.get(h.owner.agentId)).toMatchObject({
    unresolved: true,
    operation: { state: "pendingCleanup" },
  });
  h.controller.check(r.agentId, r.requestId);
  await flush();
  h.pending.status.resolve({
    ...written(r),
    state: "failed",
    code: "cancelled",
    writeAck: "unknown",
    outcome: "unknown",
    observation: null,
  });
  await flush();
  expect(h.controller.get(h.owner.agentId)).toMatchObject({
    unresolved: false,
    operation: { outcome: "unknown", state: "failed" },
  });
  expect(h.port.confirm).toHaveBeenCalledTimes(1);
  expect(h.skills.status).not.toHaveBeenCalled();
});
it("holds a removal flight across addition and preference attempts and accepts no enabled/cloned/incomplete source", async () => {
  const h = await setup();
  expect(
    h.controller.inspect({ ...h.target, item: { ...h.target.item } }),
  ).toBe(false);
  expect(
    h.controller.inspect({
      ...h.target,
      result: {
        ...h.result,
        snapshot: { ...snapshot, complete: false } as never,
      },
    }),
  ).toBe(false);
  const enabled = { ...h.target.item, reportedEnabled: true },
    result = { ...h.result, snapshot: { ...snapshot, items: [enabled] } };
  expect(h.controller.inspect({ ...h.target, item: enabled, result })).toBe(
    false,
  );
  h.controller.inspect(h.target);
  await flush();
  expect(
    h.controller.inspect({
      ...h.target,
      kind: undefined,
      requestedEnabled: false,
    } as never),
  ).toBe(false);
  expect(
    h.controller.inspect({
      owner: h.owner,
      result: h.result,
      current: () => true,
      changed: () => {},
      kind: "mcpAddition",
      inputId: h.result.request.requestId,
      input: { name: "other", executablePath: "/not-run", args: [] },
    }),
  ).toBe(false);
  expect(isRemoveRequest(h.controller.get(h.owner.agentId).request!)).toBe(
    true,
  );
  h.close();
});
it("only explicit exact cancel-null may retire expired unknown tracking; late removal result stays retired", async () => {
  const h = await setup(),
    rev = await reviewed(h);
  h.controller.confirm(h.owner, rev);
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  h.controller.check(r.agentId, r.requestId);
  await flush();
  h.pending.status.reject({ code: "unknownRequest" });
  await flush();
  expect(h.controller.get(h.owner.agentId).unresolved).toBe(true);
  h.controller.cancel(r.agentId, r.requestId, false);
  await flush();
  h.pending.cancel.resolve({
    agentId: r.agentId,
    requestId: r.requestId,
    cancelRequested: true,
    operation: null,
  });
  await flush();
  expect(h.controller.get(h.owner.agentId).unresolved).toBe(true);
  h.controller.cancel(r.agentId, r.requestId, true);
  await flush();
  expect(h.controller.get(h.owner.agentId)).toMatchObject({
    unresolved: false,
    trackingReleased: true,
    error: "unknownRequest",
    operation: null,
  });
  h.pending.confirm.resolve(written(r));
  await flush();
  expect(h.controller.get(h.owner.agentId)).toMatchObject({
    trackingReleased: true,
    operation: null,
  });
  expect(h.skills.cancel).not.toHaveBeenCalled();
});
it("retired and expired reviews never regain a confirmation from status or a returned owner", async () => {
  vi.useFakeTimers();
  const h = await setup(),
    rev = await reviewed(h);
  await vi.advanceTimersByTimeAsync(300001);
  expect(h.controller.confirm(h.owner, rev)).toBe(false);
  h.controller.retire(h.owner);
  await flush();
  expect(h.controller.get(h.owner.agentId).review).toBeNull();
  expect(h.controller.confirm({ ...h.owner, token: {} }, rev)).toBe(false);
  expect(h.port.confirm).not.toHaveBeenCalled();
});
