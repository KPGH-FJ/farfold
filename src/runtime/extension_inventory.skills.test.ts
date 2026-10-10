import { expect, it, vi } from "vitest";
import {
  parseExtensionCapabilities,
  parseInventoryOperation,
} from "./extension_inventory_types";
import type { InventoryPort } from "./extension_inventory";
import { ExtensionInventoryController } from "./extension_inventory_controller";
import {
  deferred,
  flush,
  ready,
  request,
} from "./extension_inventory.test-support";

const skillRequest = { ...request, kind: "skills" as const };
const skills = (errors = 0) => ({
  ...skillRequest,
  state: "ready",
  settled: true,
  snapshot: {
    observedAtMs: 1000,
    source: "officialAppServer",
    scope: "officialSkillsForDirectory",
    complete: errors === 0,
    sessionApplicability: "unverified",
    errorCount: errors,
    items: [
      {
        id: 0,
        name: "Example",
        description: "A plain description",
        descriptionTruncated: false,
        descriptionRedacted: false,
        reportedEnabled: false,
        origin: "repo",
        pluginReported: true,
      },
    ],
  },
});
it("accepts skills capability independently from MCP and requires an exact ticket", () => {
  const cap = {
    selectionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    mcpInventory: {
      availability: "unavailable",
      source: null,
      reason: "notReviewed",
    },
    skillsInventory: {
      availability: "available",
      source: "officialAppServer",
      reason: null,
    },
    toolInventory: "unavailable",
  };
  expect(parseExtensionCapabilities(cap)).toEqual(cap);
  expect(() =>
    parseExtensionCapabilities({ ...cap, selectionId: null }),
  ).toThrow();
});
it("keeps disabled skills and partial errors even with no readable skill rows", () => {
  expect(parseInventoryOperation(skills(), skillRequest)).toEqual(skills());
  const partial = skills(2);
  partial.snapshot.items = [];
  expect(parseInventoryOperation(partial, skillRequest)).toEqual(partial);
});
it.each([
  (v: ReturnType<typeof skills>) => {
    v.snapshot.complete = true;
    v.snapshot.errorCount = 1;
  },
  (v: ReturnType<typeof skills>) => {
    v.snapshot.items[0].description = "😀".repeat(2049);
  },
  (v: ReturnType<typeof skills>) => {
    Object.assign(v.snapshot.items[0], { path: "/private/secret" });
  },
])("rejects contradictory or out-of-contract skills results", (mutate) => {
  const v = skills();
  mutate(v);
  expect(() => parseInventoryOperation(v, skillRequest)).toThrow();
});
it("rejects cross-kind replies rather than accepting an old report for another tab", () => {
  expect(() =>
    parseInventoryOperation(skills(), { ...request, kind: "mcp" }),
  ).toThrow();
  expect(() =>
    parseInventoryOperation({ ...ready(), kind: "skills" }, skillRequest),
  ).toThrow();
});
it("keeps independent snapshots and one unsettled admission slot across kinds", async () => {
  const wait = deferred();
  const read = vi.fn<InventoryPort["read"]>(() => wait.promise);
  const port = {
    read,
    status: vi.fn(),
    cancel: vi.fn(async () => ({
      agentId: request.agentId,
      requestId: request.requestId,
      cancelRequested: true,
      operation: null,
    })),
  };
  let issued = 0;
  const c = new ExtensionInventoryController(
    port,
    1000,
    (): ReturnType<Crypto["randomUUID"]> =>
      issued++ === 0
        ? "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        : "cccccccc-cccc-cccc-cccc-cccccccccccc",
  );
  const owner = { agentId: request.agentId, token: {}, current: () => true };
  expect(
    c.begin(
      owner,
      request.cwd,
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "skills",
    ),
  ).toBe(true);
  await flush();
  expect(read.mock.calls[0]).toEqual([
    { ...skillRequest, selectionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
  ]);
  expect(
    c.begin(owner, request.cwd, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "mcp"),
  ).toBe(false);
  wait.resolve(skills());
  await flush();
  expect(c.get(request.agentId).results.skills?.snapshot).toEqual(
    skills().snapshot,
  );
  c.retire(owner);
  expect(c.get(request.agentId).results.skills?.stale).toBe(true);
  read.mockImplementationOnce(async ({ agentId, requestId, cwd, kind }) =>
    ready({ agentId, requestId, cwd, kind }),
  );
  expect(
    c.begin(
      { ...owner, token: {} },
      request.cwd,
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "mcp",
    ),
  ).toBe(true);
  await flush();
  expect(c.get(request.agentId).results.skills?.snapshot).toEqual(
    skills().snapshot,
  );
  expect(c.get(request.agentId).results.mcp?.snapshot).toEqual(
    ready().snapshot,
  );
});
