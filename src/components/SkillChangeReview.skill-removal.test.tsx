import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillChangeReview } from "./SkillChangeReview";
import { extensionInventory } from "../runtime/extension_inventory_controller";
import { inventoryPort } from "../runtime/extension_inventory";
import { skillManagement } from "../runtime/skill_management_controller";
import { skillPreferenceRemovePort } from "../runtime/skill_preference_remove";
import {
  operation,
  written,
  iid,
} from "../runtime/skill_preference_remove.test-support";
import { item } from "../runtime/skill_management.test-support";
import { flush } from "../runtime/extension_inventory.test-support";

afterEach(() => vi.restoreAllMocks());
let n = 0;
async function setup(noPreference = false) {
  const owner = {
    agentId: `skill-clear-render-${++n}`,
    token: {},
    current: () => true,
  };
  vi.spyOn(inventoryPort, "read").mockImplementation(
    async ({ selectionId: _, ...r }) => ({
      ...r,
      state: "ready",
      settled: true,
      snapshot: {
        source: "officialAppServer",
        scope: "officialSkillsForDirectory",
        observedAtMs: 1,
        complete: true,
        sessionApplicability: "unverified",
        errorCount: 0,
        items: [item],
      },
    }),
  );
  vi.spyOn(inventoryPort, "cancel").mockResolvedValue(null);
  vi.spyOn(skillPreferenceRemovePort, "cancel").mockResolvedValue(null);
  vi.spyOn(skillPreferenceRemovePort, "inspect").mockImplementation(async () =>
    noPreference
      ? {
          ...operation(skillManagement.get(owner.agentId).request!, true),
          state: "failed",
          outcome: "notDispatched",
          code: "preferenceNotConfigured",
          review: null,
        }
      : operation(skillManagement.get(owner.agentId).request!, true),
  );
  const confirm = vi
    .spyOn(skillPreferenceRemovePort, "confirm")
    .mockImplementation(async () =>
      written(skillManagement.get(owner.agentId).request!),
    );
  extensionInventory.begin(owner, "/controlled", iid, "skills");
  await flush();
  const result = extensionInventory.get(owner.agentId).results.skills!;
  if (result.snapshot.source !== "officialAppServer")
    throw new Error("fixture domain");
  skillManagement.inspect({
    kind: "skillPreferenceRemoval",
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

it("reviews clearing one path preference separately from enabling or deleting a skill", async () => {
  const h = await setup(),
    html = h.render();
  expect(html).toContain("清除技能启停偏好");
  expect(html).toContain("所选操作：清除这一技能位置的启停偏好");
  expect(html).toContain("此位置的启停偏好：未启用");
  expect(html).toContain("其他范围的规则仍可能生效");
  expect(html).toContain("不删除技能文件");
  expect(html.match(/<button[^>]*>确认清除偏好<\/button>/)?.[0]).not.toContain(
    "disabled",
  );
  expect(h.confirm).not.toHaveBeenCalled();
  expect(html).not.toContain("MCP");
  await h.confirmReview();
  const after = h.render();
  expect(after).toContain("此位置的启停偏好已清除，当前技能状态已核对");
  expect(after).toContain("此次技能报告：未启用");
  expect(after).toContain("技能设置：仍有其他配置内容");
  expect(after).not.toContain("已恢复默认");
  expect(after).not.toContain("MCP");
});

it("explains an absent preference without directing a redundant fresh query", async () => {
  const h = await setup(true),
    html = h.render();
  expect(html).toContain("此技能位置未保存启停偏好，无需清除");
  expect(html).not.toContain("此次清除审阅已失效");
  expect(html).not.toContain("确认清除偏好");
  expect(h.confirm).not.toHaveBeenCalled();
});

it("keeps the original unknown write distinct from later observed removal", async () => {
  const h = await setup();
  h.confirm.mockImplementation(async () =>
    written(skillManagement.get(h.owner.agentId).request!, true),
  );
  await h.confirmReview();
  vi.spyOn(skillPreferenceRemovePort, "recheck").mockImplementation(
    async () => ({
      ...written(skillManagement.get(h.owner.agentId).request!),
      writeAck: "unknown",
    }),
  );
  skillManagement.recheck(
    h.owner.agentId,
    skillManagement.get(h.owner.agentId).request!.requestId,
  );
  await flush();
  const html = h.render();
  expect(html).toContain("此前清除请求的结果");
  expect(html).toContain("本次清除结果仍未确认");
  expect(html).toContain("不能据此确认此前修改是否成功");
  expect(html).not.toContain("此位置的启停偏好已清除，当前技能状态已核对");
  expect(h.confirm).toHaveBeenCalledOnce();
});

it("shows actual missing skill and configuration differences without claiming success", async () => {
  const h = await setup();
  h.confirm.mockImplementation(async () => ({
    ...written(skillManagement.get(h.owner.agentId).request!),
    outcome: "mismatch",
    observation: {
      observedAtMs: Date.now(),
      configuration: "different",
      skill: "missing",
      configuredEnabled: false,
      reportedEnabled: null,
      parentOutcome: "nonempty",
      sessionApplicability: "unverified",
    },
  }));
  await h.confirmReview();
  const html = h.render();
  expect(html).toContain("此次配置或技能报告与清除预期不同");
  expect(html).toContain("此次未找到该技能");
  expect(html).toContain("此位置的启停偏好：未启用");
  expect(html).not.toContain("已核对此位置的启停偏好不在用户配置中");
});
