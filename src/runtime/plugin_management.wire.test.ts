import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  parsePluginOperation,
  type PluginOperation,
  type PluginRequest,
} from "./plugin_management_types";
import { PluginManagementController } from "./plugin_management_controller";
import { flush } from "./extension_inventory.test-support";
import { pluginTicket } from "./plugin_management.test-support";

// Exact controlled Rust production query/parser/ownership serialization. This
// fixture is not a real Agent, native application or official plugin install.
const bytes = readFileSync("src/runtime/fixtures/plugin-management-wire.json");
const wire = JSON.parse(bytes.toString()) as Record<string, PluginOperation>;
function expected(name: string, value: PluginOperation): PluginRequest {
  return {
    agentId: value.agentId,
    requestId: value.requestId,
    cwd: value.cwd,
    action: value.action,
    ...(value.target
      ? { target: value.target, install: ["inspect", "install"].includes(name) }
      : {}),
    ...(name === "recheck" ? { operationId: wire.remove.requestId } : {}),
  };
}
it("preserves the exact actual production Rust DTO bytes", () => {
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "b68757f6cb98521045b65a5a5b7ad3ab9ad358addcd235ebe07a8db8ca0a0726",
  );
});
it("does not relabel an actual read-only recheck as a dispatched write", () => {
  expect(() =>
    parsePluginOperation(
      { ...wire.recheck, writeDispatched: true, writeAck: "ok" },
      expected("recheck", wire.recheck),
    ),
  ).toThrow();
});
for (const [name, value] of Object.entries(wire))
  it(
    "accepts actual Rust serialization without adapting fields: " + name,
    () => {
      expect(parsePluginOperation(value, expected(name, value))).toEqual(value);
    },
  );

it("actual Rust readback remains read-only while preserving the original confirmation facts", async () => {
  const order = [
    "inventory",
    "inspect",
    "install",
    "installedInventory",
    "removeInspect",
    "remove",
    "recheck",
  ];
  const ids = order.map((key) => wire[key].requestId);
  const owner = {
    agentId: wire.inventory.agentId,
    token: {},
    current: () => true,
  };
  const port = {
    inventory: vi
      .fn()
      .mockResolvedValueOnce(wire.inventory)
      .mockResolvedValueOnce(wire.installedInventory),
    inspect: vi
      .fn()
      .mockResolvedValueOnce(wire.inspect)
      .mockResolvedValueOnce(wire.removeInspect),
    confirm: vi
      .fn()
      .mockResolvedValueOnce(wire.install)
      .mockResolvedValueOnce(wire.remove),
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
  client.begin(owner, wire.inventory.cwd, pluginTicket);
  await flush();
  let result = client.get(owner.agentId).result!;
  client.inspect(owner, result, result.catalog.items[0], true);
  await flush();
  client.confirm(owner, client.get(owner.agentId).review!);
  await flush();
  expect(client.get(owner.agentId).operation?.outcome).toBe("verified");
  client.begin(owner, wire.installedInventory.cwd, pluginTicket);
  await flush();
  result = client.get(owner.agentId).result!;
  client.inspect(owner, result, result.catalog.items[0], false);
  await flush();
  client.confirm(owner, client.get(owner.agentId).review!);
  await flush();
  expect(client.get(owner.agentId).operation?.outcome).toBe("verified");
  expect(client.recheck(owner.agentId, wire.remove.requestId)).toBe(true);
  await flush();
  const view = client.get(owner.agentId);
  expect(view.unresolved).toBe(false);
  expect(view.operation?.outcome).toBe("observed");
  expect(view.operation?.writeDispatched).toBe(false);
  expect(view.operation?.writeAck).toBe("none");
  expect("originalOperation" in view && view.originalOperation).toEqual(
    wire.remove,
  );
  expect(port.confirm).toHaveBeenCalledTimes(2);
});
