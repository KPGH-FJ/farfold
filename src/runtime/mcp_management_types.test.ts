import { expect, it } from "vitest";
import {
  parseMcpChangeOperation,
  parseMcpChangeCancellation,
} from "./mcp_management_types";
import {
  parseInventoryOperation,
  parseExtensionCapabilities,
} from "./extension_inventory_types";
import {
  operation,
  written,
  request,
  snapshot,
  id,
} from "./mcp_management.test-support";
import { parseSkillChangeOperation } from "./skill_management_types";
import {
  operation as skillOperation,
  iid,
} from "./skill_management.test-support";
it("strictly accepts the dedicated MCP review and rejects hidden authority or another target", () => {
  const o = operation(request, true);
  expect(parseMcpChangeOperation(o, request)).toEqual(o);
  for (const target of [
    { ...o.target, name: "other" },
    { ...o.target, transport: "streamableHttp" },
    { ...o.target, keyPath: "secret" },
    { ...o.target, kind: "skill" },
  ])
    expect(() => parseMcpChangeOperation({ ...o, target }, request)).toThrow();
  expect(() =>
    parseMcpChangeOperation(
      { ...o, review: { ...o.review, version: "hidden" } },
      request,
    ),
  ).toThrow();
});
it("requires exact observation and cleanup facts for verified and observed", () => {
  const r = { ...request, action: "setEnabled" as const };
  const o = written(r);
  expect(parseMcpChangeOperation(o, r)).toEqual(o);
  for (const patch of [
    { state: "running", settled: false, phase: "checking" },
    { writeAck: "unknown" },
    { observation: { ...o.observation, configuredEnabled: true } },
    { observation: { ...o.observation, reportedEnabled: true } },
    { observation: { ...o.observation, mcp: "missing" } },
  ])
    expect(() => parseMcpChangeOperation({ ...o, ...patch }, r)).toThrow();
  const check = { ...r, action: "recheck" as const, operationId: r.requestId };
  expect(parseMcpChangeOperation(written(check, true), check).outcome).toBe(
    "observed",
  );
  const pending = {
    ...o,
    state: "pendingCleanup",
    settled: false,
    phase: "cleaning",
    outcome: null,
  };
  expect(parseMcpChangeOperation(pending, r).observation).toEqual(
    o.observation,
  );
});
it("never treats a cancellation reply for another request as absence", () => {
  expect(
    parseMcpChangeCancellation(
      {
        agentId: request.agentId,
        requestId: id,
        cancelRequested: true,
        operation: null,
      },
      request,
    ),
  ).toBeNull();
  for (const patch of [
    { agentId: "other" },
    { requestId: iid.replace(/^1/, "2") },
    { cancelRequested: false },
    { extra: true },
  ])
    expect(() =>
      parseMcpChangeCancellation(
        {
          agentId: request.agentId,
          requestId: id,
          cancelRequested: true,
          operation: null,
          ...patch,
        },
        request,
      ),
    ).toThrow();
});
it("does not reinterpret a skill operation as an MCP preference", () => {
  const skill = {
    ...request,
    target: {
      inventoryRequestId: id,
      itemId: 0,
      name: "local-tools",
      origin: "repo" as const,
    },
  };
  const o = skillOperation(skill, "ready");
  expect(() => parseMcpChangeOperation(o, request)).toThrow();
  expect(() =>
    parseSkillChangeOperation(operation(request, true), skill),
  ).toThrow();
});
it("preserves old read-only wire while strictly rejecting malformed new eligibility", () => {
  const { enablement: _, ...legacyItem } = snapshot.items[0];
  const raw = {
    kind: "mcp" as const,
    agentId: "a",
    cwd: "/controlled",
    requestId: id,
    state: "ready",
    settled: true,
    snapshot: { ...snapshot, items: [legacyItem] },
  };
  expect(parseInventoryOperation(raw, raw)).toEqual(raw);
  for (const enablement of [
    { availability: "available", keyPath: "x" },
    { availability: "unavailable", reason: "madeUp" },
    { availability: "reviewable" },
  ])
    expect(() =>
      parseInventoryOperation(
        {
          ...raw,
          snapshot: { ...snapshot, items: [{ ...legacyItem, enablement }] },
        },
        raw,
      ),
    ).toThrow();
});
it("MCP management capability cannot exceed the reported inventory capability", () => {
  const unavailable = {
    availability: "unavailable",
    source: null,
    reason: "notReviewed",
  };
  const old = {
    selectionId: null,
    mcpInventory: unavailable,
    skillsInventory: unavailable,
    skillEnablement: unavailable,
    toolInventory: "unavailable",
  };
  expect(parseExtensionCapabilities(old)).toEqual(old);
  expect(() =>
    parseExtensionCapabilities({
      ...old,
      mcpEnablement: {
        availability: "available",
        source: "officialAppServer",
        reason: null,
      },
    }),
  ).toThrow();
});
it("rejects an available eligibility claim for an undisclosed name or unsupported transport", () => {
  const r = {
    kind: "mcp" as const,
    agentId: "a",
    cwd: "/controlled",
    requestId: id,
  };
  for (const patch of [{ name: null }, { transport: "unknown" }])
    expect(() =>
      parseInventoryOperation(
        {
          ...r,
          state: "ready",
          settled: true,
          snapshot: {
            ...snapshot,
            items: [{ ...snapshot.items[0], ...patch }],
          },
        },
        r,
      ),
    ).toThrow();
});
it("accepts the final ordinal of the bounded MCP inventory", () => {
  const r = { ...request, target: { ...request.target, itemId: 511 } };
  expect(parseMcpChangeOperation(operation(r, true), r).target.itemId).toBe(
    511,
  );
});
it("preserves an explicitly null eligibility reason without accepting a contradictory reason", () => {
  const r = {
    kind: "mcp" as const,
    agentId: "a",
    cwd: "/controlled",
    requestId: id,
  };
  const raw = {
    ...r,
    state: "ready",
    settled: true,
    snapshot: {
      ...snapshot,
      items: [
        {
          ...snapshot.items[0],
          enablement: { availability: "available", reason: null },
        },
      ],
    },
  };
  expect(parseInventoryOperation(raw, r)).toEqual(raw);
  expect(() =>
    parseInventoryOperation(
      {
        ...raw,
        snapshot: {
          ...snapshot,
          items: [
            {
              ...snapshot.items[0],
              enablement: { availability: "available", reason: "unsafeLabel" },
            },
          ],
        },
      },
      r,
    ),
  ).toThrow();
});
