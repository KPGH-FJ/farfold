import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillChangeReview } from "../components/SkillChangeReview";
import { skillManagement } from "./skill_management_controller";
import { isRemoveRequest } from "./extension_management_types";
import {
  setup,
  operation,
  written,
  snapshot,
  id,
} from "./mcp_management.test-support";
import {
  setup as removeSetup,
  operation as removeOperation,
  written as removeWritten,
} from "./mcp_remove.test-support";
import {
  item as skillItem,
  operation as skillOperation,
} from "./skill_management.test-support";
import { deferred, flush } from "./extension_inventory.test-support";
import type { ExtensionChangeRequest } from "./extension_management_types";
import type { InventoryOwner } from "./extension_inventory_controller";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const observed = (request: ExtensionChangeRequest) =>
  isRemoveRequest(request)
    ? removeWritten(request, true)
    : written(request, true);

async function unknownWrite(remove = false) {
  vi.useFakeTimers();
  const h = remove ? await removeSetup() : await setup();
  vi.mocked(h.port.cancel).mockResolvedValue(null);
  expect(h.controller.inspect(h.target)).toBe(true);
  await flush();
  const inspection = h.controller.get(h.owner.agentId).request!;
  h.pending.inspect.resolve(
    remove ? removeOperation(inspection, true) : operation(inspection, true),
  );
  await flush();
  expect(
    h.controller.confirm(h.owner, h.controller.get(h.owner.agentId).review!),
  ).toBe(true);
  await flush();
  const request = h.controller.get(h.owner.agentId).request!;
  h.pending.confirm.resolve({
    ...observed(request),
    state: "failed",
    code: "writeUncertain",
    outcome: "unknown",
    observation: null,
  });
  await flush();
  const original = h.controller.get(h.owner.agentId).operation!;
  expect(original).toMatchObject({
    settled: true,
    writeDispatched: true,
    writeAck: "unknown",
    outcome: "unknown",
  });
  return { h, request, original };
}
type Harness = Awaited<ReturnType<typeof unknownWrite>>["h"];

async function nextReview(h: Harness, skills = false) {
  const owner: InventoryOwner = skills
    ? { agentId: h.owner.agentId, token: {}, current: () => true }
    : h.owner;
  const kind = skills ? "skills" : "mcp";
  vi.mocked(h.inventoryPort.read).mockImplementation(
    async ({ selectionId: _, ...request }) => ({
      ...request,
      state: "ready",
      settled: true,
      snapshot: skills
        ? {
            observedAtMs: 2,
            source: "officialAppServer",
            scope: "officialSkillsForDirectory",
            complete: true,
            errorCount: 0,
            sessionApplicability: "unverified",
            items: [{ ...skillItem, name: "new-skill" }],
          }
        : {
            ...snapshot,
            items: [{ ...snapshot.items[0], name: "new-mcp" }],
          },
    }),
  );
  expect(h.inventory.begin(owner, "/new-location", id, kind)).toBe(true);
  await flush();
  const result = h.inventory.get(owner.agentId).results[kind]!;
  const pending = deferred();
  const port = skills ? h.skills : h.port;
  vi.mocked(port.inspect).mockReturnValueOnce(pending.promise);
  expect(
    h.controller.inspect({
      owner,
      result,
      item: result.snapshot.items[0],
      requestedEnabled: false,
      current: () => h.inventory.isCurrentResult(owner, result),
      changed: () => h.inventory.markStale(result),
    }),
  ).toBe(true);
  await flush();
  const request = h.controller.get(owner.agentId).request!;
  const ready = skills
    ? skillOperation(request, "ready")
    : operation(request, true);
  return { owner, result, pending, port, request, ready };
}

it.each([false, true])(
  "keeps the actual write and explicit readback after a read-only review (failed=%s)",
  async (failed) => {
    const { h, request, original } = await unknownWrite();
    const next = await nextReview(h);
    next.pending.resolve(
      failed
        ? {
            ...next.ready,
            state: "failed",
            code: "configurationChanged",
            review: null,
          }
        : next.ready,
    );
    await flush();
    expect(h.controller.get(h.owner.agentId).originalOperation).toBe(original);
    expect(h.port.recheck).not.toHaveBeenCalled();
    const current = h.controller.get(h.owner.agentId).request!;
    expect(h.controller.recheck(h.owner.agentId, current.requestId)).toBe(true);
    await flush();
    const readback = h.controller.get(h.owner.agentId).request!;
    expect(readback).toMatchObject({
      action: "recheck",
      operationId: request.requestId,
      target: request.target,
      cwd: "/controlled",
    });
    expect(readback.requestId).not.toBe(request.requestId);
    h.pending.recheck.resolve(observed(readback));
    await flush();
    expect(h.controller.get(h.owner.agentId)).toMatchObject({
      unresolved: false,
      operation: { outcome: "observed", writeAck: "unknown" },
      originalOperation: original,
      review: null,
    });
    expect(h.inventory.get(h.owner.agentId).results.mcp).toBe(next.result);
    expect(next.result.stale).toBe(false);
    expect(h.port.confirm).toHaveBeenCalledTimes(1);
    h.close();
  },
);

it.each([false, true])(
  "retains the original endpoint and removal constraints after selecting skills (remove=%s)",
  async (remove) => {
    const { h, request, original } = await unknownWrite(remove);
    const next = await nextReview(h, true);
    next.pending.resolve(next.ready);
    await flush();
    expect(h.controller.recheck(h.owner.agentId, next.request.requestId)).toBe(
      true,
    );
    await flush();
    const readback = h.controller.get(h.owner.agentId).request!;
    expect(h.port.recheck).toHaveBeenCalledExactlyOnceWith({
      agentId: request.agentId,
      requestId: readback.requestId,
      operationId: request.requestId,
    });
    expect(h.skills.recheck).not.toHaveBeenCalled();
    expect(h.skills.cancel).toHaveBeenCalledExactlyOnceWith({
      agentId: next.owner.agentId,
      requestId: next.request.requestId,
    });
    expect(h.port.cancel).not.toHaveBeenCalledWith({
      agentId: next.owner.agentId,
      requestId: next.request.requestId,
    });
    expect(readback.target).toEqual(request.target);
    expect(readback.cwd).toBe(request.cwd);
    const receipt = observed(readback);
    h.pending.recheck.resolve(
      remove
        ? {
            ...receipt,
            observation: {
              ...receipt.observation,
              parentOutcome: "nonempty",
            },
          }
        : receipt,
    );
    await flush();
    expect(h.controller.get(h.owner.agentId)).toMatchObject({
      unresolved: remove,
      ...(remove ? { error: "invalidOutput" } : {}),
      originalOperation: original,
      review: null,
    });
    expect(h.inventory.get(h.owner.agentId).results.skills).toBe(next.result);
    expect(next.result.stale).toBe(false);
    expect(h.port.confirm).toHaveBeenCalledTimes(1);
    expect(h.skills.confirm).not.toHaveBeenCalled();
    h.controller.retire(next.owner);
    h.close();
  },
);

it("keeps the previous actual write when a new confirmation is rejected before admission", async () => {
  const { h, request, original } = await unknownWrite();
  const next = await nextReview(h);
  next.pending.resolve(next.ready);
  await flush();
  const review = h.controller.get(h.owner.agentId).review!;
  vi.mocked(h.port.confirm).mockRejectedValueOnce({ code: "reviewExpired" });
  expect(h.controller.confirm(h.owner, review)).toBe(true);
  await flush();
  expect(h.controller.get(h.owner.agentId)).toMatchObject({
    admissionRejected: true,
    unresolved: false,
    originalOperation: original,
  });
  const current = h.controller.get(h.owner.agentId).request!;
  expect(h.controller.recheck(h.owner.agentId, current.requestId)).toBe(true);
  await flush();
  expect(h.port.recheck).toHaveBeenCalledWith({
    agentId: h.owner.agentId,
    requestId: h.controller.get(h.owner.agentId).request!.requestId,
    operationId: request.requestId,
  });
  expect(h.port.confirm).toHaveBeenCalledTimes(2);
  h.close();
});

it("reports an unavailable original target without redirecting readback to the new skill selection", async () => {
  const { h, request, original } = await unknownWrite();
  const next = await nextReview(h, true);
  next.pending.resolve(next.ready);
  await flush();
  h.controller.recheck(h.owner.agentId, next.request.requestId);
  await flush();
  const readback = h.controller.get(h.owner.agentId).request!;
  h.pending.recheck.resolve({
    ...observed(readback),
    state: "failed",
    code: "targetUnavailable",
    outcome: "unknown",
    observation: null,
  });
  await flush();
  expect(h.controller.get(h.owner.agentId)).toMatchObject({
    unresolved: false,
    error: "targetUnavailable",
    request: { operationId: request.requestId, target: request.target },
    originalOperation: original,
    review: null,
  });
  expect(h.skills.recheck).not.toHaveBeenCalled();
  expect(h.skills.confirm).not.toHaveBeenCalled();
  expect(h.port.confirm).toHaveBeenCalledTimes(1);
  expect(h.inventory.get(h.owner.agentId).results.skills).toBe(next.result);
  h.controller.retire(next.owner);
  h.close();
});

it("a cancelled re-review and its late receipt cannot erase the write or regrant confirmation", async () => {
  const { h, original } = await unknownWrite();
  const next = await nextReview(h);
  const cancel = deferred();
  vi.mocked(h.port.cancel).mockReturnValueOnce(cancel.promise);
  h.controller.cancel(h.owner.agentId, next.request.requestId);
  await flush();
  cancel.resolve({
    agentId: h.owner.agentId,
    requestId: next.request.requestId,
    cancelRequested: true,
    operation: {
      ...next.ready,
      state: "cancelled",
      code: "cancelled",
      review: null,
    },
  });
  await flush();
  next.pending.resolve(next.ready);
  await flush();
  expect(h.controller.get(h.owner.agentId)).toMatchObject({
    unresolved: false,
    review: null,
    operation: { state: "cancelled" },
    originalOperation: original,
  });
  expect(h.controller.confirm(h.owner, next.ready.review!)).toBe(false);
  expect(h.port.confirm).toHaveBeenCalledTimes(1);
  expect(h.controller.recheck(h.owner.agentId, next.request.requestId)).toBe(
    true,
  );
  await flush();
  h.close();
});

it("replaces the retained write only after a new explicitly confirmed write is actually reported", async () => {
  const { h, original } = await unknownWrite();
  const next = await nextReview(h);
  next.pending.resolve(next.ready);
  await flush();
  expect(h.controller.get(h.owner.agentId).originalOperation).toBe(original);
  const confirm = deferred();
  vi.mocked(h.port.confirm).mockReturnValueOnce(confirm.promise);
  h.controller.confirm(h.owner, h.controller.get(h.owner.agentId).review!);
  await flush();
  expect(h.controller.get(h.owner.agentId).originalOperation).toBe(original);
  const request = h.controller.get(h.owner.agentId).request!;
  confirm.resolve(written(request));
  await flush();
  const latest = h.controller.get(h.owner.agentId).operation!;
  expect(latest.target.name).toBe("new-mcp");
  expect(h.controller.get(h.owner.agentId).originalOperation).toBe(latest);
  expect(h.controller.recheck(h.owner.agentId, request.requestId)).toBe(true);
  await flush();
  expect(h.port.recheck).toHaveBeenCalledWith({
    agentId: h.owner.agentId,
    requestId: h.controller.get(h.owner.agentId).request!.requestId,
    operationId: request.requestId,
  });
  expect(h.port.confirm).toHaveBeenCalledTimes(2);
  h.close();
});

it("shows the prior target and uncertainty separately from the current read-only review", async () => {
  const { h, original } = await unknownWrite();
  const next = await nextReview(h);
  next.pending.resolve(next.ready);
  await flush();
  vi.spyOn(skillManagement, "get").mockImplementation(h.controller.get);
  vi.spyOn(skillManagement, "canConfirm").mockImplementation((owner, review) =>
    h.controller.canConfirm(owner, review),
  );
  const html = renderToStaticMarkup(
    <SkillChangeReview agentId={h.owner.agentId} owner={h.owner} active />,
  );
  expect(html).toContain("new-mcp");
  expect(html).toContain(original.target.name);
  expect(html).toContain(original.cwd);
  expect(html).toContain("此前修改结果仍未确认");
  expect(html).toContain("核对修改结果");
  expect(html).not.toContain("均已核对为所选状态");
  expect(h.port.confirm).toHaveBeenCalledTimes(1);
  h.close();
});
