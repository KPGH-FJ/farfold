import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentExtensionInventory } from "./AgentExtensionInventory";
import { SkillChangeReview } from "./SkillChangeReview";
import { inventoryPort } from "../runtime/extension_inventory";
import { extensionInventory } from "../runtime/extension_inventory_controller";
import { skillManagementPort } from "../runtime/skill_management";
import { skillManagement } from "../runtime/skill_management_controller";
import { flush } from "../runtime/extension_inventory.test-support";
import { item, operation } from "../runtime/skill_management.test-support";

const ticket = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const explanation = "读取方式已失效或发生变化，请重新检查读取方式。";
const ownerFor = (agentId: string) => ({
  agentId,
  token: {},
  current: () => true,
});
afterEach(() => vi.restoreAllMocks());

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
  vi.spyOn(inventoryPort, "read").mockImplementation(
    async ({ selectionId: _, ...request }) => ({
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
    }),
  );
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
