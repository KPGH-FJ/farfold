import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  parseExtensionCapabilities,
  parseInventoryOperation,
  parseInventoryCancellation,
} from "./extension_inventory_types";

// Actual controlled Rust process -> decoder -> Request serialization. This
// fixture does not prove a real Agent's available capability or live CLI result.
const wire = JSON.parse(
  readFileSync(
    "docs/evidence/2026-10-09-capability-hardening/extension-inventory/backend/actual-wire.json",
    "utf8",
  ),
);
const request = {
  agentId: wire.running.agentId,
  requestId: wire.running.requestId,
  cwd: wire.running.cwd,
};

it("accepts the actual unavailable capability with a null selection ticket", () => {
  expect(parseExtensionCapabilities(wire.capabilities)).toEqual(
    wire.capabilities,
  );
  expect(wire.capabilities.selectionId).toBeNull();
});
it("accepts the actual running operation without optional code or snapshot", () => {
  expect(parseInventoryOperation(wire.running, request)).toEqual(wire.running);
  expect(wire.running.settled).toBe(false);
});
it("accepts actual process-decoded redacted configuration facts without session claims", () => {
  expect(parseInventoryOperation(wire.ready, request)).toEqual(wire.ready);
  expect(wire.ready.snapshot.sessionApplicability).toBe("unverified");
  expect(wire.ready.snapshot.items[0].reportedEnabled).toBe(false);
});
it("accepts actual early cancellation without inventing a completed operation", () => {
  expect(
    parseInventoryCancellation(wire.earlyCancellation, wire.earlyCancellation),
  ).toBeNull();
  expect(wire.earlyCancellation.operation).toBeNull();
});
