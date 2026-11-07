import { afterEach, expect, it, vi } from "vitest";
import { flush } from "./extension_inventory.test-support";
import { requestForTarget } from "./extension_management_types";
import {
  setup,
  reviewed,
  operation,
  written,
  iid,
  displayPath,
} from "./skill_preference_remove.test-support";
import type { ExtensionChangeTargetOwner } from "./extension_management_types";

afterEach(() => vi.useRealTimers());

it("an absent preference inspection grants no removal or confirmation", async () => {
  const h = await setup();
  h.controller.inspect(h.target);
  await flush();
  const request = h.controller.get("fixture").request!;
  h.pending.inspect.resolve({
    ...operation(request),
    state: "failed",
    phase: "complete",
    settled: true,
    outcome: "notDispatched",
    code: "preferenceNotConfigured",
  });
  await flush();
  expect(h.controller.get("fixture")).toMatchObject({
    unresolved: false,
    review: null,
    error: "preferenceNotConfigured",
    operation: { writeDispatched: false, outcome: "notDispatched" },
  });
  expect(h.controller.confirm(h.owner, operation(request, true).review!)).toBe(
    false,
  );
  expect(h.port.confirm).not.toHaveBeenCalled();
  expect(h.port.recheck).not.toHaveBeenCalled();
});

it("retains the precise absent preference code on a direct inspection failure", async () => {
  const h = await setup();
  h.controller.inspect(h.target);
  await flush();
  h.pending.inspect.reject({ code: "preferenceNotConfigured" });
  await flush();
  expect(h.controller.get("fixture")).toMatchObject({
    review: null,
    error: "preferenceNotConfigured",
  });
  expect(h.port.confirm).not.toHaveBeenCalled();
});

it("routes reviewed removal through its own port and preserves disabled actual state", async () => {
  const h = await setup();
  const review = await reviewed(h);
  expect(h.port.inspect).toHaveBeenCalledWith({
    agentId: "fixture",
    requestId: expect.any(String),
    inventoryRequestId: iid,
    itemId: 0,
  });
  expect(h.legacy.inspect).not.toHaveBeenCalled();
  expect(h.controller.confirm(h.owner, review)).toBe(true);
  await flush();
  const r = h.controller.get("fixture").request!;
  expect(r).toMatchObject({
    action: "remove",
    requestedEnabled: null,
    target: {
      kind: "skillPreferenceRemoval",
      displayPath,
    },
  });
  h.pending.confirm.resolve(written(r));
  await flush();
  expect(h.controller.get("fixture")).toMatchObject({
    unresolved: false,
    operation: {
      outcome: "verified",
      observation: { skill: "reported", reportedEnabled: false },
    },
  });
  expect(h.inventory.get("fixture").results.skills?.stale).toBe(true);
  expect(h.legacy.confirm).not.toHaveBeenCalled();
});

it("rejects stale, wrong domain, extra roots and ineligible target before IPC", async () => {
  const h = await setup();
  expect(
    h.controller.inspect({ ...h.target, item: { ...h.target.item } }),
  ).toBe(false);
  expect(
    h.controller.inspect({
      ...h.target,
      result: { ...h.result, request: { ...h.result.request, kind: "mcp" } },
    }),
  ).toBe(false);
  expect(
    h.controller.inspect({
      ...h.target,
      result: {
        ...h.result,
        request: { ...h.result.request, extraSkillRoots: ["/extra"] },
      },
    }),
  ).toBe(false);
  expect(
    h.controller.inspect({ ...h.target, result: { ...h.result, stale: true } }),
  ).toBe(false);
  for (const patch of [
    { origin: "system" },
    { pluginReported: true },
    { enablement: { availability: "unavailable", reason: "pluginManaged" } },
  ]) {
    const item = { ...h.target.item, ...patch };
    const result = {
      ...h.result,
      snapshot: { ...h.result.snapshot, items: [item] },
    };
    expect(
      requestForTarget(
        { ...h.target, item, result } as ExtensionChangeTargetOwner,
        iid,
      ),
    ).toBeNull();
  }
  expect(h.port.inspect).not.toHaveBeenCalled();
  h.close();
  expect(h.controller.inspect(h.target)).toBe(false);
});

it("retiring the owner cancels its inspection and prevents late review authority", async () => {
  const h = await setup();
  h.controller.inspect(h.target);
  await flush();
  const r = h.controller.get("fixture").request!;
  h.close();
  h.pending.inspect.resolve(operation(r, true));
  await flush();
  const view = h.controller.get("fixture");
  expect(view.review).toBeNull();
  expect(view.reviewRetired).toBe(true);
  expect(h.port.cancel).toHaveBeenCalledWith({
    agentId: "fixture",
    requestId: r.requestId,
  });
  expect(h.port.confirm).not.toHaveBeenCalled();
});

it("keeps an unknown write and observes it without another removal", async () => {
  const h = await setup();
  const review = await reviewed(h);
  h.controller.confirm(h.owner, review);
  await flush();
  const remove = h.controller.get("fixture").request!;
  h.pending.confirm.resolve(written(remove, true));
  await flush();
  const prior = h.controller.get("fixture").operation;
  expect(prior).toMatchObject({ outcome: "unknown", writeAck: "unknown" });
  expect(h.controller.recheck("fixture", remove.requestId)).toBe(true);
  await flush();
  const recheck = h.controller.get("fixture").request!;
  expect(h.port.recheck).toHaveBeenCalledWith({
    agentId: "fixture",
    requestId: recheck.requestId,
    operationId: remove.requestId,
  });
  h.pending.recheck.resolve({ ...written(recheck), writeAck: "unknown" });
  await flush();
  expect(h.controller.get("fixture")).toMatchObject({
    originalOperation: prior,
    operation: {
      outcome: "observed",
      writeAck: "unknown",
      observation: { reportedEnabled: false },
    },
  });
  expect(h.port.confirm).toHaveBeenCalledTimes(1);
  expect(h.port.inspect).toHaveBeenCalledTimes(1);
});

it.each(["writeAck", "parentOutcome"])(
  "rejects recheck replies that replace %s facts",
  async (changedFact) => {
    const h = await setup();
    h.controller.confirm(h.owner, await reviewed(h));
    await flush();
    const remove = h.controller.get("fixture").request!;
    h.pending.confirm.resolve(written(remove, true));
    await flush();
    h.controller.recheck("fixture", remove.requestId);
    await flush();
    const r = h.controller.get("fixture").request!;
    const observed = written(r);
    h.pending.recheck.resolve(
      changedFact === "writeAck"
        ? observed
        : {
            ...observed,
            writeAck: "unknown",
            observation: { ...observed.observation, parentOutcome: "empty" },
          },
    );
    await flush();
    expect(h.controller.get("fixture")).toMatchObject({
      unresolved: true,
      error: "invalidOutput",
      originalOperation: { outcome: "unknown", writeAck: "unknown" },
    });
    expect(h.port.confirm).toHaveBeenCalledTimes(1);
  },
);

it("a lost confirm is checked by status, never redispatched", async () => {
  const h = await setup();
  const review = await reviewed(h);
  vi.useFakeTimers();
  h.controller.confirm(h.owner, review);
  await flush();
  const remove = h.controller.get("fixture").request!;
  await vi.advanceTimersByTimeAsync(100);
  expect(h.controller.get("fixture")).toMatchObject({
    unresolved: true,
    error: "timedOut",
  });
  expect(h.controller.confirm(h.owner, review)).toBe(false);
  h.controller.check("fixture", remove.requestId);
  await flush();
  h.pending.status.resolve(written(remove, true));
  await flush();
  expect(h.controller.get("fixture")).toMatchObject({
    unresolved: false,
    originalOperation: { outcome: "unknown" },
  });
  expect(h.port.confirm).toHaveBeenCalledTimes(1);
  expect(h.port.status).toHaveBeenCalledTimes(1);
});
