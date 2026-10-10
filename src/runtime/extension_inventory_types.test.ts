import { expect, it } from "vitest";
import {
  parseExtensionCapabilities,
  parseInventoryOperation,
  parseInventoryCancellation,
} from "./extension_inventory_types";
import { ready, request } from "./extension_inventory.test-support";
it("accepts the scoped full successful report including redacted rows and empty lists", () => {
  const value = ready();
  value.snapshot!.items[0].name = null;
  expect(parseInventoryOperation(value, request)).toEqual(value);
  value.snapshot!.items = [];
  expect(parseInventoryOperation(value, request).snapshot?.items).toEqual([]);
});
it.each(["agentId", "requestId", "cwd"] as const)(
  "rejects a report for a different %s",
  (field) => {
    expect(() =>
      parseInventoryOperation({ ...ready(), [field]: "other" }, request),
    ).toThrow();
  },
);
it.each([
  { state: "running", settled: false },
  { state: "ready", settled: false },
  { state: "failed", settled: true, code: "queryFailed" },
  { headers: { Authorization: "controlled-canary" } },
])("rejects misplaced snapshot or unknown payload %j", (patch) => {
  expect(() =>
    parseInventoryOperation({ ...ready(), ...patch }, request),
  ).toThrow();
});
it("rejects future fields, connection claims, duplicate IDs, unsafe names and extra secret fields", () => {
  for (const patch of [
    { id: 9 },
    { connection: "connected" },
    { name: "https://example.invalid/secret" },
    { env: "controlled-canary" },
  ]) {
    const value = ready();
    Object.assign(value.snapshot!.items[0], patch);
    expect(() => parseInventoryOperation(value, request)).toThrow();
  }
});
it("distinguishes exact early cancellation null from terminal operation", () => {
  expect(
    parseInventoryCancellation(
      {
        agentId: request.agentId,
        requestId: request.requestId,
        cancelRequested: true,
        operation: null,
      },
      request,
    ),
  ).toBeNull();
  expect(() =>
    parseInventoryCancellation(
      {
        agentId: "other",
        requestId: request.requestId,
        cancelRequested: true,
        operation: null,
      },
      request,
    ),
  ).toThrow();
});
it("does not infer capability from an unknown shape or unavailable source", () => {
  const value = {
    selectionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    mcpInventory: {
      availability: "available",
      source: "officialCli",
      reason: null,
    },
    skillsInventory: {
      availability: "unavailable",
      source: null,
      reason: "notReviewed",
    },
    skillEnablement: {
      availability: "unavailable",
      source: null,
      reason: "notReviewed",
    },
    toolInventory: "unavailable",
  };
  expect(parseExtensionCapabilities(value)).toEqual(value);
  expect(() =>
    parseExtensionCapabilities({ ...value, toolInventory: "available" }),
  ).toThrow();
  expect(() =>
    parseExtensionCapabilities({
      ...value,
      mcpInventory: { ...value.mcpInventory, reason: "notReviewed" },
    }),
  ).toThrow();
});
