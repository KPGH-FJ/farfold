import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ExtensionInventoryController,
  type InventoryOwner,
} from "../../../../../src/runtime/extension_inventory_controller";
import type { InventoryPort } from "../../../../../src/runtime/extension_inventory";
import {
  deferred,
  flush,
  ready,
} from "../../../../../src/runtime/extension_inventory.test-support";

const selectionId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function setup() {
  const lateRead = deferred();
  const cancellation = deferred();
  let live = true;
  let sequence = 0;
  const owner: InventoryOwner = {
    agentId: "fixture-agent",
    token: {},
    current: () => live,
  };
  const port = {
    read: vi.fn<InventoryPort["read"]>(() => lateRead.promise),
    status: vi.fn<InventoryPort["status"]>(() =>
      Promise.reject({ code: "unknownRequest" }),
    ),
    cancel: vi.fn<InventoryPort["cancel"]>(() => cancellation.promise),
  } satisfies InventoryPort;
  const client = new ExtensionInventoryController(
    port,
    100,
    () => `aaaaaaaa-aaaa-aaaa-aaaa-${String(++sequence).padStart(12, "0")}`,
  );
  return {
    client,
    owner,
    port,
    lateRead,
    cancellation,
    close: () => {
      live = false;
      client.retire(owner);
    },
  };
}
async function unknown(h: ReturnType<typeof setup>) {
  expect(h.client.begin(h.owner, "/controlled/project", selectionId)).toBe(
    true,
  );
  await flush();
  await vi.advanceTimersByTimeAsync(101);
  const request = h.client.get(h.owner.agentId).request!;
  h.client.check(request.agentId, request.requestId);
  await flush();
  expect(h.client.get(request.agentId).error).toBe("unknownRequest");
  return request;
}
it("explicit exact absent cancellation ends expired tracking without claiming cancellation or applying late success", async () => {
  const h = setup();
  // An older accepted inventory stays visible only as stale context.
  h.port.read.mockImplementationOnce(async ({ agentId, cwd, requestId }) =>
    ready({ agentId, cwd, requestId }),
  );
  h.client.begin(h.owner, "/old/project", selectionId);
  await flush();
  const oldResult = h.client.get(h.owner.agentId).result;
  expect(oldResult?.cwd).toBe("/old/project");
  const request = await unknown(h);
  h.client.cancel(request.agentId, request.requestId); // Explicit user action, not retire().
  h.cancellation.resolve({
    agentId: request.agentId,
    requestId: request.requestId,
    cancelRequested: true,
    operation: null,
  });
  await flush();
  const ended = h.client.get(request.agentId);
  expect(ended.unresolved).toBe(false);
  expect(ended.error).toBe("unknownRequest");
  expect(ended.operation?.state).not.toBe("cancelled");
  expect(ended.result).toBe(oldResult);
  expect(ended.stale).toBe(true);
  expect(h.port.read).toHaveBeenCalledTimes(2);
  h.lateRead.resolve(ready(request));
  await flush();
  expect(h.client.get(request.agentId).result).toBe(oldResult);
  expect(h.client.get(request.agentId).error).toBe("unknownRequest");
  expect(
    h.client.begin(
      { ...h.owner, token: {} },
      "/explicit/successor",
      selectionId,
    ),
  ).toBe(true);
});
it("unknown status alone remains uncertain and does not dispatch a successor", async () => {
  const h = setup();
  await unknown(h);
  expect(h.client.get(h.owner.agentId).unresolved).toBe(true);
  expect(h.client.begin(h.owner, "/new/project", selectionId)).toBe(false);
  expect(h.port.read).toHaveBeenCalledTimes(1);
});
it("automatic close cancellation cannot grant recovery to a new owner", async () => {
  const h = setup();
  const request = await unknown(h);
  h.close();
  h.cancellation.resolve({
    agentId: request.agentId,
    requestId: request.requestId,
    cancelRequested: true,
    operation: null,
  });
  await flush();
  expect(h.client.get(request.agentId).unresolved).toBe(true);
  const replacement = {
    agentId: request.agentId,
    token: {},
    current: () => true,
  };
  expect(h.client.begin(replacement, "/new/project", selectionId)).toBe(false);
});
for (const wrong of ["agentId", "requestId", "cancelRequested"] as const) {
  it(`rejects malformed absent cancellation field ${wrong}`, async () => {
    const h = setup();
    const request = await unknown(h);
    h.client.cancel(request.agentId, request.requestId);
    h.cancellation.resolve({
      agentId: request.agentId,
      requestId: request.requestId,
      cancelRequested: true,
      operation: null,
      [wrong]: wrong === "cancelRequested" ? false : "not-the-request",
    });
    await flush();
    expect(h.client.get(request.agentId).unresolved).toBe(true);
    expect(h.client.get(request.agentId).result).toBeNull();
    expect(h.client.begin(h.owner, "/new/project", selectionId)).toBe(false);
  });
}
