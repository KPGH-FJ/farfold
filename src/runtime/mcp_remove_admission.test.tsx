import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  requestForTarget,
  type ExtensionChangeTargetOwner,
} from "./extension_management_types";
import { parseExtensionCapabilities } from "./extension_inventory_types";
import { setup, id, snapshot } from "./mcp_management.test-support";
import { AgentExtensionInventoryResult } from "../components/AgentExtensionInventoryResult";

it("admits removal as null intent instead of a false enabled preference", async () => {
  const h = await setup();
  const item = { ...h.target.item, reportedEnabled: false };
  const result = {
    ...h.result,
    snapshot: { ...snapshot, items: [item] },
  };
  const target = {
    ...h.target,
    kind: "mcpRemoval",
    item,
    result,
    current: () => true,
  };
  expect(
    requestForTarget(target as ExtensionChangeTargetOwner, id),
  ).toMatchObject({
    requestedEnabled: null,
    action: "inspect",
    target: { kind: "mcpRemoval" },
  });
});
it("accepts an explicit removal capability without granting it to legacy capabilities", () => {
  const available = {
    availability: "available",
    source: "officialAppServer",
    reason: null,
  };
  const old = {
    selectionId: id,
    mcpInventory: { ...available, source: "officialCli" },
    skillsInventory: available,
    skillEnablement: available,
    toolInventory: "unavailable",
  };
  expect(
    parseExtensionCapabilities({ ...old, mcpRemoval: available }),
  ).toHaveProperty("mcpRemoval", available);
  expect(parseExtensionCapabilities(old)).not.toHaveProperty("mcpRemoval");
});
it("offers a separate removal review only for eligible disabled rows", async () => {
  const h = await setup();
  const props = {
    result: {
      ...h.result,
      snapshot: {
        ...snapshot,
        items: [{ ...h.target.item, reportedEnabled: false }],
      },
    },
    stale: false,
    removal: { enabled: true, inspect: () => {} },
  };
  expect(
    renderToStaticMarkup(<AgentExtensionInventoryResult {...props} />),
  ).toContain("审阅移除…");
});
it("does not offer removal for enabled/unknown/legacy/incomplete rows or without capability wiring", async () => {
  const h = await setup();
  const row = { ...h.target.item, reportedEnabled: false };
  const result = { ...h.result, snapshot: { ...snapshot, items: [row] } };
  const render = (r: typeof result, removal = true, stale = false) =>
    renderToStaticMarkup(
      <AgentExtensionInventoryResult
        result={r}
        stale={stale}
        removal={removal ? { enabled: true, inspect: () => {} } : undefined}
      />,
    );
  expect(render(result, false)).not.toContain("审阅移除…");
  expect(
    render({
      ...result,
      snapshot: { ...snapshot, items: [{ ...row, reportedEnabled: true }] },
    }),
  ).not.toContain("审阅移除…");
  expect(
    render({
      ...result,
      snapshot: {
        ...snapshot,
        items: [{ ...row, enablement: undefined } as never],
      },
    }),
  ).not.toContain("审阅移除…");
  expect(
    render({
      ...result,
      snapshot: {
        ...snapshot,
        items: [{ ...row, transport: "unknown" } as never],
      },
    }),
  ).not.toContain("审阅移除…");
  expect(
    render({
      ...result,
      snapshot: { ...result.snapshot, complete: false } as never,
    }),
  ).not.toContain("审阅移除…");
  expect(render(result, true, true)).toMatch(/disabled=""[^>]*>审阅移除…/);
});
it("rejects malformed removal capabilities and never derives permission from enablement", () => {
  const available = {
    availability: "available",
    source: "officialAppServer",
    reason: null,
  };
  const old = {
    selectionId: id,
    mcpInventory: { ...available, source: "officialCli" },
    skillsInventory: available,
    skillEnablement: available,
    mcpEnablement: available,
    toolInventory: "unavailable",
  };
  expect(parseExtensionCapabilities(old).mcpRemoval).toBeUndefined();
  for (const mcpRemoval of [
    { availability: "available", source: "officialCli", reason: null },
    { ...available, secret: "hidden" },
    { ...available, reason: "busy" },
    { availability: "unavailable", source: null, reason: "targetEnabled" },
  ])
    expect(() => parseExtensionCapabilities({ ...old, mcpRemoval })).toThrow();
  expect(
    parseExtensionCapabilities({
      ...old,
      mcpRemoval: { availability: "unavailable", source: null, reason: "busy" },
    }).mcpRemoval?.availability,
  ).toBe("unavailable");
});
