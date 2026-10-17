import { expect, it, vi } from "vitest";
import {
  parseExtensionCapabilities,
  parseInventoryCancellation,
  parseInventoryOperation,
  type InventoryRequest,
  type SkillInventoryItem,
} from "./extension_inventory_types";
import type { InventoryPort } from "./extension_inventory";
import { ExtensionInventoryController } from "./extension_inventory_controller";
import { requestForTarget } from "./extension_management_types";
import { deferred, flush, request } from "./extension_inventory.test-support";

const ticket = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const expected = {
  ...request,
  kind: "skills" as const,
  extraSkillRoots: ["/controlled/技能🙂", "/controlled/other"],
};
const discoveryItem = {
  id: 0,
  name: "sample:search",
  description: "Plain description",
  descriptionTruncated: false,
  descriptionRedacted: false,
  reportedEnabled: true,
  origin: "user" as const,
  pluginReported: false,
  enablement: {
    availability: "unavailable" as const,
    reason: "discoveryOnly" as const,
  },
};
function report(
  r: InventoryRequest & { extraSkillRoots?: readonly string[] } = expected,
) {
  return {
    ...r,
    state: "ready" as const,
    settled: true,
    snapshot: {
      observedAtMs: 1000,
      source: "officialAppServer" as const,
      scope: "officialSkillsForDirectory" as const,
      complete: true,
      sessionApplicability: "unverified" as const,
      errorCount: 0,
      items: [
        { ...discoveryItem, enablement: { ...discoveryItem.enablement } },
      ],
    },
  };
}
it("requires explicit extra-root capability independently from ordinary skills", () => {
  const capability = {
    availability: "available",
    source: "officialAppServer",
    reason: null,
  };
  const cap = {
    selectionId: ticket,
    mcpInventory: {
      availability: "unavailable",
      source: null,
      reason: "notReviewed",
    },
    skillsInventory: capability,
    skillEnablement: capability,
    skillsExtraRootsInventory: capability,
    toolInventory: "unavailable",
  };
  expect(parseExtensionCapabilities(cap)).toEqual(cap);
  expect(() =>
    parseExtensionCapabilities({
      ...cap,
      skillsInventory: cap.mcpInventory,
    }),
  ).toThrow();
});
it("accepts only the exact ordered requested roots and read-only discovery rows", () => {
  const value = report();
  expect(parseInventoryOperation(value, expected)).toEqual(value);
  for (const roots of [
    undefined,
    [],
    [...expected.extraSkillRoots].reverse(),
    ["/different"],
  ]) {
    const changed: Record<string, unknown> = { ...value };
    if (roots === undefined) delete changed.extraSkillRoots;
    else changed.extraSkillRoots = roots;
    expect(() => parseInventoryOperation(changed, expected)).toThrow();
  }
  const reviewable = report();
  Object.assign(reviewable.snapshot.items[0], {
    enablement: { availability: "reviewable", reason: null },
  });
  expect(() => parseInventoryOperation(reviewable, expected)).toThrow();
});
it("checks roots on cancellation/status operations rather than the current form", () => {
  const value = report();
  const cancellation = {
    agentId: expected.agentId,
    requestId: expected.requestId,
    cancelRequested: true,
    operation: value,
  };
  expect(parseInventoryCancellation(cancellation, expected)).toEqual(value);
  expect(() =>
    parseInventoryCancellation(
      { ...cancellation, operation: { ...value, extraSkillRoots: [] } },
      expected,
    ),
  ).toThrow();
});
it("copies and freezes roots before the read microtask, preserving caller order", async () => {
  const roots = ["/controlled/技能🙂", "/controlled/other"];
  const read = vi.fn<InventoryPort["read"]>(async ({ selectionId: _, ...r }) =>
    report(r),
  );
  const c = new ExtensionInventoryController(
    { read, status: vi.fn(), cancel: vi.fn() },
    1000,
    () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as const,
  );
  const owner = { agentId: expected.agentId, token: {}, current: () => true };
  expect(c.begin(owner, expected.cwd, ticket, "skills", roots)).toBe(true);
  roots[0] = "/changed-after-click";
  await flush();
  expect(read.mock.calls[0]?.[0].extraSkillRoots).toEqual(
    expected.extraSkillRoots,
  );
  const stored = c.get(owner.agentId).results.skills!.request;
  expect(stored.extraSkillRoots).toEqual(expected.extraSkillRoots);
  expect(Object.isFrozen(stored.extraSkillRoots)).toBe(true);
});
it.each([
  ["mcp", ["/controlled"]],
  ["skills", ["relative"]],
  ["skills", ["/same", "/same"]],
  ["skills", ["/bad\nname"]],
  ["skills", ["/" + "🙂".repeat(1024)]],
  ["skills", ["/a", "/b", "/c", "/d", "/e"]],
] as const)(
  "rejects invalid %s root requests without dispatch",
  async (kind, roots) => {
    const read = vi.fn();
    const c = new ExtensionInventoryController({
      read,
      status: vi.fn(),
      cancel: vi.fn(),
    });
    expect(
      c.begin(
        { agentId: "fixture", token: {}, current: () => true },
        "/controlled",
        ticket,
        kind,
        roots,
      ),
    ).toBe(false);
    await flush();
    expect(read).not.toHaveBeenCalled();
  },
);
it("retains cancellation cleanup ownership and never publishes a retired extra-root result", async () => {
  const wait = deferred();
  const cancel = vi.fn(async () => ({
    agentId: expected.agentId,
    requestId: expected.requestId,
    cancelRequested: true,
    operation: null,
  }));
  let live = true;
  const owner = { agentId: expected.agentId, token: {}, current: () => live };
  const c = new ExtensionInventoryController(
    { read: vi.fn(() => wait.promise), status: vi.fn(), cancel },
    1000,
    () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as const,
  );
  c.begin(owner, expected.cwd, ticket, "skills", expected.extraSkillRoots);
  await flush();
  live = false;
  c.retire(owner);
  await flush();
  expect(c.get(owner.agentId).unresolved).toBe(true);
  expect(
    c.begin(
      { ...owner, token: {}, current: () => true },
      expected.cwd,
      ticket,
      "skills",
      [],
    ),
  ).toBe(false);
  wait.resolve(report());
  await flush();
  expect(c.get(owner.agentId).results.skills).toBeUndefined();
  expect(c.get(owner.agentId).unresolved).toBe(false);
  expect(cancel).toHaveBeenCalledTimes(1);
});
it("rejects management of nonempty extra-root reports even if an item is forged reviewable", () => {
  const owner = { agentId: expected.agentId, token: {}, current: () => true };
  const item = {
    ...discoveryItem,
    enablement: { availability: "reviewable" as const, reason: null },
  } as SkillInventoryItem;
  const result = {
    request: expected as InventoryRequest,
    owner,
    cwd: expected.cwd,
    stale: false,
    snapshot: { ...report().snapshot, items: [item] },
  };
  expect(
    requestForTarget(
      { owner, result, item, current: () => true, changed: () => {} },
      ticket,
    ),
  ).toBeNull();
});
it("accepts four exact 4096-byte roots without changing their spelling or order", async () => {
  const roots = ["a", "b", "c", "d"].map(
    (letter) => `/${letter}${"x".repeat(4094)}`,
  );
  const read = vi.fn<InventoryPort["read"]>(async ({ selectionId: _, ...r }) =>
    report(r),
  );
  const c = new ExtensionInventoryController({
    read,
    status: vi.fn(),
    cancel: vi.fn(),
  });
  const owner = { agentId: expected.agentId, token: {}, current: () => true };
  expect(c.begin(owner, expected.cwd, ticket, "skills", roots)).toBe(true);
  await flush();
  expect(read.mock.calls[0]?.[0].extraSkillRoots).toEqual(roots);
  expect(c.get(owner.agentId).results.skills?.request.extraSkillRoots).toEqual(
    roots,
  );
});
it("clearing extra roots permits a separately requested ordinary report and ordinary management", async () => {
  const read = vi.fn<InventoryPort["read"]>(
    async ({ selectionId: _, ...r }) => {
      const value = report(r);
      if (!r.extraSkillRoots?.length)
        Object.assign(value.snapshot.items[0], {
          enablement: { availability: "reviewable", reason: null },
        });
      return { ...value, extraSkillRoots: r.extraSkillRoots ?? [] };
    },
  );
  const c = new ExtensionInventoryController({
    read,
    status: vi.fn(),
    cancel: vi.fn(async () => undefined),
  });
  const owner = { agentId: expected.agentId, token: {}, current: () => true };
  c.begin(owner, expected.cwd, ticket, "skills", expected.extraSkillRoots);
  await flush();
  expect(c.begin(owner, expected.cwd, ticket, "skills", [])).toBe(true);
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1]?.[0].extraSkillRoots).toBeUndefined();
  const result = c.get(owner.agentId).results.skills!;
  const item = result.snapshot.items[0] as SkillInventoryItem;
  expect(
    requestForTarget(
      {
        owner,
        result,
        item,
        current: () => c.isCurrentResult(owner, result),
        changed: () => {},
      },
      ticket,
    ),
  ).not.toBeNull();
});
