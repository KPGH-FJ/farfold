import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillChangeReview } from "./SkillChangeReview";
import { extensionInventory } from "../runtime/extension_inventory_controller";
import { inventoryPort } from "../runtime/extension_inventory";
import { skillManagement } from "../runtime/skill_management_controller";
import { mcpManagementPort } from "../runtime/mcp_management";
import {
  operation,
  written,
  snapshot,
  id,
} from "../runtime/mcp_management.test-support";
import { flush } from "../runtime/extension_inventory.test-support";
afterEach(() => vi.restoreAllMocks());

it("renders the actual shared review with separate saved and reported values and scope consequences", async () => {
  const owner = {
    agentId: "mcp-review-render",
    token: {},
    current: () => true,
  };
  vi.spyOn(inventoryPort, "read").mockImplementation(
    async ({ selectionId: _, ...r }) => ({
      ...r,
      state: "ready",
      settled: true,
      snapshot,
    }),
  );
  vi.spyOn(inventoryPort, "cancel").mockResolvedValue(null);
  vi.spyOn(mcpManagementPort, "inspect").mockImplementation(async () => {
    const op = operation(skillManagement.get(owner.agentId).request!, true);
    return { ...op, review: { ...op.review, configuredEnabled: false } };
  });
  const confirm = vi
    .spyOn(mcpManagementPort, "confirm")
    .mockImplementation(async () => ({
      ...written(skillManagement.get(owner.agentId).request!, true),
      state: "failed",
      code: "writeUncertain",
      observation: null,
    }));
  vi.spyOn(mcpManagementPort, "recheck").mockImplementation(async () =>
    written(skillManagement.get(owner.agentId).request!, true),
  );
  extensionInventory.begin(owner, "/controlled", id, "mcp");
  await flush();
  const result = extensionInventory.get(owner.agentId).results.mcp!;
  skillManagement.inspect({
    requestedEnabled: false,
    owner,
    result,
    item: result.snapshot.items[0],
    current: () => extensionInventory.isCurrentResult(owner, result),
    changed: () => extensionInventory.markStale(result),
  });
  await flush();
  const render = () =>
    renderToStaticMarkup(
      <SkillChangeReview agentId={owner.agentId} owner={owner} active />,
    );
  let html = render();
  expect(html).toContain("MCP 启用偏好");
  expect(html).toContain("用户配置中的偏好：停用");
  expect(html).toContain("此文件夹的配置报告：启用");
  expect(html).toContain("以后沿用同一设置的其他对话");
  expect(html).toContain("配置文件的注释与排版可能变化");
  expect(html).toContain("不代表当前对话的连接或工具状态");
  expect(html).not.toContain("技能");
  expect(confirm).not.toHaveBeenCalled();
  skillManagement.confirm(owner, skillManagement.get(owner.agentId).review!);
  await flush();
  html = render();
  expect(html).toContain("本次修改结果仍未确认");
  expect(html).toContain("核对修改结果");
  skillManagement.recheck(
    owner.agentId,
    skillManagement.get(owner.agentId).request!.requestId,
  );
  await flush();
  html = render();
  expect(html).toContain("不能据此确认此前修改是否成功");
  expect(html).not.toContain("均已核对为所选状态");
  expect(confirm).toHaveBeenCalledTimes(1);
});
