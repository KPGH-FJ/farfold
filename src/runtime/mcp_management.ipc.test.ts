import { expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { mcpManagementPort as port } from "./mcp_management";

it("uses the five fixed MCP commands with flat arguments and no configuration authority", async () => {
  const ref = { agentId: "fixture", requestId: "request" };
  const inspect = {
    ...ref,
    inventoryRequestId: "inventory",
    itemId: 0,
    enabled: false,
  };
  const confirm = { ...ref, reviewId: "review" };
  const recheck = { ...ref, operationId: "operation" };
  await port.inspect(inspect);
  await port.confirm(confirm);
  await port.status(ref);
  await port.cancel(ref);
  await port.recheck(recheck);
  expect(invoke.mock.calls).toEqual([
    ["agent_mcp_change_inspect", inspect],
    ["agent_mcp_change_confirm", confirm],
    ["agent_mcp_change_status", ref],
    ["agent_mcp_change_cancel", ref],
    ["agent_mcp_change_recheck", recheck],
  ]);
});
