import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillChangeReview } from "./SkillChangeReview";
import { extensionInventory } from "../runtime/extension_inventory_controller";
import { inventoryPort } from "../runtime/extension_inventory";
import { skillManagement } from "../runtime/skill_management_controller";
import { mcpRemovePort } from "../runtime/mcp_remove";
import {
  operation,
  written,
  snapshot,
  id,
} from "../runtime/mcp_remove.test-support";
import { flush } from "../runtime/extension_inventory.test-support";
afterEach(() => vi.restoreAllMocks());
let n = 0;
async function setup() {
  const owner = {
    agentId: `remove-render-${++n}`,
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
  vi.spyOn(mcpRemovePort, "cancel").mockResolvedValue(null);
  vi.spyOn(mcpRemovePort, "inspect").mockImplementation(async () =>
    operation(skillManagement.get(owner.agentId).request!, true),
  );
  const confirm = vi
    .spyOn(mcpRemovePort, "confirm")
    .mockImplementation(async () =>
      written(skillManagement.get(owner.agentId).request!),
    );
  extensionInventory.begin(owner, "/controlled", id, "mcp");
  await flush();
  const result = extensionInventory.get(owner.agentId).results.mcp!;
  if (result.snapshot.source !== "officialCli")
    throw new Error("fixture domain");
  skillManagement.inspect({
    kind: "mcpRemoval",
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
  const confirmReview = async () => {
    skillManagement.confirm(owner, skillManagement.get(owner.agentId).review!);
    await flush();
  };
  return { owner, render, confirm, confirmReview };
}
it("allows a separate explicit remove confirmation without requiring addition input", async () => {
  const h = await setup(),
    html = h.render();
  expect(html).toContain("移除 MCP 配置");
  expect(html).toContain("所选操作：移除已停用的配置条目");
  const button = html.match(/<button[^>]*>确认移除配置<\/button>/)?.[0];
  expect(button).toBeTruthy();
  expect(button).not.toContain("disabled");
  expect(h.confirm).not.toHaveBeenCalled();
  expect(html).not.toContain("确认停用偏好");
  expect(html).toContain("可能保留空的 MCP 配置容器");
  expect(html).toContain("移除配置不代表已断开当前连接或停止程序");
  expect(html).toContain("以后沿用同一设置的其他对话");
  expect(html).toContain("配置文件的注释与排版可能变化");
  await h.confirmReview();
  expect(h.render()).toContain("此次完整配置报告中无此名称");
  expect(h.render()).toContain("MCP 配置容器：保留空容器");
});
it.each(["unknown", "rejected"] as const)(
  "displays the original %s fact separately from a later observed absence",
  async (ack) => {
    const h = await setup();
    h.confirm.mockImplementation(async () => ({
      ...written(skillManagement.get(h.owner.agentId).request!),
      state: "failed",
      writeAck: ack,
      outcome: ack,
      code: ack === "unknown" ? "writeUncertain" : "configurationRejected",
      observation: null,
    }));
    await h.confirmReview();
    vi.spyOn(mcpRemovePort, "recheck").mockImplementation(async () => ({
      ...written(skillManagement.get(h.owner.agentId).request!),
      writeAck: ack,
    }));
    skillManagement.recheck(
      h.owner.agentId,
      skillManagement.get(h.owner.agentId).request!.requestId,
    );
    await flush();
    const html = h.render();
    expect(html).toContain("此前移除请求的结果");
    expect(html).toContain(
      ack === "unknown" ? "本次移除结果仍未确认" : "官方程序拒绝了本次移除",
    );
    expect(html).toContain("不能据此确认此前移除是否成功");
    expect(html).not.toContain("所选配置条目已移除");
  },
);
it("renders still-present disabled as mismatch rather than absence", async () => {
  const h = await setup();
  h.confirm.mockImplementation(async () => {
    const op = written(skillManagement.get(h.owner.agentId).request!);
    return {
      ...op,
      outcome: "mismatch",
      observation: {
        ...op.observation,
        configuration: "different",
        mcp: "present",
        configuredEnabled: false,
        reportedEnabled: false,
        parentOutcome: "nonempty",
      },
    };
  });
  await h.confirmReview();
  const html = h.render();
  expect(html).toContain("此次完整配置报告中仍有此名称");
  expect(html).toContain("MCP 配置容器：仍有配置内容");
  expect(html).not.toContain("所选配置条目已移除");
});
it("distinguishes failed readonly recheck from the original rejected removal", async () => {
  const h = await setup();
  h.confirm.mockImplementation(async () => ({
    ...written(skillManagement.get(h.owner.agentId).request!),
    state: "failed",
    writeAck: "rejected",
    outcome: "rejected",
    code: "configurationChanged",
    observation: null,
  }));
  await h.confirmReview();
  vi.spyOn(mcpRemovePort, "recheck").mockImplementation(async () => ({
    ...written(skillManagement.get(h.owner.agentId).request!),
    state: "failed",
    writeAck: "rejected",
    outcome: "unknown",
    code: "queryFailed",
    observation: null,
  }));
  skillManagement.recheck(
    h.owner.agentId,
    skillManagement.get(h.owner.agentId).request!.requestId,
  );
  await flush();
  const html = h.render();
  expect(html).toContain("官方程序拒绝了本次移除");
  expect(html).toContain(
    "此次只读核对未能确认当前配置。此前请求的结果不变，不会再次移除。",
  );
  expect(html).not.toContain("本次移除结果仍未确认");
});
