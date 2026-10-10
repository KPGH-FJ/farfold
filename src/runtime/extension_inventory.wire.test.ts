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
    "docs/evidence/2026-10-09-capability-hardening/skills-inventory/backend/actual-wire.json",
    "utf8",
  ),
);
const request = {
  agentId: wire.running.agentId,
  requestId: wire.running.requestId,
  cwd: wire.running.cwd,
  kind: wire.running.kind,
};

it("rejects the old capability missing management availability; adapted unavailable stays read-only", () => {
  expect(() => parseExtensionCapabilities(wire.capabilities)).toThrow();
  const current = {
    ...wire.capabilities,
    skillEnablement: {
      availability: "unavailable",
      source: null,
      reason: "notReviewed",
    },
  };
  expect(parseExtensionCapabilities(current)).toEqual(current);
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
it("accepts actual skills peer output with partial errors, disabled row and bounded description", () => {
  const expected = {
    agentId: wire.skillsRunning.agentId,
    requestId: wire.skillsRunning.requestId,
    cwd: wire.skillsRunning.cwd,
    kind: wire.skillsRunning.kind,
  };
  expect(parseInventoryOperation(wire.skillsRunning, expected)).toEqual(
    wire.skillsRunning,
  );
  expect(() => parseInventoryOperation(wire.skillsReady, expected)).toThrow();
  // Old partial peer output never grants management: explicit test-only schema adaptation.
  const current = {
    ...wire.skillsReady,
    snapshot: {
      ...wire.skillsReady.snapshot,
      items: wire.skillsReady.snapshot.items.map((i: object) => ({
        ...i,
        enablement: {
          availability: "unavailable",
          reason: "incompleteInventory",
        },
      })),
    },
  };
  expect(parseInventoryOperation(current, expected)).toEqual(current);
  expect(wire.skillsReady.snapshot.complete).toBe(false);
  expect(wire.skillsReady.snapshot.errorCount).toBe(1);
  expect(wire.skillsReady.snapshot.items[0]).toMatchObject({
    reportedEnabled: false,
    origin: "repo",
    description: "Review documents",
  });
  expect(() =>
    parseInventoryOperation(wire.skillsReady, { ...expected, kind: "mcp" }),
  ).toThrow();
});
