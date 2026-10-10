import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  parseExtensionCapabilities,
  parseInventoryOperation,
} from "./extension_inventory_types";
import {
  parseSkillChangeOperation,
  parseSkillChangeCancellation,
  type SkillChangeRequest,
} from "./skill_management_types";
const wire = JSON.parse(
  readFileSync(
    "docs/evidence/2026-10-09-capability-hardening/skill-management/backend/actual-wire.json",
    "utf8",
  ),
);
const expected = (v: any): SkillChangeRequest => ({
  agentId: v.agentId,
  requestId: v.requestId,
  action: v.action,
  cwd: v.cwd,
  target: v.target,
  requestedEnabled: v.requestedEnabled,
  operationId: v.operationId,
});
it("accepts actual synthetic capabilities without claiming official availability", () => {
  expect(parseExtensionCapabilities(wire.capabilities)).toEqual(
    wire.capabilities,
  );
  expect(wire.capabilities.skillEnablement.availability).toBe("unavailable");
});
it("accepts actual private-target projection with complete reviewable inventory", () => {
  expect(parseInventoryOperation(wire.inventory, wire.inventory)).toEqual(
    wire.inventory,
  );
  expect(wire.inventory.snapshot.items[0].enablement.availability).toBe(
    "reviewable",
  );
});
for (const { label, value } of wire.operations)
  it("accepts actual Rust management serialization: " + label, () => {
    expect(parseSkillChangeOperation(value, expected(value))).toEqual(value);
  });
for (const [i, value] of wire.cancellations.entries())
  it("accepts actual Rust management cancellation " + i, () => {
    expect(
      parseSkillChangeCancellation(
        value,
        value.operation
          ? expected(value.operation)
          : ({
              agentId: value.agentId,
              requestId: value.requestId,
            } as SkillChangeRequest),
      ),
    ).toEqual(value.operation);
  });
it("the captured lost-acknowledgement chain keeps exact original target and confirmation facts", () => {
  const op = Object.fromEntries(
    wire.operations.map((x: any) => [x.label, x.value]),
  );
  expect(op.confirmUnknown.target).toEqual(op.confirmUnknownInspection.target);
  expect(op.unknownReadonlyObserved.operationId).toBe(
    op.confirmUnknown.requestId,
  );
  expect(op.unknownReadonlyObserved.writeAck).toBe("unknown");
  expect(op.unknownReadonlyObserved.outcome).toBe("observed");
});
