import { expect, it } from "vitest";
import { parseExtensionCapabilities } from "./extension_inventory_types";
import {
  parsePluginCancellation,
  parsePluginItem,
  parsePluginOperation,
  type PluginRequest,
} from "./plugin_management_types";
import {
  pluginItem,
  pluginOperation,
  pluginTicket,
} from "./plugin_management.test-support";

const request: PluginRequest = {
  agentId: "controlled",
  requestId: pluginTicket,
  cwd: "/controlled",
  action: "inventory",
};
it("accepts a bounded partial catalog without claiming adoption or installation", () => {
  const wire = pluginOperation(request, true);
  expect(parsePluginOperation(wire, request)).toEqual(wire);
  expect(wire.catalog?.complete).toBe(false);
  wire.catalog!.items = [];
  expect(parsePluginOperation(wire, request).catalog?.items).toEqual([]);
});
it.each(["agentId", "requestId", "cwd", "action"])(
  "rejects a different operation %s",
  (key) => {
    expect(() =>
      parsePluginOperation(
        { ...pluginOperation(request, true), [key]: "different" },
        request,
      ),
    ).toThrow();
  },
);
it("rejects unknown config/path fields, unsupported adoption and duplicate item IDs", () => {
  const base = pluginOperation(request, true);
  for (const patch of [
    { rawConfig: {} },
    { installedPath: "/private/file" },
    { sourceUrl: "https://example.invalid" },
  ])
    expect(() => parsePluginItem({ ...pluginItem, ...patch })).toThrow();
  expect(() =>
    parsePluginOperation(
      { ...base, catalog: { ...base.catalog, sessionApplicability: "active" } },
      request,
    ),
  ).toThrow();
  expect(() =>
    parsePluginOperation(
      {
        ...base,
        catalog: { ...base.catalog, items: [pluginItem, pluginItem] },
      },
      request,
    ),
  ).toThrow();
});
it("requires an explicit query-only capability and never upgrades support", () => {
  const unavailable = {
    availability: "unavailable",
    source: null,
    reason: "notReviewed",
  };
  const value = {
    selectionId: pluginTicket,
    mcpInventory: unavailable,
    skillsInventory: unavailable,
    skillEnablement: unavailable,
    toolInventory: "unavailable",
    pluginManagement: {
      availability: "available",
      source: "officialCli",
      reason: null,
      support: "unverified",
    },
  };
  expect(parseExtensionCapabilities(value)).toEqual(value);
  expect(() =>
    parseExtensionCapabilities({
      ...value,
      pluginManagement: { ...value.pluginManagement, support: "verified" },
    }),
  ).toThrow();
});
it("a successful mutation requires matching readback, acknowledged dispatch and the exact original target", () => {
  const expected: PluginRequest = {
    ...request,
    action: "install",
    target: pluginItem,
    install: true,
  };
  const op = {
    ...pluginOperation(expected, true),
    writeDispatched: true,
    writeAck: "ok",
    outcome: "verified",
  };
  expect(() => parsePluginOperation(op, expected)).toThrow();
  const observation = {
    observedAtMs: 1,
    reportedInstalled: true,
    reportedEnabled: false,
    sessionApplicability: "unverified",
  };
  const good = { ...op, observation };
  expect(parsePluginOperation(good, expected).outcome).toBe("verified");
  expect(() =>
    parsePluginOperation(
      { ...good, observation: { ...observation, reportedInstalled: false } },
      expected,
    ),
  ).toThrow();
  expect(() =>
    parsePluginOperation(
      { ...good, target: { ...pluginItem, marketplaceName: "other" } },
      expected,
    ),
  ).toThrow();
  expect(() =>
    parsePluginOperation(
      { ...good, writeDispatched: false, writeAck: "none" },
      expected,
    ),
  ).toThrow();
});
it("an empty catalog cannot masquerade as successful removal", () => {
  const target = {
    ...pluginItem,
    reportedInstalled: true,
    install: {
      availability: "unavailable" as const,
      reason: "alreadyInstalled" as const,
    },
    remove: { availability: "available" as const, reason: null },
  };
  const expected: PluginRequest = {
    ...request,
    action: "remove",
    target,
    install: false,
  };
  expect(() =>
    parsePluginOperation(
      {
        ...pluginOperation(expected, true),
        writeDispatched: true,
        writeAck: "ok",
        outcome: "verified",
        catalog: pluginOperation(request, true).catalog,
      },
      expected,
    ),
  ).toThrow();
});
it("rejects a review with a different source, policy or action", () => {
  const expected: PluginRequest = {
    ...request,
    action: "inspect",
    target: pluginItem,
    install: true,
  };
  const op = pluginOperation(expected, true);
  expect(parsePluginOperation(op, expected)).toEqual(op);
  for (const patch of [
    { install: false },
    { target: { ...pluginItem, installPolicy: "notAvailable" } },
    { validForMs: 999999 },
  ])
    expect(() =>
      parsePluginOperation(
        { ...op, review: { ...op.review, ...patch } },
        expected,
      ),
    ).toThrow();
});
it("retains true cancellation-null as unknown and validates callback ownership", () => {
  const cancelled = {
    agentId: request.agentId,
    requestId: request.requestId,
    cancelRequested: true,
    operation: null,
  };
  expect(parsePluginCancellation(cancelled, request)).toBeNull();
  expect(() =>
    parsePluginCancellation({ ...cancelled, agentId: "other" }, request),
  ).toThrow();
});
