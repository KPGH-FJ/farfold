import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginManagementController } from "./plugin_management_controller";
import type { InventoryOwner } from "./extension_inventory_controller";
import type { PluginManagementPort } from "./plugin_management";
import { deferred, flush } from "./extension_inventory.test-support";
import {
  pluginOperation,
  pluginTicket,
} from "./plugin_management.test-support";
import type { PluginOperation } from "./plugin_management_types";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => vi.useRealTimers());
async function setup() {
  let live = true,
    n = 0;
  const owner: InventoryOwner = {
    agentId: "controlled",
    token: {},
    current: () => live,
  };
  const inspect = deferred(),
    confirm = deferred(),
    status = deferred(),
    cancel = deferred(),
    recheck = deferred();
  const port: PluginManagementPort = {
    sources: vi.fn(async () =>
      pluginOperation(client.get(owner.agentId).request!, true),
    ),
    inventory: vi.fn(async () =>
      pluginOperation(client.get(owner.agentId).request!, true),
    ),
    inspect: vi.fn(() => inspect.promise),
    confirm: vi.fn(() => confirm.promise),
    status: vi.fn(() => status.promise),
    cancel: vi.fn(() => cancel.promise),
    recheck: vi.fn(() => recheck.promise),
  };
  const client = new PluginManagementController(
    port,
    100,
    () => `aaaaaaaa-aaaa-aaaa-aaaa-${String(++n).padStart(12, "0")}`,
  );
  expect(port.inventory).not.toHaveBeenCalled();
  const query = async (selectedOwner = owner, cwd = "/controlled") => {
    expect(client.begin(selectedOwner, cwd, pluginTicket)).toBe(true);
    await flush();
    const source = client.get(owner.agentId).sourceResult!;
    expect(
      client.inventory(selectedOwner, source, source.catalog.items[0]),
    ).toBe(true);
    await flush();
  };
  await query();
  const result = client.get(owner.agentId).result!;
  const startInspect = async () => {
    expect(client.inspect(owner, result, result.catalog.items[0], true)).toBe(
      true,
    );
    await flush();
  };
  const reviewed = async () => {
    await startInspect();
    inspect.resolve(pluginOperation(client.get(owner.agentId).request!, true));
    await flush();
    return client.get(owner.agentId).review!;
  };
  return {
    client,
    owner,
    port,
    inspect,
    confirm,
    status,
    cancel,
    recheck,
    result,
    startInspect,
    reviewed,
    query,
    close: () => {
      live = false;
      client.retire(owner);
    },
  };
}
it("only explicit inventory runs, preserving the original partial catalog receipt and indexed target", async () => {
  const x = await setup();
  expect(x.port.inventory).toHaveBeenCalledOnce();
  expect(x.result.catalog.complete).toBe(false);
  expect(x.port.inspect).not.toHaveBeenCalled();
  expect(x.port.confirm).not.toHaveBeenCalled();
  expect(
    x.client.inspect(x.owner, x.result, { ...x.result.catalog.items[0] }, true),
  ).toBe(false);
  await x.startInspect();
  expect(x.port.inspect).toHaveBeenCalledWith({
    agentId: x.owner.agentId,
    requestId: x.client.get(x.owner.agentId).request!.requestId,
    inventoryRequestId: x.result.request.requestId,
    itemId: 0,
    install: true,
  });
  expect(x.client.get(x.owner.agentId).result).toBe(x.result);
  expect(x.client.begin(x.owner, "/controlled", pluginTicket)).toBe(false);
});
it("requires the current source receipt and its actual item after each explicit source refresh", async () => {
  const x = await setup(),
    prior = x.client.get(x.owner.agentId).sourceResult!;
  expect(x.port.sources).toHaveBeenCalledOnce();
  expect(
    x.client.inventory(x.owner, prior, { ...prior.catalog.items[0] }),
  ).toBe(false);
  expect(x.client.begin(x.owner, "/controlled", pluginTicket)).toBe(true);
  expect(x.client.inventory(x.owner, prior, prior.catalog.items[0])).toBe(
    false,
  );
  expect(
    x.client.inspect(x.owner, x.result, x.result.catalog.items[0], true),
  ).toBe(false);
  await flush();
  const next = x.client.get(x.owner.agentId).sourceResult!;
  expect(next.request.requestId).not.toBe(prior.request.requestId);
  expect(next.catalog.items).toEqual(prior.catalog.items);
  expect(x.port.inventory).toHaveBeenCalledOnce();
  expect(x.client.inventory(x.owner, prior, prior.catalog.items[0])).toBe(
    false,
  );
  expect(x.client.inventory(x.owner, next, next.catalog.items[0])).toBe(true);
  await flush();
  expect(x.port.inventory).toHaveBeenLastCalledWith({
    agentId: x.owner.agentId,
    requestId: x.client.get(x.owner.agentId).request!.requestId,
    sourceRequestId: next.request.requestId,
    sourceId: 0,
  });
});

it.each([false, true])(
  "preserves the last dispatched pair through a new Sources read (failed=%s)",
  async (failed) => {
    const x = await unknownConfirmation(),
      pending = deferred();
    vi.mocked(x.port.sources).mockImplementation(() => pending.promise);
    x.client.begin(x.owner, "/other", pluginTicket);
    await flush();
    const current = x.client.get(x.owner.agentId).request!;
    expect(x.client.get(x.owner.agentId).originalOperation).toBe(x.original);
    expect(x.client.recheck(x.owner.agentId, current.requestId)).toBe(false);
    expect(x.client.isCurrentResult(x.owner, x.result)).toBe(false);
    pending.resolve(
      failed
        ? {
            ...pluginOperation(current),
            state: "failed",
            phase: "complete",
            settled: true,
            code: "queryFailed",
          }
        : pluginOperation(current, true),
    );
    await flush();
    expect(x.client.get(x.owner.agentId).originalOperation).toBe(x.original);
    expect(x.client.get(x.owner.agentId).operation?.outcome).toBeNull();
    expect(x.port.inventory).toHaveBeenCalledOnce();
    expect(x.client.confirm(x.owner, x.review)).toBe(false);
    expect(x.client.recheck(x.owner.agentId, current.requestId)).toBe(true);
    await flush();
    expect(x.port.recheck).toHaveBeenCalledWith({
      agentId: x.owner.agentId,
      requestId: x.client.get(x.owner.agentId).request!.requestId,
      operationId: x.confirmation.requestId,
    });
    expect(x.client.get(x.owner.agentId).request?.target).toEqual(
      x.confirmation.target,
    );
    x.recheck.resolve({
      ...pluginOperation(x.client.get(x.owner.agentId).request!, true),
      state: "failed",
      code: "writeUncertain",
      outcome: "unknown",
    });
    await flush();
  },
);
it("review is read-only, confirmation is explicit and consumed exactly once", async () => {
  const x = await setup(),
    review = await x.reviewed();
  expect(x.client.canConfirm(x.owner, review)).toBe(true);
  expect(x.port.confirm).not.toHaveBeenCalled();
  expect(x.client.confirm(x.owner, review)).toBe(true);
  expect(x.client.confirm(x.owner, review)).toBe(false);
  await flush();
  expect(x.port.confirm).toHaveBeenCalledOnce();
  expect(x.client.get(x.owner.agentId).result?.stale).toBe(true);
});
it("expired review and an old owner cannot dispatch a write", async () => {
  const x = await setup(),
    review = await x.reviewed();
  vi.setSystemTime(302000);
  expect(x.client.confirm(x.owner, review)).toBe(false);
  x.close();
  expect(x.client.confirm(x.owner, review)).toBe(false);
  expect(x.port.confirm).not.toHaveBeenCalled();
});
it("unknown writes keep prior catalog and only explicit readback may observe the result", async () => {
  const x = await setup(),
    review = await x.reviewed();
  x.client.confirm(x.owner, review);
  await flush();
  const request = x.client.get(x.owner.agentId).request!;
  x.confirm.resolve({
    ...pluginOperation(request, true),
    state: "failed",
    code: "writeUncertain",
    writeDispatched: true,
    writeAck: "unknown",
    outcome: "unknown",
  });
  await flush();
  const value = x.client.get(x.owner.agentId);
  expect(value.unresolved).toBe(false);
  expect(value.operation?.outcome).toBe("unknown");
  expect(value.result?.catalog).toBe(x.result.catalog);
  expect(x.port.inventory).toHaveBeenCalledOnce();
  expect(x.port.recheck).not.toHaveBeenCalled();
  expect(x.client.recheck(x.owner.agentId, request.requestId)).toBe(true);
  await flush();
  x.recheck.resolve({
    ...pluginOperation(x.client.get(x.owner.agentId).request!, true),
    writeDispatched: false,
    writeAck: "none",
    outcome: "observed",
    observation: {
      observedAtMs: 2,
      reportedInstalled: true,
      reportedEnabled: false,
      sessionApplicability: "unverified",
    },
  });
  await flush();
  expect(x.client.get(x.owner.agentId).operation?.outcome).toBe("observed");
  expect(x.client.get(x.owner.agentId).originalOperation?.writeDispatched).toBe(
    true,
  );
  expect(x.client.get(x.owner.agentId).originalOperation?.writeAck).toBe(
    "unknown",
  );
  expect(x.port.confirm).toHaveBeenCalledOnce();
});
it("timeout never settles or automatically retries a possibly dispatched operation", async () => {
  const x = await setup();
  await x.startInspect();
  await vi.advanceTimersByTimeAsync(101);
  expect(x.client.get(x.owner.agentId).unresolved).toBe(true);
  expect(x.client.get(x.owner.agentId).error).toBe("timedOut");
  expect(x.port.inspect).toHaveBeenCalledOnce();
  expect(x.port.status).not.toHaveBeenCalled();
  expect(x.client.begin(x.owner, "/other", pluginTicket)).toBe(false);
});
it("retiring an inspect owner cancels its actual request and never exposes its late review", async () => {
  const x = await setup();
  await x.startInspect();
  const request = x.client.get(x.owner.agentId).request!;
  x.close();
  await flush();
  expect(x.port.cancel).toHaveBeenCalledWith({
    agentId: request.agentId,
    requestId: request.requestId,
  });
  x.inspect.resolve(pluginOperation(request, true));
  await flush();
  expect(x.client.get(x.owner.agentId).review).toBeNull();
  expect(x.client.get(x.owner.agentId).result?.stale).toBe(true);
  expect(x.port.confirm).not.toHaveBeenCalled();
});
it("cancel and later running replies cannot erase confirmed write or cleanup facts", async () => {
  const x = await setup(),
    review = await x.reviewed();
  x.client.confirm(x.owner, review);
  await flush();
  const request = x.client.get(x.owner.agentId).request!;
  x.client.check(x.owner.agentId, request.requestId);
  await flush();
  x.status.resolve({
    ...pluginOperation(request),
    writeDispatched: true,
    writeAck: "unknown",
  });
  await flush();
  x.client.cancel(x.owner.agentId, request.requestId);
  await flush();
  x.cancel.resolve({
    agentId: request.agentId,
    requestId: request.requestId,
    cancelRequested: true,
    operation: {
      ...pluginOperation(request),
      state: "pendingCleanup",
      phase: "cleaning",
      writeDispatched: true,
      writeAck: "unknown",
    },
  });
  await flush();
  x.confirm.resolve(pluginOperation(request));
  await flush();
  const op = x.client.get(x.owner.agentId).operation!;
  expect(op.state).toBe("pendingCleanup");
  expect(op.writeDispatched).toBe(true);
  expect(op.writeAck).toBe("unknown");
});
it("a false verified result without a readback stays unresolved and never replaces the list", async () => {
  const x = await setup(),
    review = await x.reviewed();
  x.client.confirm(x.owner, review);
  await flush();
  x.confirm.resolve({
    ...pluginOperation(x.client.get(x.owner.agentId).request!, true),
    writeDispatched: true,
    writeAck: "ok",
    outcome: "verified",
  });
  await flush();
  expect(x.client.get(x.owner.agentId).error).toBe("invalidOutput");
  expect(x.client.get(x.owner.agentId).unresolved).toBe(true);
  expect(x.client.get(x.owner.agentId).result?.catalog).toBe(x.result.catalog);
});
it("a cancellation-null does not prove the process ended or let a second operation run", async () => {
  const x = await setup();
  await x.startInspect();
  const request = x.client.get(x.owner.agentId).request!;
  x.client.cancel(x.owner.agentId, request.requestId);
  await flush();
  x.cancel.resolve({
    agentId: request.agentId,
    requestId: request.requestId,
    cancelRequested: true,
    operation: null,
  });
  await flush();
  expect(x.client.get(x.owner.agentId).unresolved).toBe(true);
  expect(x.client.begin(x.owner, "/controlled", pluginTicket)).toBe(false);
});
it("a fresh official pre-admission expiry is distinct from a status failure after timeout", async () => {
  const x = await setup(),
    review = await x.reviewed();
  x.client.confirm(x.owner, review);
  await flush();
  await vi.advanceTimersByTimeAsync(101);
  const request = x.client.get(x.owner.agentId).request!;
  x.client.check(x.owner.agentId, request.requestId);
  await flush();
  x.status.reject({ code: "reviewExpired" });
  await flush();
  expect(x.client.get(x.owner.agentId).unresolved).toBe(true);
});

it("cancellation from a synchronous observer prevents an undispatched readback from starting", async () => {
  const x = await setup(),
    review = await x.reviewed();
  x.client.confirm(x.owner, review);
  await flush();
  const confirmation = x.client.get(x.owner.agentId).request!;
  x.confirm.resolve({
    ...pluginOperation(confirmation, true),
    state: "failed",
    code: "writeUncertain",
    writeDispatched: true,
    writeAck: "unknown",
    outcome: "unknown",
  });
  await flush();
  const unsubscribe = x.client.subscribe(() => {
    const view = x.client.get(x.owner.agentId);
    if (
      view.request?.action === "recheck" &&
      view.unresolved &&
      !view.cancelRequested
    )
      x.client.cancel(x.owner.agentId, view.request.requestId);
  });
  x.client.recheck(x.owner.agentId, confirmation.requestId);
  await flush();
  unsubscribe();
  expect(x.port.recheck).not.toHaveBeenCalled();
  expect(x.client.get(x.owner.agentId).unresolved).toBe(false);
});

it("repeated explicit readbacks keep an original unknown write distinct from each observation", async () => {
  const x = await setup(),
    review = await x.reviewed();
  x.client.confirm(x.owner, review);
  await flush();
  const confirmation = x.client.get(x.owner.agentId).request!;
  x.confirm.resolve({
    ...pluginOperation(confirmation, true),
    state: "failed",
    code: "writeUncertain",
    writeDispatched: true,
    writeAck: "unknown",
    outcome: "unknown",
  });
  await flush();
  const original = x.client.get(x.owner.agentId).originalOperation;
  vi.mocked(x.port.recheck).mockImplementation(async () => ({
    ...pluginOperation(x.client.get(x.owner.agentId).request!, true),
    state: "failed",
    code: "writeUncertain",
    outcome: "unknown",
    observation: {
      observedAtMs: 2,
      reportedInstalled: true,
      reportedEnabled: false,
      sessionApplicability: "unverified",
    },
  }));
  for (let i = 0; i < 2; i++) {
    expect(
      x.client.recheck(
        x.owner.agentId,
        x.client.get(x.owner.agentId).request!.requestId,
      ),
    ).toBe(true);
    await flush();
    const view = x.client.get(x.owner.agentId);
    expect(view.unresolved).toBe(false);
    expect(view.operation?.outcome).toBe("unknown");
    expect(view.operation?.writeDispatched).toBe(false);
    expect(view.operation?.writeAck).toBe("none");
    expect(view.originalOperation).toBe(original);
    expect(view.originalOperation?.writeAck).toBe("unknown");
  }
  x.close();
  expect(x.client.get(x.owner.agentId).originalOperation).toBe(original);
  expect(x.port.confirm).toHaveBeenCalledOnce();
  expect(x.port.recheck).toHaveBeenCalledTimes(2);
});

async function unknownConfirmation() {
  const x = await setup(),
    review = await x.reviewed();
  x.client.confirm(x.owner, review);
  await flush();
  const confirmation = x.client.get(x.owner.agentId).request!;
  x.confirm.resolve({
    ...pluginOperation(confirmation, true),
    state: "failed",
    code: "writeUncertain",
    writeDispatched: true,
    writeAck: "unknown",
    outcome: "unknown",
  });
  await flush();
  return {
    ...x,
    review,
    confirmation,
    original: x.client.get(x.owner.agentId).originalOperation!,
  };
}

it.each([false, true])(
  "keeps the last dispatched write across a new inventory (failed=%s), separately from its catalog",
  async (failed) => {
    const x = await unknownConfirmation(),
      pending = deferred();
    vi.mocked(x.port.inventory).mockImplementation(() => pending.promise);
    const owner = { ...x.owner, token: {} };
    expect(x.client.begin(owner, "/other", pluginTicket)).toBe(true);
    await flush();
    const source = x.client.get(owner.agentId).sourceResult!;
    expect(x.client.inventory(owner, source, source.catalog.items[0])).toBe(
      true,
    );
    const current = x.client.get(owner.agentId).request!;
    await flush();
    expect(x.client.get(owner.agentId).originalOperation).toBe(x.original);
    expect(x.client.recheck(owner.agentId, current.requestId)).toBe(false);
    expect(x.client.confirm(x.owner, x.review)).toBe(false);
    pending.resolve({
      ...pluginOperation(current, true),
      ...(failed
        ? { state: "failed", code: "queryFailed", catalog: null }
        : {}),
    });
    await flush();
    const view = x.client.get(owner.agentId);
    expect(view.unresolved).toBe(false);
    expect(view.operation?.action).toBe("inventory");
    expect(view.operation?.outcome).toBeNull();
    expect(view.originalOperation).toBe(x.original);
    expect(view.originalOperation?.outcome).toBe("unknown");
    expect(view.review).toBeNull();
    expect(x.client.canConfirm(owner, x.review)).toBe(false);
    expect(x.client.recheck(owner.agentId, current.requestId)).toBe(true);
    await flush();
    expect(x.port.recheck).toHaveBeenCalledWith({
      agentId: owner.agentId,
      requestId: x.client.get(owner.agentId).request!.requestId,
      operationId: x.confirmation.requestId,
    });
    expect(x.client.get(owner.agentId).request?.target).toEqual(
      x.confirmation.target,
    );
    expect(x.client.get(owner.agentId).request?.cwd).toBe("/controlled");
    x.recheck.resolve({
      ...pluginOperation(x.client.get(owner.agentId).request!, true),
      state: "failed",
      code: "writeUncertain",
      outcome: "unknown",
    });
    await flush();
    expect(x.client.get(owner.agentId).originalOperation).toBe(x.original);
    expect(x.port.confirm).toHaveBeenCalledOnce();
  },
);

it("keeps the last dispatched write through a new review and an undispatched confirmation, replacing it only with a new dispatched write", async () => {
  const x = await unknownConfirmation();
  vi.mocked(x.port.inventory).mockImplementation(async () => {
    const op = pluginOperation(x.client.get(x.owner.agentId).request!, true);
    op.catalog!.items[0].name = "newly-selected-package";
    return op;
  });
  await x.query();
  vi.mocked(x.port.inspect).mockImplementation(async () =>
    pluginOperation(x.client.get(x.owner.agentId).request!, true),
  );
  const inspectAgain = async () => {
    const result = x.client.get(x.owner.agentId).result!;
    expect(
      x.client.inspect(x.owner, result, result.catalog.items[0], true),
    ).toBe(true);
    await flush();
    return x.client.get(x.owner.agentId).review!;
  };
  const review = await inspectAgain();
  expect(x.client.get(x.owner.agentId).originalOperation).toBe(x.original);
  vi.mocked(x.port.confirm).mockImplementation(async () => ({
    ...pluginOperation(x.client.get(x.owner.agentId).request!, true),
    state: "failed",
    code: "targetChanged",
    outcome: "notDispatched",
  }));
  expect(x.client.confirm(x.owner, review)).toBe(true);
  expect(x.client.get(x.owner.agentId).originalOperation).toBe(x.original);
  await flush();
  expect(x.client.get(x.owner.agentId).operation?.outcome).toBe(
    "notDispatched",
  );
  expect(x.client.get(x.owner.agentId).originalOperation).toBe(x.original);
  expect(
    x.client.recheck(
      x.owner.agentId,
      x.client.get(x.owner.agentId).request!.requestId,
    ),
  ).toBe(true);
  await flush();
  expect(vi.mocked(x.port.recheck).mock.calls[0][0].operationId).toBe(
    x.confirmation.requestId,
  );
  expect(x.client.get(x.owner.agentId).request?.target).toEqual(
    x.confirmation.target,
  );
  x.recheck.resolve({
    ...pluginOperation(x.client.get(x.owner.agentId).request!, true),
    state: "failed",
    code: "writeUncertain",
    outcome: "unknown",
  });
  await flush();
  await x.query();
  const nextReview = await inspectAgain();
  vi.mocked(x.port.confirm).mockImplementation(async () => ({
    ...pluginOperation(x.client.get(x.owner.agentId).request!, true),
    state: "failed",
    code: "writeUncertain",
    writeDispatched: true,
    writeAck: "unknown",
    outcome: "unknown",
  }));
  x.client.confirm(x.owner, nextReview);
  await flush();
  const latest = x.client.get(x.owner.agentId).originalOperation!;
  expect(latest).not.toBe(x.original);
  expect(latest.requestId).toBe(
    x.client.get(x.owner.agentId).request!.requestId,
  );
  expect(latest.writeDispatched).toBe(true);
  expect(latest.target?.name).toBe("newly-selected-package");
  vi.mocked(x.port.recheck).mockImplementation(async () => ({
    ...pluginOperation(x.client.get(x.owner.agentId).request!, true),
    state: "failed",
    code: "writeUncertain",
    outcome: "unknown",
  }));
  x.client.recheck(x.owner.agentId, latest.requestId);
  await flush();
  expect(vi.mocked(x.port.recheck).mock.calls[1][0].operationId).toBe(
    latest.requestId,
  );
  expect(x.client.get(x.owner.agentId).request?.target).toEqual(latest.target);
});

it.each(["reviewExpired", "reviewConsumed"] as const)(
  "retains the paired write and readback after a new confirmation is rejected before admission (%s)",
  async (code) => {
    const x = await unknownConfirmation();
    await x.query(x.owner, "/other");
    vi.mocked(x.port.inspect).mockImplementation(async () =>
      pluginOperation(x.client.get(x.owner.agentId).request!, true),
    );
    const result = x.client.get(x.owner.agentId).result!;
    x.client.inspect(x.owner, result, result.catalog.items[0], true);
    await flush();
    const review = x.client.get(x.owner.agentId).review!;
    vi.mocked(x.port.confirm).mockRejectedValue({ code });
    x.client.confirm(x.owner, review);
    await flush();
    const rejected = x.client.get(x.owner.agentId);
    expect(rejected.unresolved).toBe(false);
    expect(rejected.operation).toBeNull();
    expect(rejected.error).toBe(code);
    expect(rejected.originalOperation).toBe(x.original);
    expect(x.client.confirm(x.owner, review)).toBe(false);
    expect(x.client.recheck(x.owner.agentId, rejected.request!.requestId)).toBe(
      true,
    );
    await flush();
    expect(vi.mocked(x.port.recheck).mock.calls[0][0].operationId).toBe(
      x.confirmation.requestId,
    );
    expect(x.client.get(x.owner.agentId).request?.target).toEqual(
      x.confirmation.target,
    );
    x.recheck.resolve({
      ...pluginOperation(x.client.get(x.owner.agentId).request!, true),
      state: "failed",
      code: "writeUncertain",
      outcome: "unknown",
    });
    await flush();
  },
);
