import { vi } from "vitest";
import {
  ExtensionInventoryController,
  type InventoryOwner,
} from "./extension_inventory_controller";
import { SkillManagementController } from "./skill_management_controller";
import type { SkillManagementPort } from "./skill_management";
import type { InventoryPort } from "./extension_inventory";
import { deferred, flush } from "./extension_inventory.test-support";
import {
  isRemoveRequest,
  type ExtensionChangeRequest,
} from "./extension_management_types";
import type { McpRemoveRequest, McpRemoveOperation } from "./mcp_remove_types";
export const id = "11111111-1111-1111-1111-111111111111",
  reviewId = "22222222-2222-2222-2222-222222222222";
export const item = {
  id: 0,
  name: "local-tools",
  transport: "stdio" as const,
  reportedEnabled: false,
  reportedAuth: "unsupported" as const,
  origin: "unreported" as const,
  configurationLayer: "unreported" as const,
  connection: "unverified" as const,
  tools: "unreported" as const,
  enablement: { availability: "available" as const },
};
export const snapshot = {
  observedAtMs: 1,
  source: "officialCli" as const,
  scope: "officialCliConfigurationForDirectory" as const,
  complete: true as const,
  sessionApplicability: "unverified" as const,
  items: [item],
};
export const request: McpRemoveRequest = {
  agentId: "mcp-fixture",
  requestId: id,
  action: "inspect",
  cwd: "/controlled",
  target: {
    kind: "mcpRemoval",
    inventoryRequestId: id,
    itemId: 0,
    name: "local-tools",
    transport: "stdio",
  },
  requestedEnabled: null,
  operationId: null,
};
export function operation(
  r: ExtensionChangeRequest = request,
  ready = false,
): McpRemoveOperation {
  if (!isRemoveRequest(r))
    throw new Error("MCP fixture received another domain");
  return {
    ...r,
    state: ready ? "ready" : "running",
    phase: ready ? "complete" : "reading",
    settled: ready,
    writeDispatched: false,
    writeAck: "none",
    outcome: r.action === "inspect" ? null : ready ? "notDispatched" : null,
    code: null,
    observation: null,
    review:
      ready && r.action === "inspect"
        ? {
            reviewId,
            agentId: r.agentId,
            cwd: r.cwd,
            target: r.target,
            requestedEnabled: r.requestedEnabled,
            configuredEnabled: false,
            reportedEnabled: false,
            writeScope: {
              kind: "profile",
              configDisplayPath: "~/.example/work.config.toml",
            },
            observedAtMs: Date.now(),
            validForMs: 300000,
            mutation: "removeDisabledMcp",
            parentHandling: "mayRemainEmpty",
            preservation: "otherConfigurationSemanticsPreserved",
            sessionApplicability: "unverified",
          }
        : null,
  };
}
export function written(
  r: ExtensionChangeRequest,
  unknown = false,
): McpRemoveOperation {
  return {
    ...operation(r, true),
    writeDispatched: true,
    writeAck: unknown ? "unknown" : "ok",
    outcome:
      r.action === "recheck" ? "observed" : unknown ? "unknown" : "verified",
    observation: {
      observedAtMs: Date.now(),
      configuration: "matching",
      mcp: "absent",
      parentOutcome: "empty",
      configuredEnabled: r.requestedEnabled,
      reportedEnabled: r.requestedEnabled,
      sessionApplicability: "unverified",
    },
  };
}
export async function setup() {
  let live = true,
    n = 0;
  const owner: InventoryOwner = {
    agentId: "mcp-fixture",
    token: {},
    current: () => live,
  };
  const inventoryPort: InventoryPort = {
    read: vi.fn(async ({ selectionId: _, ...r }) => ({
      ...r,
      state: "ready",
      settled: true,
      snapshot,
    })),
    status: vi.fn(),
    cancel: vi.fn(),
  };
  const inventory = new ExtensionInventoryController(inventoryPort, 100);
  inventory.begin(owner, "/controlled", id, "mcp");
  await flush();
  const result = inventory.get(owner.agentId).results.mcp!;
  const pending = {
    inspect: deferred(),
    confirm: deferred(),
    status: deferred(),
    cancel: deferred(),
    recheck: deferred(),
  };
  const port: SkillManagementPort = {
    inspect: vi.fn(() => pending.inspect.promise),
    confirm: vi.fn(() => pending.confirm.promise),
    status: vi.fn(() => pending.status.promise),
    cancel: vi.fn(() => pending.cancel.promise),
    recheck: vi.fn(() => pending.recheck.promise),
  };
  const skills: SkillManagementPort = {
    inspect: vi.fn(),
    confirm: vi.fn(),
    status: vi.fn(),
    cancel: vi.fn(),
    recheck: vi.fn(),
  };
  const controller = new SkillManagementController(
    skills,
    100,
    () => `aaaaaaaa-aaaa-aaaa-aaaa-${String(++n).padStart(12, "0")}`,
    () => Date.now(),
    skills,
    skills,
    port,
  );
  const target = {
    kind: "mcpRemoval" as const,
    owner,
    result,
    item: result.snapshot.items[0] as typeof item,
    current: () => inventory.isCurrentResult(owner, result),
    changed: () => inventory.markStale(result),
  };
  const close = () => {
    live = false;
    inventory.retire(owner);
    controller.retire(owner);
  };
  return {
    owner,
    inventory,
    inventoryPort,
    result,
    target,
    pending,
    port,
    skills,
    controller,
    close,
  };
}
export async function reviewed(h: Awaited<ReturnType<typeof setup>>) {
  h.controller.inspect(h.target);
  await flush();
  h.pending.inspect.resolve(
    operation(h.controller.get(h.owner.agentId).request!, true),
  );
  await flush();
  return h.controller.get(h.owner.agentId).review!;
}
