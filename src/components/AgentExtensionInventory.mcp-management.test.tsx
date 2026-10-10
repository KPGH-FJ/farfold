import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentExtensionInventoryResult } from "./AgentExtensionInventoryResult";
import type { InventoryResult } from "../runtime/extension_inventory_controller";

const result: InventoryResult = {
  cwd: "/controlled",
  stale: false,
  owner: { agentId: "controlled", token: {}, current: () => true },
  request: {
    agentId: "controlled",
    kind: "mcp",
    cwd: "/controlled",
    requestId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  },
  snapshot: {
    source: "officialCli",
    scope: "officialCliConfigurationForDirectory",
    observedAtMs: 1,
    complete: true,
    sessionApplicability: "unverified",
    items: [
      {
        id: 0,
        name: "local-tools",
        transport: "stdio",
        reportedEnabled: true,
        reportedAuth: "unsupported",
        origin: "unreported",
        configurationLayer: "unreported",
        connection: "unverified",
        tools: "unreported",
        ...{ enablement: { availability: "available" as const } },
      },
    ],
  },
};
it("offers an explicit review of an eligible MCP preference without implying a live connection", () => {
  const inspect = vi.fn();
  const html = renderToStaticMarkup(
    <AgentExtensionInventoryResult
      result={result}
      stale={false}
      management={{ enabled: true, inspect }}
    />,
  );
  expect(html).toContain("审阅停用偏好…");
  expect(html).toContain("审阅启用偏好…");
  expect(html).toContain("保存的启用偏好不代表当前对话的连接或工具状态");
  expect(inspect).not.toHaveBeenCalled();
});
it("does not allow an old MCP report to grant another review", () => {
  const html = renderToStaticMarkup(
    <AgentExtensionInventoryResult
      result={result}
      stale
      management={{ enabled: true, inspect: vi.fn() }}
    />,
  );
  expect(html).toMatch(/disabled=""[^>]*>审阅停用偏好…/);
});
