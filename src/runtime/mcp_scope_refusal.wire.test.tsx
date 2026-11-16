import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import actualWire from "./fixtures/mcp-scope-refusals-wire.json";
import {
  parseMcpChangeOperation,
  type McpChangeOperation,
  type McpChangeRequest,
} from "./mcp_management_types";
import { extensionInventory } from "./extension_inventory_controller";
import { inventoryPort } from "./extension_inventory";
import { skillManagement } from "./skill_management_controller";
import { mcpManagementPort } from "./mcp_management";
import { SkillChangeReview } from "../components/SkillChangeReview";
import { MCP_MANAGEMENT_STRINGS as S } from "./mcp_management_strings";
import { flush } from "./extension_inventory.test-support";

// Byte-preserved public DTOs from the real Rust registry/exchange/process.
// Only the IPC delivery is substituted; the peer's owned data is synthetic.
const wires = actualWire as unknown as {
  case: "project" | "inherited" | "conflict";
  inventory: any;
  operation: McpChangeOperation;
}[];
const request = (op: McpChangeOperation): McpChangeRequest => ({
  agentId: op.agentId,
  requestId: op.requestId,
  action: op.action,
  cwd: op.cwd,
  target: op.target,
  requestedEnabled: op.requestedEnabled,
  operationId: op.operationId,
});

afterEach(() => vi.restoreAllMocks());

for (const wire of wires) {
  it.each(["fresh", "after collapse retirement"] as const)(
    `keeps the actual ${wire.case} refusal %s without implying an expired review`,
    async (phase) => {
      const op = wire.operation;
      expect(parseMcpChangeOperation(op, request(op))).toEqual(op);
      const ids = [wire.inventory.requestId, op.requestId];
      vi.spyOn(crypto, "randomUUID").mockImplementation(() => ids.shift()!);
      vi.spyOn(inventoryPort, "read").mockResolvedValue(wire.inventory);
      vi.spyOn(mcpManagementPort, "inspect").mockResolvedValue(op);
      vi.spyOn(mcpManagementPort, "cancel").mockResolvedValue(null);
      const confirm = vi.spyOn(mcpManagementPort, "confirm");
      const owner = { agentId: op.agentId, token: {}, current: () => true };
      extensionInventory.begin(owner, op.cwd, wire.inventory.requestId, "mcp");
      await flush();
      const result = extensionInventory.get(owner.agentId).results.mcp!;
      expect(
        skillManagement.inspect({
          owner,
          result,
          item: result.snapshot.items[0],
          requestedEnabled: false,
          current: () => extensionInventory.isCurrentResult(owner, result),
          changed: () => extensionInventory.markStale(result),
        }),
      ).toBe(true);
      await flush();
      const view = skillManagement.get(owner.agentId);
      expect(view.operation).toEqual(op);
      expect(view.error).toBe(op.code);
      expect(view.review).toBeNull();
      expect(view.reviewRetired).toBe(false);
      expect(view.unresolved).toBe(false);
      if (phase === "after collapse retirement") {
        // Collapse retires the controller entry. Render the same retained request
        // again, as reopening does; this is SSR state coverage, not a DOM click.
        skillManagement.retire(owner);
        await flush();
        expect(skillManagement.get(owner.agentId).reviewRetired).toBe(true);
        expect(skillManagement.get(owner.agentId).operation).toEqual(op);
      }
      const html = renderToStaticMarkup(
        <SkillChangeReview agentId={owner.agentId} owner={owner} active />,
      );
      expect(html).toContain(S.errors[op.code!]);
      expect(html).toContain(
        {
          project: "在项目设置中定义",
          inherited: "来自继承的设置",
          conflict: "同名 MCP 出现在多处设置中",
        }[wire.case],
      );
      expect(html).not.toContain(S.errors.configurationUnsupported);
      expect(html).not.toContain(S.retired);
      expect(html).not.toContain("确认停用偏好");
      expect(html).not.toContain("均已核对为所选状态");
      expect(html).not.toContain("never-public-value");
      expect(html).not.toContain("do-not-show");
      expect(html).not.toContain("layer.json");
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  it(`never presents the ${wire.case} no-write reason for a dispatched change or cancellation`, () => {
    const changed = {
      ...wire.operation,
      action: "setEnabled" as const,
      writeDispatched: true,
      writeAck: "unknown" as const,
      outcome: "unknown" as const,
    };
    expect(() => parseMcpChangeOperation(changed, request(changed))).toThrow();
    const cancelled = { ...wire.operation, state: "cancelled" as const };
    expect(() =>
      parseMcpChangeOperation(cancelled, request(cancelled)),
    ).toThrow();
  });
}
