import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { mcpRemovePort } from "./mcp_remove";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
it("uses only removal commands with flat private-review references and never enabled/config authority", async () => {
  const key = {
    agentId: "controlled",
    requestId: "11111111-1111-1111-1111-111111111111",
  };
  const inspect = {
    ...key,
    inventoryRequestId: "22222222-2222-2222-2222-222222222222",
    itemId: 511,
  };
  await mcpRemovePort.inspect(inspect);
  await mcpRemovePort.confirm({
    ...key,
    reviewId: "33333333-3333-3333-3333-333333333333",
  });
  await mcpRemovePort.status(key);
  await mcpRemovePort.cancel(key);
  await mcpRemovePort.recheck({ ...key, operationId: key.requestId });
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["agent_mcp_remove_inspect", inspect],
    [
      "agent_mcp_remove_confirm",
      { ...key, reviewId: "33333333-3333-3333-3333-333333333333" },
    ],
    ["agent_mcp_remove_status", key],
    ["agent_mcp_remove_cancel", key],
    ["agent_mcp_remove_recheck", { ...key, operationId: key.requestId }],
  ]);
});
