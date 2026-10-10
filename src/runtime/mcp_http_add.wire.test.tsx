import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  parseInventoryOperation,
  parseExtensionCapabilities,
} from "./extension_inventory_types";
import {
  parseMcpAddOperation,
  parseMcpAddCancellation,
  mcpAddFailure,
  type McpAddRequest,
} from "./mcp_add_types";
import { extensionInventory } from "./extension_inventory_controller";
import { inventoryPort } from "./extension_inventory";
import { skillManagement } from "./skill_management_controller";
import { mcpAddPort } from "./mcp_add";
import { SkillChangeReview } from "../components/SkillChangeReview";
import { flush } from "./extension_inventory.test-support";
const wire = JSON.parse(
  readFileSync(
    "docs/evidence/2026-10-09-capability-hardening/mcp-http-add/backend/actual-wire.json",
    "utf8",
  ),
);
const input = {
  transport: "streamableHttp" as const,
  name: "sample.new",
  url: "HTTPS://Endpoint.test:000443/mcp?token=HTTP_URL_CANARY&x=one&x=two&empty=&plus=a+b&slash=%2f&hash=%23",
};
const request = (v: any): McpAddRequest => ({
  agentId: v.agentId,
  requestId: v.requestId,
  action: v.action,
  cwd: v.cwd,
  target: v.target,
  requestedEnabled: v.requestedEnabled,
  operationId: v.operationId,
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
for (const [label, value] of Object.entries(wire) as [string, any][])
  it(
    "accepts actual Rust serialization without changing fields: " + label,
    () => {
      if (label === "invalidUrl") {
        expect(mcpAddFailure(value)).toBe("invalidUrl");
      } else if ("cancelRequested" in value) {
        expect(
          parseMcpAddCancellation(
            value,
            value.operation ? request(value.operation) : value,
          ),
        ).toEqual(value.operation);
      } else if ("mcpInventory" in value) {
        expect(parseExtensionCapabilities(value)).toEqual(value);
      } else {
        expect(
          value.kind === "mcp"
            ? parseInventoryOperation(value, value)
            : parseMcpAddOperation(value, request(value)),
        ).toEqual(value);
      }
    },
  );
async function begin(
  inspection: any,
  result: any,
  source: any,
  tail: string[] = [],
) {
  vi.useFakeTimers();
  vi.setSystemTime(inspection.review.observedAtMs);
  const ids = [
    source.requestId,
    inspection.requestId,
    result.requestId,
    ...tail,
  ];
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => ids.shift()!);
  const owner = { agentId: source.agentId, token: {}, current: () => true };
  vi.spyOn(inventoryPort, "read").mockResolvedValue(source);
  vi.spyOn(inventoryPort, "cancel").mockResolvedValue(null);
  const inspect = vi.spyOn(mcpAddPort, "inspect").mockResolvedValue(inspection);
  const confirm = vi.spyOn(mcpAddPort, "confirm").mockResolvedValue(result);
  extensionInventory.begin(owner, source.cwd, source.requestId, "mcp");
  await flush();
  const inventory = extensionInventory.get(owner.agentId).results.mcp!;
  expect(
    skillManagement.inspect({
      kind: "mcpAddition",
      owner,
      result: inventory,
      inputId: inspection.target.inputId,
      input,
      httpAvailable: true,
      current: () => extensionInventory.isCurrentResult(owner, inventory),
      changed: () => extensionInventory.markStale(inventory),
    }),
  ).toBe(true);
  await flush();
  expect(inspect).toHaveBeenCalledExactlyOnceWith({
    agentId: owner.agentId,
    requestId: inspection.requestId,
    inventoryRequestId: source.requestId,
    inputId: inspection.target.inputId,
    input,
  });
  expect(skillManagement.get(owner.agentId).operation).toEqual(inspection);
  expect(confirm).not.toHaveBeenCalled();
  const render = () =>
    renderToStaticMarkup(
      <SkillChangeReview agentId={owner.agentId} owner={owner} active />,
    );
  expect(render()).toContain("确认添加并保持停用");
  expect(render()).toContain("HTTP_URL_CANARY");
  expect(render()).toContain("HTTPS://Endpoint.test:000443/mcp?token=");
  expect(render()).not.toMatch(/<a\b/);
  expect(
    skillManagement.confirm(owner, skillManagement.get(owner.agentId).review!),
  ).toBe(true);
  await flush();
  expect(confirm).toHaveBeenCalledExactlyOnceWith({
    agentId: owner.agentId,
    requestId: result.requestId,
    reviewId: inspection.review.reviewId,
  });
  expect(skillManagement.get(owner.agentId).operation).toEqual(result);
  return { owner, render, confirm };
}

it("runs actual HTTP inspection and verified reply through the shared controller and escaped review", async () => {
  const h = await begin(wire.inspection, wire.verified, wire.inventory);
  expect(h.render()).toContain("已添加，保持停用。地址和配置报告均已核对。");
  expect(h.confirm).toHaveBeenCalledTimes(1);
  expect(
    JSON.stringify(skillManagement.get(h.owner.agentId).request),
  ).not.toContain("HTTP_URL_CANARY");
});
it.each([
  ["unknownInventory", "unknownInspection", "unknown", "recheckObserved"],
  [
    "rejectedInventory",
    "rejectedInspection",
    "rejected",
    "rejectedRecheckObserved",
  ],
])(
  "preserves exact %s write history while readonly recheck publishes only a current observation",
  async (source, inspect, result, observed) => {
    const h = await begin(wire[inspect], wire[result], wire[source], [
      wire[observed].requestId,
    ]);
    const original = JSON.stringify(
      skillManagement.get(h.owner.agentId).operation,
    );
    const check = vi
      .spyOn(mcpAddPort, "recheck")
      .mockResolvedValue(wire[observed]);
    skillManagement.retire(h.owner);
    expect(skillManagement.get(h.owner.agentId).additionInput).toBeNull();
    expect(
      skillManagement.recheck(h.owner.agentId, wire[result].requestId),
    ).toBe(true);
    await flush();
    const view = skillManagement.get(h.owner.agentId);
    expect(view.operation).toEqual(wire[observed]);
    expect(JSON.stringify(view.originalOperation)).toBe(original);
    expect(view.additionInput).toBeNull();
    expect(h.render()).not.toContain("HTTP_URL_CANARY");
    expect(h.render()).not.toContain("确认添加并保持停用");
    expect(h.render()).toContain("不能据此确认此前添加是否成功");
    expect(check).toHaveBeenCalledExactlyOnceWith({
      agentId: h.owner.agentId,
      requestId: wire[observed].requestId,
      operationId: wire[result].requestId,
    });
    expect(h.confirm).toHaveBeenCalledTimes(1);
  },
);
it("preserves actual pendingCleanup and cancellation facts until final cleanup, then readonly rechecks without input", async () => {
  const inspect = wire.pendingInspection;
  // This chain's catalogue was not captured; only this prerequisite is a controlled seed.
  const source = {
    ...wire.inventory,
    agentId: inspect.agentId,
    requestId: inspect.target.inventoryRequestId,
    cwd: inspect.cwd,
  };
  const h = await begin(inspect, wire.pendingCleanup, source, [
    wire.cleanupRecheckObserved.requestId,
  ]);
  expect(skillManagement.get(h.owner.agentId).unresolved).toBe(true);
  const cancel = vi
    .spyOn(mcpAddPort, "cancel")
    .mockResolvedValue(wire.cancellation);
  skillManagement.cancel(h.owner.agentId, wire.pendingCleanup.requestId);
  await flush();
  expect(cancel).toHaveBeenCalledWith({
    agentId: h.owner.agentId,
    requestId: wire.pendingCleanup.requestId,
  });
  expect(skillManagement.get(h.owner.agentId).unresolved).toBe(true);
  expect(skillManagement.get(h.owner.agentId).additionInput).toBeNull();
  vi.spyOn(mcpAddPort, "status").mockResolvedValue(wire.cancelledAfterWrite);
  skillManagement.check(h.owner.agentId, wire.pendingCleanup.requestId);
  await flush();
  expect(skillManagement.get(h.owner.agentId).operation).toEqual(
    wire.cancelledAfterWrite,
  );
  vi.spyOn(mcpAddPort, "recheck").mockResolvedValue(
    wire.cleanupRecheckObserved,
  );
  expect(
    skillManagement.recheck(h.owner.agentId, wire.pendingCleanup.requestId),
  ).toBe(true);
  await flush();
  expect(skillManagement.get(h.owner.agentId).operation).toEqual(
    wire.cleanupRecheckObserved,
  );
  expect(skillManagement.get(h.owner.agentId).originalOperation).toEqual(
    wire.cancelledAfterWrite,
  );
  expect(h.render()).not.toContain("HTTP_URL_CANARY");
  expect(h.confirm).toHaveBeenCalledTimes(1);
});
