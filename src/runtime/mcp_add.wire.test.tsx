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
    "docs/evidence/2026-10-09-capability-hardening/mcp-add/backend/actual-wire.json",
    "utf8",
  ),
);
const input = {
  name: "sample.new",
  executablePath: "/synthetic/unexecuted program",
  args: ["", "one two", "--literal=$NOT_EXPANDED"],
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
      if ("cancelRequested" in value) {
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
  expect(render()).toContain("&quot;/synthetic/unexecuted program&quot;");
  expect(render()).toContain("--literal=$NOT_EXPANDED");
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
it("uses actual empty catalogue, inspection and verified write through the real shared controller and review", async () => {
  const h = await begin(wire.inspection, wire.verified, wire.inventory);
  expect(h.render()).toContain("已添加，保持停用");
  expect(h.confirm).toHaveBeenCalledTimes(1);
});
it("preserves actual lost-ack and read-only observed replies without resending the addition", async () => {
  // The additional chain has actual inspection/write/recheck replies but not its
  // catalogue envelope; only this empty catalogue prerequisite is a controlled seed.
  const inspection = wire.unknownInspection;
  const source = {
    ...wire.inventory,
    agentId: inspection.agentId,
    requestId: inspection.target.inventoryRequestId,
    cwd: inspection.cwd,
  };
  const check = vi.spyOn(mcpAddPort, "recheck").mockResolvedValue(wire.recheck);
  const h = await begin(inspection, wire.unknown, source, [
    wire.recheck.requestId,
  ]);
  expect(h.render()).toContain("本次修改结果仍未确认");
  expect(skillManagement.recheck(h.owner.agentId, wire.unknown.requestId)).toBe(
    true,
  );
  await flush();
  expect(skillManagement.get(h.owner.agentId).operation).toEqual(wire.recheck);
  expect(check).toHaveBeenCalledExactlyOnceWith({
    agentId: h.owner.agentId,
    requestId: wire.recheck.requestId,
    operationId: wire.unknown.requestId,
  });
  expect(h.render()).toContain("不能据此确认此前添加是否成功");
  expect(h.confirm).toHaveBeenCalledTimes(1);
});

it.each(["inspectNameConflict", "inspectCancelled"])(
  "ends tracking the actual %s without offering confirmation or claiming an expired review",
  async (label) => {
    const failure = wire[label];
    // Only the prerequisite catalogue is controlled; the failed operation stays
    // exactly as serialized by the actual backend admission/worker path.
    const source = {
      ...wire.inventory,
      agentId: failure.agentId,
      requestId: failure.target.inventoryRequestId,
      cwd: failure.cwd,
    };
    const ids = [source.requestId, failure.requestId];
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => ids.shift()!);
    const owner = { agentId: source.agentId, token: {}, current: () => true };
    vi.spyOn(inventoryPort, "read").mockResolvedValue(source);
    vi.spyOn(inventoryPort, "cancel").mockResolvedValue(null);
    vi.spyOn(mcpAddPort, "inspect").mockResolvedValue(failure);
    const confirm = vi.spyOn(mcpAddPort, "confirm");
    extensionInventory.begin(owner, source.cwd, source.requestId, "mcp");
    await flush();
    const inventory = extensionInventory.get(owner.agentId).results.mcp!;
    expect(
      skillManagement.inspect({
        kind: "mcpAddition",
        owner,
        result: inventory,
        inputId: failure.target.inputId,
        input,
        current: () => extensionInventory.isCurrentResult(owner, inventory),
        changed: () => extensionInventory.markStale(inventory),
      }),
    ).toBe(true);
    await flush();
    const view = skillManagement.get(owner.agentId);
    expect(view.operation).toEqual(failure);
    expect(view.unresolved).toBe(false);
    expect(view.review).toBeNull();
    const html = renderToStaticMarkup(
      <SkillChangeReview agentId={owner.agentId} owner={owner} active />,
    );
    expect(html).toContain("本次没有发出配置修改请求");
    expect(html).not.toContain("审阅已失效");
    expect(html).not.toContain("确认添加并保持停用");
    expect(confirm).not.toHaveBeenCalled();
  },
);
