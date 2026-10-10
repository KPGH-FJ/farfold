import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseInventoryOperation } from "./extension_inventory_types";
import {
  parseMcpChangeOperation,
  type McpChangeRequest,
} from "./mcp_management_types";
import { extensionInventory } from "./extension_inventory_controller";
import { inventoryPort } from "./extension_inventory";
import { skillManagement } from "./skill_management_controller";
import { mcpManagementPort } from "./mcp_management";
import { SkillChangeReview } from "../components/SkillChangeReview";
import { flush } from "./extension_inventory.test-support";

const wire = JSON.parse(
  readFileSync(
    "docs/evidence/2026-10-09-capability-hardening/mcp-management/backend/actual-wire.json",
    "utf8",
  ),
);
const finalWire = JSON.parse(
  readFileSync(
    "docs/evidence/2026-10-09-capability-hardening/mcp-management/backend/final-wire.json",
    "utf8",
  ),
);
const request = (v: any): McpChangeRequest => ({
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
    "accepts actual Rust MCP serialization without changing fields: " + label,
    () => {
      expect(
        value.kind === "mcp"
          ? parseInventoryOperation(value, value)
          : parseMcpChangeOperation(value, request(value)),
      ).toEqual(value);
    },
  );

it("drives the real shared controller and review through captured running/status/confirmation values", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(wire.inspectReady.review.observedAtMs);
  const ids = [
    wire.inventory.requestId,
    wire.inspectReady.requestId,
    wire.confirmReady.requestId,
  ];
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => ids.shift()!);
  const owner = {
    agentId: wire.inventory.agentId,
    token: {},
    current: () => true,
  };
  vi.spyOn(inventoryPort, "read").mockResolvedValue(wire.inventory);
  vi.spyOn(inventoryPort, "cancel").mockResolvedValue(null);
  vi.spyOn(mcpManagementPort, "inspect").mockResolvedValue(wire.inspectRunning);
  const status = vi
    .spyOn(mcpManagementPort, "status")
    .mockResolvedValueOnce(wire.inspectReady)
    .mockResolvedValueOnce(wire.confirmReady);
  const confirm = vi
    .spyOn(mcpManagementPort, "confirm")
    .mockResolvedValue(wire.confirmRunning);
  extensionInventory.begin(
    owner,
    wire.inventory.cwd,
    wire.inventory.requestId,
    "mcp",
  );
  await flush();
  const result = extensionInventory.get(owner.agentId).results.mcp!;
  expect(
    skillManagement.inspect({
      requestedEnabled: wire.inspectReady.requestedEnabled,
      owner,
      result,
      item: result.snapshot.items[0],
      current: () => extensionInventory.isCurrentResult(owner, result),
      changed: () => extensionInventory.markStale(result),
    }),
  ).toBe(true);
  await flush();
  expect(skillManagement.get(owner.agentId).operation).toEqual(
    wire.inspectRunning,
  );
  expect(skillManagement.get(owner.agentId).review).toBeNull();
  expect(confirm).not.toHaveBeenCalled();
  skillManagement.check(owner.agentId, wire.inspectReady.requestId);
  await flush();
  expect(skillManagement.get(owner.agentId).operation).toEqual(
    wire.inspectReady,
  );
  const render = () =>
    renderToStaticMarkup(
      <SkillChangeReview agentId={owner.agentId} owner={owner} active />,
    );
  expect(render()).toContain("确认停用偏好");
  expect(render()).toContain(wire.inspectReady.target.name);
  expect(
    skillManagement.confirm(owner, skillManagement.get(owner.agentId).review!),
  ).toBe(true);
  await flush();
  expect(confirm).toHaveBeenCalledExactlyOnceWith({
    agentId: owner.agentId,
    requestId: wire.confirmReady.requestId,
    reviewId: wire.inspectReady.review.reviewId,
  });
  expect(skillManagement.get(owner.agentId).operation).toEqual(
    wire.confirmRunning,
  );
  expect(render()).not.toContain("均已核对为所选状态");
  skillManagement.check(owner.agentId, wire.confirmReady.requestId);
  await flush();
  expect(skillManagement.get(owner.agentId).operation).toEqual(
    wire.confirmReady,
  );
  expect(render()).toContain("保存的偏好与此次配置报告均已核对为所选状态");
  expect(status).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledTimes(1);
});

for (const [label, value] of Object.entries(finalWire) as [string, any][])
  if (label !== "review")
    it(
      "accepts final actual Rust serialization without changing fields: " +
        label,
      () => {
        expect(
          value.kind === "mcp"
            ? parseInventoryOperation(value, value)
            : parseMcpChangeOperation(value, request(value)),
        ).toEqual(value);
      },
    );

it("keeps actual cleanup/uncertain/readback replies intact through a controlled inspection seed", async () => {
  // This second worker capture contains its real review but no inventory/inspect
  // envelope. Only those prerequisite envelopes below are controlled fixtures.
  // The three operation replies, original review and all their IDs stay intact.
  const { review, pendingCleanup, confirmUnknown, recheckObserved } = finalWire;
  vi.useFakeTimers();
  vi.setSystemTime(review.observedAtMs);
  const inspectionId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  const controlledInventory = {
    ...wire.inventory,
    agentId: review.agentId,
    cwd: review.cwd,
    requestId: review.target.inventoryRequestId,
  };
  const controlledInspection = {
    ...confirmUnknown,
    requestId: inspectionId,
    action: "inspect",
    state: "ready",
    phase: "complete",
    writeDispatched: false,
    writeAck: "none",
    outcome: null,
    code: null,
    review,
  };
  const ids = [
    controlledInventory.requestId,
    inspectionId,
    confirmUnknown.requestId,
    recheckObserved.requestId,
  ];
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => ids.shift()!);
  const owner = { agentId: review.agentId, token: {}, current: () => true };
  vi.spyOn(inventoryPort, "read").mockResolvedValue(controlledInventory);
  vi.spyOn(inventoryPort, "cancel").mockResolvedValue(null);
  vi.spyOn(mcpManagementPort, "inspect").mockResolvedValue(
    controlledInspection,
  );
  const confirm = vi
    .spyOn(mcpManagementPort, "confirm")
    .mockResolvedValue(pendingCleanup);
  vi.spyOn(mcpManagementPort, "status").mockResolvedValue(confirmUnknown);
  const recheck = vi
    .spyOn(mcpManagementPort, "recheck")
    .mockResolvedValue(recheckObserved);
  extensionInventory.begin(
    owner,
    review.cwd,
    controlledInventory.requestId,
    "mcp",
  );
  await flush();
  const result = extensionInventory.get(owner.agentId).results.mcp!;
  skillManagement.inspect({
    owner,
    result,
    item: result.snapshot.items[0],
    requestedEnabled: review.requestedEnabled,
    current: () => extensionInventory.isCurrentResult(owner, result),
    changed: () => extensionInventory.markStale(result),
  });
  await flush();
  expect(skillManagement.get(owner.agentId).review).toEqual(review);
  expect(confirm).not.toHaveBeenCalled();
  skillManagement.confirm(owner, skillManagement.get(owner.agentId).review!);
  await flush();
  expect(skillManagement.get(owner.agentId).operation).toEqual(pendingCleanup);
  expect(skillManagement.get(owner.agentId).unresolved).toBe(true);
  const render = () =>
    renderToStaticMarkup(
      <SkillChangeReview agentId={owner.agentId} owner={owner} active />,
    );
  expect(render()).toContain("尚未确认本次操作是否结束");
  expect(render()).not.toContain("均已核对为所选状态");
  skillManagement.check(owner.agentId, confirmUnknown.requestId);
  await flush();
  expect(skillManagement.get(owner.agentId).operation).toEqual(confirmUnknown);
  expect(render()).toContain("本次修改结果仍未确认");
  skillManagement.recheck(owner.agentId, confirmUnknown.requestId);
  await flush();
  expect(skillManagement.get(owner.agentId).operation).toEqual(recheckObserved);
  expect(recheck).toHaveBeenCalledExactlyOnceWith({
    agentId: owner.agentId,
    requestId: recheckObserved.requestId,
    operationId: confirmUnknown.requestId,
  });
  expect(render()).toContain("不能据此确认此前修改是否成功");
  expect(confirm).toHaveBeenCalledTimes(1);
});
