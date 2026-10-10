import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  parseInventoryOperation,
  parseExtensionCapabilities,
} from "./extension_inventory_types";
import {
  parseMcpRemoveOperation,
  parseMcpRemoveCancellation,
  type McpRemoveRequest,
} from "./mcp_remove_types";
import { extensionInventory } from "./extension_inventory_controller";
import { inventoryPort } from "./extension_inventory";
import { skillManagement } from "./skill_management_controller";
import { mcpRemovePort } from "./mcp_remove";
import { SkillChangeReview } from "../components/SkillChangeReview";
import { flush } from "./extension_inventory.test-support";
const wire = JSON.parse(
  readFileSync(
    "docs/evidence/2026-10-09-capability-hardening/mcp-remove/backend/actual-wire.json",
    "utf8",
  ),
);
const values: [string, any][] = [];
function collect(v: any, path: string) {
  if (!v || typeof v !== "object") return;
  if (
    "cancelRequested" in v ||
    "mcpInventory" in v ||
    ("requestId" in v && ("action" in v || "kind" in v))
  )
    values.push([path, v]);
  else for (const [k, x] of Object.entries(v)) collect(x, `${path}.${k}`);
}
collect(wire, "wire");
const request = (v: any): McpRemoveRequest => ({
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
for (const [label, v] of values)
  it("accepts exact actual Rust fields: " + label, () => {
    if ("cancelRequested" in v)
      expect(
        parseMcpRemoveCancellation(v, v.operation ? request(v.operation) : v),
      ).toEqual(v.operation);
    else if ("mcpInventory" in v)
      expect(parseExtensionCapabilities(v)).toEqual(v);
    else
      expect(
        v.kind === "mcp"
          ? parseInventoryOperation(v, v)
          : parseMcpRemoveOperation(v, request(v)),
      ).toEqual(v);
  });
async function begin(inspection: any, done: any, check?: any) {
  const source = values
    .map(([, v]) => v)
    .find(
      (v) =>
        v.kind === "mcp" &&
        v.requestId === inspection.target.inventoryRequestId,
    );
  expect(source).toBeTruthy();
  vi.useFakeTimers();
  vi.setSystemTime(inspection.review.observedAtMs);
  const ids = [
    source.requestId,
    inspection.requestId,
    done.requestId,
    ...(check ? [check.requestId] : []),
  ];
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => ids.shift()!);
  const owner = { agentId: source.agentId, token: {}, current: () => true };
  vi.spyOn(inventoryPort, "read").mockResolvedValue(source);
  vi.spyOn(inventoryPort, "cancel").mockResolvedValue(null);
  vi.spyOn(mcpRemovePort, "inspect").mockResolvedValue(inspection);
  const confirm = vi.spyOn(mcpRemovePort, "confirm").mockResolvedValue(done);
  extensionInventory.begin(owner, source.cwd, source.requestId, "mcp");
  await flush();
  const result = extensionInventory.get(owner.agentId).results.mcp!;
  if (result.snapshot.source !== "officialCli")
    throw new Error("actual wire inventory kind");
  expect(
    skillManagement.inspect({
      kind: "mcpRemoval",
      owner,
      result,
      item: result.snapshot.items[inspection.target.itemId],
      current: () => extensionInventory.isCurrentResult(owner, result),
      changed: () => extensionInventory.markStale(result),
    }),
  ).toBe(true);
  await flush();
  expect(skillManagement.get(owner.agentId).operation).toEqual(inspection);
  expect(confirm).not.toHaveBeenCalled();
  const render = () =>
    renderToStaticMarkup(
      <SkillChangeReview agentId={owner.agentId} owner={owner} active />,
    );
  expect(render()).toContain("确认移除配置");
  expect(render()).not.toContain("确认停用偏好");
  expect(
    skillManagement.confirm(owner, skillManagement.get(owner.agentId).review!),
  ).toBe(true);
  await flush();
  expect(skillManagement.get(owner.agentId).operation).toEqual(done);
  return { owner, render, confirm };
}
it("shows the actual same-chain inventory/review/removal without substituting disabled state for absence", async () => {
  const h = await begin(wire.inspection, wire.verified);
  expect(h.render()).toContain("所选配置条目已移除");
  expect(h.render()).toContain("MCP 配置容器：仍有配置内容");
  expect(h.confirm).toHaveBeenCalledTimes(1);
});
it.each(["lost-ack", "refused"])(
  "retains actual original %s while showing an independent observed result",
  async (label) => {
    const { inspection, original, recheck } = wire[label];
    vi.spyOn(mcpRemovePort, "recheck").mockResolvedValue(recheck);
    const h = await begin(inspection, original, recheck);
    const before = structuredClone(
      skillManagement.get(h.owner.agentId).operation,
    );
    expect(skillManagement.recheck(h.owner.agentId, original.requestId)).toBe(
      true,
    );
    await flush();
    expect(skillManagement.get(h.owner.agentId).operation).toEqual(recheck);
    expect(skillManagement.get(h.owner.agentId).originalOperation).toEqual(
      before,
    );
    expect(h.render()).toContain(
      label === "refused" ? "官方程序拒绝了本次移除" : "本次移除结果仍未确认",
    );
    expect(h.render()).toContain("不能据此确认此前移除是否成功");
    expect(h.render()).not.toContain("所选配置条目已移除");
    expect(h.confirm).toHaveBeenCalledTimes(1);
  },
);
it.each(["disabled-layer", "inspectCancelled"])(
  "settles actual %s without another write or confirmation",
  async (label) => {
    const failure = wire[label];
    // Only this prerequisite inventory envelope is controlled; all failed
    // operation bytes are exactly the actual Rust output from the owned peer.
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
    vi.spyOn(mcpRemovePort, "inspect").mockResolvedValue(failure);
    const confirm = vi.spyOn(mcpRemovePort, "confirm");
    extensionInventory.begin(owner, source.cwd, source.requestId, "mcp");
    await flush();
    const result = extensionInventory.get(owner.agentId).results.mcp!;
    if (result.snapshot.source !== "officialCli")
      throw new Error("fixture domain");
    expect(
      skillManagement.inspect({
        kind: "mcpRemoval",
        owner,
        result,
        item: result.snapshot.items[failure.target.itemId],
        current: () => extensionInventory.isCurrentResult(owner, result),
        changed: () => extensionInventory.markStale(result),
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
    expect(html).not.toContain("确认移除配置");
    expect(confirm).not.toHaveBeenCalled();
  },
);
