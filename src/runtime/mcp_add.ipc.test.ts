import { expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
import { mcpAddPort } from "./mcp_add";
import { input, request } from "./mcp_add.test-support";
it("uses five fixed flat addition endpoints and never supplies config authority or launch argv", async () => {
  const key = { agentId: request.agentId, requestId: request.requestId };
  const inspect = {
    ...key,
    inventoryRequestId: request.target.inventoryRequestId,
    inputId: request.target.inputId,
    input,
  };
  await mcpAddPort.inspect(inspect);
  await mcpAddPort.confirm({ ...key, reviewId: request.requestId });
  await mcpAddPort.status(key);
  await mcpAddPort.cancel(key);
  await mcpAddPort.recheck({ ...key, operationId: request.requestId });
  expect(h.invoke.mock.calls).toEqual([
    ["agent_mcp_add_inspect", inspect],
    ["agent_mcp_add_confirm", { ...key, reviewId: request.requestId }],
    ["agent_mcp_add_status", key],
    ["agent_mcp_add_cancel", key],
    ["agent_mcp_add_recheck", { ...key, operationId: request.requestId }],
  ]);
});
