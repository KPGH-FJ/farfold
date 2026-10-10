import { afterEach, expect, it, vi } from "vitest";
import { flush } from "./extension_inventory.test-support";
import {
  setup,
  reviewed,
  operation,
  written,
} from "./mcp_management.test-support";
import { setup as skillsSetup } from "./skill_management.test-support";
afterEach(() => vi.useRealTimers());
it.each([true, false])(
  "sends the explicit requested MCP preference %s rather than deriving it from the report",
  async (enabled) => {
    const h = await setup();
    expect(
      h.controller.inspect({ ...h.target, requestedEnabled: enabled }),
    ).toBe(true);
    await flush();
    expect(h.port.inspect).toHaveBeenCalledWith(
      expect.objectContaining({ enabled }),
    );
    const r = h.controller.get(h.owner.agentId).request!;
    expect(r.requestedEnabled).toBe(enabled);
    h.pending.inspect.resolve(operation(r, true));
    await flush();
    expect(h.controller.get(h.owner.agentId).review?.requestedEnabled).toBe(
      enabled,
    );
    expect(h.port.confirm).not.toHaveBeenCalled();
  },
);
it("does not turn the backend's configuration disagreement refusal into a review", async () => {
  const h = await setup();
  h.controller.inspect({ ...h.target, requestedEnabled: true });
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  h.pending.inspect.resolve({
    ...operation(r),
    state: "failed",
    phase: "complete",
    settled: true,
    code: "configurationChanged",
  });
  await flush();
  expect(h.controller.get(h.owner.agentId).review).toBeNull();
  expect(h.port.confirm).not.toHaveBeenCalled();
});
it("requires one separate confirmation and sends no configuration authority", async () => {
  const h = await setup(),
    r = await reviewed(h);
  expect(h.port.confirm).not.toHaveBeenCalled();
  expect(h.skills.inspect).not.toHaveBeenCalled();
  expect(h.port.inspect).toHaveBeenCalledExactlyOnceWith({
    agentId: h.owner.agentId,
    requestId: h.controller.get(h.owner.agentId).request!.requestId,
    inventoryRequestId: h.result.request.requestId,
    itemId: 0,
    enabled: false,
  });
  expect(h.controller.confirm(h.owner, r)).toBe(true);
  expect(h.controller.confirm(h.owner, r)).toBe(false);
  await flush();
  const request = h.controller.get(h.owner.agentId).request!;
  expect(h.port.confirm).toHaveBeenCalledExactlyOnceWith({
    agentId: request.agentId,
    requestId: request.requestId,
    reviewId: r.reviewId,
  });
  h.pending.confirm.resolve(written(request));
  await flush();
  expect(h.controller.get(h.owner.agentId).operation?.outcome).toBe("verified");
  expect(h.inventory.get(h.owner.agentId).results.mcp?.stale).toBe(true);
});
it("retired ownership never revives a delayed review and cancellation uses its original domain", async () => {
  const h = await setup();
  h.controller.inspect(h.target);
  await flush();
  const request = h.controller.get(h.owner.agentId).request!;
  h.close();
  h.pending.inspect.resolve(operation(request, true));
  await flush();
  expect(h.controller.get(h.owner.agentId).review).toBeNull();
  expect(h.port.cancel).toHaveBeenCalledWith({
    agentId: request.agentId,
    requestId: request.requestId,
  });
  expect(h.skills.cancel).not.toHaveBeenCalled();
});
it("holds the one shared per-Agent flight across skill/MCP switches", async () => {
  const h = await setup();
  h.controller.inspect(h.target);
  await flush();
  const s = await skillsSetup();
  const owner = { ...s.owner, agentId: h.owner.agentId };
  const result = {
    ...s.result,
    owner,
    request: { ...s.result.request, agentId: owner.agentId },
  };
  const target = { ...s.target, owner, result, current: () => true };
  expect(h.controller.inspect(target)).toBe(false);
  expect(h.skills.inspect).not.toHaveBeenCalled();
  h.pending.inspect.resolve(
    operation(h.controller.get(h.owner.agentId).request!, true),
  );
  await flush();
  expect(h.controller.inspect(target)).toBe(true);
  await flush();
  expect(h.port.cancel).toHaveBeenCalled();
  expect(h.skills.inspect).toHaveBeenCalledTimes(1);
});
it("lost write acknowledgement permits only explicit new-ID readonly recheck", async () => {
  const h = await setup(),
    r = await reviewed(h);
  h.controller.confirm(h.owner, r);
  await flush();
  const write = h.controller.get(h.owner.agentId).request!;
  h.pending.confirm.resolve({
    ...written(write, true),
    state: "failed",
    code: "writeUncertain",
    observation: null,
  });
  await flush();
  expect(h.controller.recheck(h.owner.agentId, write.requestId)).toBe(true);
  await flush();
  const check = h.controller.get(h.owner.agentId).request!;
  expect(check.operationId).toBe(write.requestId);
  expect(check.requestId).not.toBe(write.requestId);
  h.pending.recheck.resolve(written(check, true));
  await flush();
  expect(h.controller.get(h.owner.agentId).operation).toMatchObject({
    outcome: "observed",
    writeAck: "unknown",
  });
  expect(h.port.confirm).toHaveBeenCalledTimes(1);
  expect(h.skills.recheck).not.toHaveBeenCalled();
});
it("observer timeout and late status cannot regrant confirmation after close", async () => {
  vi.useFakeTimers();
  const h = await setup();
  h.controller.inspect(h.target);
  await flush();
  await vi.advanceTimersByTimeAsync(101);
  const request = h.controller.get(h.owner.agentId).request!;
  expect(h.controller.get(h.owner.agentId).unresolved).toBe(true);
  h.close();
  h.controller.check(h.owner.agentId, request.requestId);
  await flush();
  h.pending.status.resolve(operation(request, true));
  await flush();
  expect(h.controller.get(h.owner.agentId).review).toBeNull();
  expect(h.port.confirm).not.toHaveBeenCalled();
});
it("does not grant review to a cloned row, stale report or legacy report", async () => {
  const h = await setup();
  expect(
    h.controller.inspect({ ...h.target, requestedEnabled: undefined }),
  ).toBe(false);
  expect(
    h.controller.inspect({ ...h.target, item: { ...h.target.item } }),
  ).toBe(false);
  expect(
    h.controller.inspect({ ...h.target, result: { ...h.result, stale: true } }),
  ).toBe(false);
  const { enablement: _, ...item } = h.target.item;
  expect(h.controller.inspect({ ...h.target, item })).toBe(false);
  await flush();
  expect(h.port.inspect).not.toHaveBeenCalled();
});
it("revokes the original MCP map and never lets a retained report revoke a new query", async () => {
  const h = await setup();
  const old = h.result;
  expect(h.inventory.isCurrentResult(h.owner, old)).toBe(true);
  h.inventory.begin(h.owner, "/controlled", old.request.requestId, "mcp");
  await flush();
  const current = h.inventory.get(h.owner.agentId).results.mcp!;
  expect(h.inventoryPort.cancel).toHaveBeenCalledExactlyOnceWith(old.request);
  expect(h.inventory.isCurrentResult(h.owner, old)).toBe(false);
  expect(h.inventory.isCurrentResult(h.owner, current)).toBe(true);
  h.inventory.markStale(old);
  await flush();
  expect(h.inventoryPort.cancel).toHaveBeenCalledTimes(1);
  expect(h.inventory.get(h.owner.agentId).results.mcp).toBe(current);
  h.inventory.retire(h.owner);
  await flush();
  expect(h.inventoryPort.cancel).toHaveBeenLastCalledWith(current.request);
  expect(h.inventory.get(h.owner.agentId).results.mcp?.stale).toBe(true);
});
