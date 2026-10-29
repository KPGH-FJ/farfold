import { afterEach, expect, it, vi } from "vitest";
import { flush } from "./extension_inventory.test-support";
import {
  setup,
  reviewed,
  operation,
  written,
  input,
} from "./mcp_add.test-support";
import { setup as mcpSetup } from "./mcp_management.test-support";
afterEach(() => vi.useRealTimers());
it("sends a syntactically valid name for connection-layer admission and retains a bare refusal without confirming", async () => {
  const h = await setup(true);
  const value = { ...input, name: "codex_apps" };
  expect(h.controller.inspect({ ...h.target, input: value })).toBe(true);
  await flush();
  expect(h.port.inspect).toHaveBeenCalledExactlyOnceWith({
    agentId: h.owner.agentId,
    requestId: h.controller.get(h.owner.agentId).request!.requestId,
    inventoryRequestId: h.result.request.requestId,
    inputId: h.target.inputId,
    input: value,
  });
  h.pending.inspect.reject({ code: "invalidName" });
  await flush();
  expect(h.controller.get(h.owner.agentId)).toMatchObject({
    error: "invalidName",
    unresolved: true,
    review: null,
  });
  expect(h.port.confirm).not.toHaveBeenCalled();
  expect(h.port.inspect).toHaveBeenCalledTimes(1);
});
it("admits complete empty catalogue and sends exact input only at inspect, separate confirm only reviewId", async () => {
  const h = await setup(true),
    review = await reviewed(h);
  expect(h.port.inspect).toHaveBeenCalledExactlyOnceWith({
    agentId: h.owner.agentId,
    requestId: h.controller.get(h.owner.agentId).request!.requestId,
    inventoryRequestId: h.result.request.requestId,
    inputId: h.target.inputId,
    input,
  });
  expect(h.port.confirm).not.toHaveBeenCalled();
  expect(h.controller.confirm(h.owner, review)).toBe(true);
  expect(h.controller.confirm(h.owner, review)).toBe(false);
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  expect(r.action).toBe("add");
  expect(h.port.confirm).toHaveBeenCalledExactlyOnceWith({
    agentId: h.owner.agentId,
    requestId: r.requestId,
    reviewId: review.reviewId,
  });
  h.pending.confirm.resolve(written(r));
  await flush();
  expect(h.controller.get(h.owner.agentId).operation?.outcome).toBe("verified");
});
it("copies original form input and retires its inspection before edited A-B-A can confirm", async () => {
  const h = await setup(),
    args = ["a"],
    target = { ...h.target, input: { ...input, args } };
  h.controller.inspect(target);
  args[0] = "B";
  await flush();
  expect(h.controller.get(h.owner.agentId).additionInput).toEqual({
    ...input,
    args: ["a"],
  });
  h.pending.inspect.resolve(
    operation(h.controller.get(h.owner.agentId).request!, true),
  );
  await flush();
  const review = h.controller.get(h.owner.agentId).review!;
  h.controller.retireAddition(h.owner, target.inputId);
  args[0] = "a";
  expect(h.controller.confirm(h.owner, review)).toBe(false);
  expect(h.port.confirm).not.toHaveBeenCalled();
  await flush();
  expect(h.port.cancel).toHaveBeenCalled();
});
it("late review after close cannot revive confirmation and remains in its original endpoint", async () => {
  const h = await setup();
  h.controller.inspect(h.target);
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  h.retire();
  h.pending.inspect.resolve(operation(r, true));
  await flush();
  expect(h.controller.get(h.owner.agentId).review).toBeNull();
  expect(h.port.cancel).toHaveBeenCalledWith({
    agentId: r.agentId,
    requestId: r.requestId,
  });
  expect(h.skills.cancel).not.toHaveBeenCalled();
});
it("shares one per-Agent flight with other management types and rejects stale/incomplete sources", async () => {
  const h = await setup(),
    m = await mcpSetup();
  expect(
    h.controller.inspect({ ...h.target, result: { ...h.result, stale: true } }),
  ).toBe(false);
  expect(
    h.controller.inspect({
      ...h.target,
      result: { ...h.result, request: { ...h.result.request, kind: "skills" } },
    }),
  ).toBe(false);
  h.controller.inspect(h.target);
  await flush();
  expect(h.controller.inspect(m.target)).toBe(false);
  h.pending.inspect.resolve(
    operation(h.controller.get(h.owner.agentId).request!, true),
  );
  await flush();
  expect(h.controller.inspect(m.target)).toBe(true);
  await flush();
  expect(h.enablePort.inspect).toHaveBeenCalledTimes(1);
  expect(m.port.inspect).not.toHaveBeenCalled(); // Original controller's MCP port is used, never a new registry.
});
it("write unknown permits only explicit readonly recheck; same-false argument mismatch remains mismatch", async () => {
  const h = await setup(),
    review = await reviewed(h);
  h.controller.confirm(h.owner, review);
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  h.pending.confirm.resolve({
    ...written(r, true),
    state: "failed",
    code: "writeUncertain",
    observation: null,
  });
  await flush();
  expect(h.controller.recheck(h.owner.agentId, r.requestId)).toBe(true);
  await flush();
  const check = h.controller.get(h.owner.agentId).request!;
  h.pending.recheck.resolve({
    ...written(check, true),
    outcome: "mismatch",
    observation: { ...written(check, true).observation, mcp: "different" },
  });
  await flush();
  expect(h.controller.get(h.owner.agentId).operation).toMatchObject({
    writeAck: "unknown",
    outcome: "mismatch",
    observation: { reportedEnabled: false, mcp: "different" },
  });
  expect(h.port.confirm).toHaveBeenCalledTimes(1);
});
it("bare input rejection stays unknown until exact explicit absence response; late review never resurrects", async () => {
  const h = await setup();
  h.controller.inspect(h.target);
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  h.pending.inspect.reject({ code: "invalidArguments" });
  await flush();
  expect(h.controller.get(h.owner.agentId)).toMatchObject({
    unresolved: true,
    error: "invalidArguments",
  });
  h.controller.check(h.owner.agentId, r.requestId);
  await flush();
  h.pending.status.reject({ code: "unknownRequest" });
  await flush();
  h.controller.cancel(h.owner.agentId, r.requestId);
  await flush();
  h.pending.cancel.resolve({
    agentId: r.agentId,
    requestId: r.requestId,
    cancelRequested: true,
    operation: null,
  });
  await flush();
  expect(h.controller.get(h.owner.agentId)).toMatchObject({
    unresolved: false,
    trackingReleased: true,
    review: null,
  });
});
it("timeout never releases tracking or retries write", async () => {
  vi.useFakeTimers();
  const h = await setup(),
    review = await reviewed(h);
  h.controller.confirm(h.owner, review);
  await flush();
  await vi.advanceTimersByTimeAsync(101);
  expect(h.controller.get(h.owner.agentId)).toMatchObject({
    unresolved: true,
    error: "timedOut",
  });
  expect(h.controller.confirm(h.owner, review)).toBe(false);
  expect(h.port.confirm).toHaveBeenCalledTimes(1);
  h.retire();
});
