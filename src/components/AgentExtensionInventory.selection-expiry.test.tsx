import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { invoke } from "@tauri-apps/api/core";
import { AgentExtensionInventory } from "./AgentExtensionInventory";
import { SkillChangeReview } from "./SkillChangeReview";
import { inventoryPort } from "../runtime/extension_inventory";
import { extensionInventory } from "../runtime/extension_inventory_controller";
import { skillManagementPort } from "../runtime/skill_management";
import { skillManagement } from "../runtime/skill_management_controller";
import { flush } from "../runtime/extension_inventory.test-support";
import { item, operation } from "../runtime/skill_management.test-support";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const ticket = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const explanation = "读取方式已失效或发生变化，请重新检查读取方式。";
const ownerFor = (agentId: string) => ({
  agentId,
  token: {},
  current: () => true,
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(invoke).mockReset();
});

function mockSkillRead() {
  return vi
    .spyOn(inventoryPort, "read")
    .mockImplementation(async ({ selectionId: _, ...request }) => ({
      ...request,
      state: "ready",
      settled: true,
      snapshot: {
        observedAtMs: 1,
        source: "officialAppServer",
        scope: "officialSkillsForDirectory",
        complete: true,
        errorCount: 0,
        sessionApplicability: "unverified",
        items: [item],
      },
    }));
}

it.each(["mcp", "skills"] as const)(
  "renders a %s selection refusal without asserting that the user's program changed",
  async (kind) => {
    const owner = ownerFor(`expired-${kind}`);
    const read = vi
      .spyOn(inventoryPort, "read")
      .mockImplementation(async ({ selectionId: _, ...request }) => ({
        ...request,
        state: "failed",
        settled: true,
        code: "selectionChanged",
      }));
    expect(extensionInventory.begin(owner, "/controlled", ticket, kind)).toBe(
      true,
    );
    await flush();
    expect(extensionInventory.get(owner.agentId).error).toBe(
      "selectionChanged",
    );
    const html = renderToStaticMarkup(
      <AgentExtensionInventory
        agentId={owner.agentId}
        selection={owner.token}
        active
      />,
    );
    expect(html).toContain(explanation);
    expect(html).not.toContain("Agent 或程序选择已变化");
    expect(html).toContain("重新检查读取方式</button>");
    expect(read).toHaveBeenCalledTimes(1);
  },
);

it("uses the same accurate explanation for a management inspection refusal without confirming or retrying", async () => {
  const owner = ownerFor("expired-management");
  mockSkillRead();
  extensionInventory.begin(owner, "/controlled", ticket, "skills");
  await flush();
  const result = extensionInventory.get(owner.agentId).results.skills!;
  const inspect = vi
    .spyOn(skillManagementPort, "inspect")
    .mockImplementation(async () => ({
      ...operation(skillManagement.get(owner.agentId).request!),
      state: "failed",
      phase: "complete",
      settled: true,
      code: "selectionChanged",
    }));
  const confirm = vi.spyOn(skillManagementPort, "confirm");
  expect(
    skillManagement.inspect({
      owner,
      result,
      item: result.snapshot.items[0] as typeof item,
      current: () => extensionInventory.isCurrentResult(owner, result),
      changed: () => extensionInventory.markStale(result),
    }),
  ).toBe(true);
  await flush();
  expect(skillManagement.get(owner.agentId).error).toBe("selectionChanged");
  const html = renderToStaticMarkup(
    <SkillChangeReview agentId={owner.agentId} owner={owner} active />,
  );
  expect(html).toContain(explanation);
  expect(html).not.toContain("Agent 或程序选择已变化");
  expect(html).not.toContain("确认启用</button>");
  expect(html).not.toContain("确认停用</button>");
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(confirm).not.toHaveBeenCalled();
});

it("releases an inspection refused before admission when its original list expires", async () => {
  const owner = ownerFor("expired-inventory-management");
  const expiry = "此前清单已失效。请重新检查读取方式，再查询清单。";
  const renderReview = (current: typeof owner) =>
    renderToStaticMarkup(
      <SkillChangeReview agentId={current.agentId} owner={current} active />,
    );
  const read = mockSkillRead();
  vi.mocked(invoke).mockRejectedValueOnce({ code: "inventoryExpired" });
  expect(extensionInventory.begin(owner, "/controlled", ticket, "skills")).toBe(
    true,
  );
  await flush();
  const result = extensionInventory.get(owner.agentId).results.skills!;
  expect(
    skillManagement.inspect({
      owner,
      result,
      item: result.snapshot.items[0] as typeof item,
      current: () => extensionInventory.isCurrentResult(owner, result),
      changed: () => extensionInventory.markStale(result),
    }),
  ).toBe(true);
  await flush();
  const view = skillManagement.get(owner.agentId);
  expect(invoke).toHaveBeenCalledWith("agent_skill_change_inspect", {
    agentId: owner.agentId,
    requestId: view.request?.requestId,
    inventoryRequestId: result.request.requestId,
    itemId: 0,
    enabled: true,
  });
  expect(view).toMatchObject({
    error: "inventoryExpired",
    unresolved: false,
    operation: null,
    review: null,
  });
  expect(extensionInventory.get(owner.agentId).results.skills?.stale).toBe(
    true,
  );
  const html = renderReview(owner);
  expect(html).toContain(expiry);
  expect(html).not.toContain("请求取消本次操作</button>");
  expect(html).not.toContain("检查操作状态</button>");
  expect(read).toHaveBeenCalledTimes(1);
  const renewed = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const nextOwner = ownerFor(owner.agentId);
  const deliverResultChange = () =>
    skillManagement.retireInspectionForResult(
      nextOwner,
      extensionInventory.get(owner.agentId).results.skills,
    );
  extensionInventory.retire(owner);
  skillManagement.retire(owner);
  read.mockImplementationOnce(async ({ selectionId: _, ...request }) => ({
    ...request,
    state: "failed",
    settled: true,
    code: "queryFailed",
  }));
  expect(
    extensionInventory.begin(nextOwner, "/controlled", renewed, "skills"),
  ).toBe(true);
  deliverResultChange();
  expect(renderReview(nextOwner)).toContain(expiry);
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  deliverResultChange();
  expect(renderReview(nextOwner)).toContain(expiry);
  expect(
    extensionInventory.begin(nextOwner, "/controlled", renewed, "skills"),
  ).toBe(true);
  await flush();
  expect(read).toHaveBeenCalledTimes(3);
  expect(read).toHaveBeenLastCalledWith(
    expect.objectContaining({ selectionId: renewed }),
  );
  expect(extensionInventory.get(owner.agentId).results.skills?.stale).toBe(
    false,
  );
  const callsBeforeRecovery = vi.mocked(invoke).mock.calls.length;
  deliverResultChange();
  expect(renderReview(nextOwner)).not.toContain(expiry);
  await flush();
  expect(invoke).toHaveBeenCalledTimes(callsBeforeRecovery);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "agent_skill_change_inspect",
    "agent_extension_inventory_cancel",
    "agent_extension_inventory_cancel",
  ]);
});
