import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ExtensionInventoryController } from "../../../../../src/runtime/extension_inventory_controller";
import { SkillManagementController } from "../../../../../src/runtime/skill_management_controller";
import {
  parseExtensionCapabilities,
  parseInventoryOperation,
} from "../../../../../src/runtime/extension_inventory_types";
import {
  parseSkillChangeOperation,
  parseSkillChangeCancellation,
} from "../../../../../src/runtime/skill_management_types";
const wire = JSON.parse(
  readFileSync(
    "docs/evidence/2026-10-09-capability-hardening/skill-management/backend/final-wire.json",
    "utf8",
  ),
);
const ops = Object.fromEntries(
  wire.operations.map((x: any) => [x.label, x.value]),
);
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
it("final Rust serialization remains compatible with frozen parsers and exact controller flows", async () => {
  expect(parseExtensionCapabilities(wire.capabilities)).toEqual(
    wire.capabilities,
  );
  expect(parseInventoryOperation(wire.inventory, wire.inventory)).toEqual(
    wire.inventory,
  );
  for (const { value } of wire.operations)
    expect(parseSkillChangeOperation(value, value)).toEqual(value);
  for (const value of wire.cancellations)
    expect(
      parseSkillChangeCancellation(value, value.operation ?? value),
    ).toEqual(value.operation);
  for (const unknown of [false, true]) {
    const inspected =
        ops[unknown ? "confirmUnknownInspection" : "inspectReady"],
      confirmed = ops[unknown ? "confirmUnknown" : "confirmVerified"],
      checked = ops[unknown ? "unknownReadonlyObserved" : "readonlyObserved"];
    const ids = [inspected.requestId, confirmed.requestId, checked.requestId];
    const owner = {
      agentId: wire.inventory.agentId,
      token: {},
      current: () => true,
    };
    const inventory = new ExtensionInventoryController(
      {
        read: async () => wire.inventory,
        status: async () => wire.inventory,
        cancel: async (r) => ({
          ...r,
          cancelRequested: true,
          operation: wire.inventory,
        }),
      },
      1000,
      () => wire.inventory.requestId,
    );
    expect(
      inventory.begin(
        owner,
        wire.inventory.cwd,
        wire.inventory.requestId,
        "skills",
      ),
    ).toBe(true);
    await flush();
    const result = inventory.get(owner.agentId).result!;
    let writes = 0;
    const controller = new SkillManagementController(
      {
        inspect: async (r) => {
          expect(r.inventoryRequestId).toBe(wire.inventory.requestId);
          return inspected;
        },
        confirm: async (r) => {
          writes++;
          expect(r.reviewId).toBe(inspected.review.reviewId);
          return confirmed;
        },
        status: async () => confirmed,
        cancel: async (r) => ({ ...r, cancelRequested: true, operation: null }),
        recheck: async (r) => {
          expect(r.operationId).toBe(confirmed.requestId);
          return checked;
        },
      },
      1000,
      () => ids.shift()!,
      () => inspected.review.observedAtMs + 1,
    );
    const item = result.snapshot.items[0];
    if (!("enablement" in item)) throw Error("expected actual skill item");
    expect(
      controller.inspect({
        owner,
        result,
        item,
        current: () => inventory.isCurrentResult(owner, result),
        changed: () => inventory.markStale(result),
      }),
    ).toBe(true);
    await flush();
    expect(writes).toBe(0);
    expect(
      controller.confirm(owner, controller.get(owner.agentId).review!),
    ).toBe(true);
    await flush();
    expect(controller.get(owner.agentId).operation).toEqual(confirmed);
    expect(controller.recheck(owner.agentId, confirmed.requestId)).toBe(true);
    await flush();
    expect(controller.get(owner.agentId).operation).toEqual(checked);
    expect(writes).toBe(1);
    expect(checked.writeAck).toBe(confirmed.writeAck);
    expect(checked.outcome).toBe("observed");
  }
});
