import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { flush } from "./extension_inventory.test-support";
import { PluginManagementController } from "./plugin_management_controller";
import { pluginTicket } from "./plugin_management.test-support";
import {
  parsePluginOperation,
  type PluginOperation,
  type PluginRequest,
} from "./plugin_management_types";

// Exact new Rust production Sources/scoped-query serialization from an owned
// peer. This is neither an official install nor a real Agent/app observation.
const bytes = readFileSync(
  "src/runtime/fixtures/plugin-management-scoped-wire.json",
);
const wire = JSON.parse(bytes.toString()) as Record<string, PluginOperation>;
function expected(value: PluginOperation): PluginRequest {
  return {
    agentId: value.agentId,
    requestId: value.requestId,
    cwd: value.cwd,
    action: value.action,
    ...(value.target ? { target: value.target, install: true } : {}),
    ...(value.action === "recheck"
      ? { operationId: wire.install.requestId }
      : {}),
  };
}
it("preserves the separate actual scoped Rust wire without altering the earlier fixture", () => {
  expect(bytes.length).toBe(5988);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "5dd5d40d334ec068f6052899a6e2c2ae2502e6556b78ddd74ad5474aa36dea15",
  );
  for (const value of Object.values(wire))
    expect(parsePluginOperation(value, expected(value))).toEqual(value);
});
it("uses the actual source receipt only after explicit selection, preserving the confirmed write on readback", async () => {
  const ids = Object.values(wire).map((value) => value.requestId);
  const owner = {
    agentId: wire.sources.agentId,
    token: {},
    current: () => true,
  };
  const port = {
    sources: vi.fn().mockResolvedValue(wire.sources),
    inventory: vi.fn().mockResolvedValue(wire.inventory),
    inspect: vi.fn().mockResolvedValue(wire.inspect),
    confirm: vi.fn().mockResolvedValue(wire.install),
    recheck: vi.fn().mockResolvedValue(wire.recheck),
    status: vi.fn(),
    cancel: vi.fn(async (key) => ({
      ...key,
      cancelRequested: true,
      operation: null,
    })),
  };
  const client = new PluginManagementController(
    port,
    1000,
    () => ids.shift()!,
    () => wire.inspect.review!.observedAtMs,
  );
  expect(port.sources).not.toHaveBeenCalled();
  client.begin(owner, wire.sources.cwd, pluginTicket);
  await flush();
  const sources = client.get(owner.agentId).sourceResult!;
  expect(sources.catalog).toEqual(wire.sources.sources);
  expect(client.get(owner.agentId).result).toBeNull();
  expect(port.inventory).not.toHaveBeenCalled();
  expect(client.inventory(owner, sources, sources.catalog.items[0])).toBe(true);
  await flush();
  expect(port.inventory).toHaveBeenCalledWith({
    agentId: owner.agentId,
    requestId: wire.inventory.requestId,
    sourceRequestId: wire.sources.requestId,
    sourceId: 0,
  });
  const result = client.get(owner.agentId).result!;
  expect(client.inspect(owner, result, result.catalog.items[0], true)).toBe(
    true,
  );
  await flush();
  expect(port.confirm).not.toHaveBeenCalled();
  client.confirm(owner, client.get(owner.agentId).review!);
  await flush();
  expect(client.get(owner.agentId).originalOperation).toEqual(wire.install);
  client.recheck(owner.agentId, wire.install.requestId);
  await flush();
  expect(client.get(owner.agentId).operation).toEqual(wire.recheck);
  expect(client.get(owner.agentId).originalOperation).toEqual(wire.install);
  expect(port.confirm).toHaveBeenCalledOnce();
});
