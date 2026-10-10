import { vi } from "vitest";
import { setup as mcpSetup, id, reviewId } from "./mcp_management.test-support";
import { deferred, flush } from "./extension_inventory.test-support";
import { SkillManagementController } from "./skill_management_controller";
import {
  isAddRequest,
  type ExtensionChangeRequest,
} from "./extension_management_types";
import type { SkillManagementPort } from "./skill_management";
import type {
  McpAddInput,
  McpAddOperation,
  McpAddRequest,
} from "./mcp_add_types";
export const input: McpAddInput = {
  name: "new-local",
  executablePath: "/Applications/Local Tools/runner",
  args: ["", "a b", "x\\y", "--flag"],
};
export const request: McpAddRequest = {
  agentId: "add-test",
  requestId: id,
  action: "inspect",
  cwd: "/controlled",
  target: {
    kind: "mcpAddition",
    inventoryRequestId: id,
    inputId: id,
    name: input.name,
    transport: "stdio",
  },
  requestedEnabled: false,
  operationId: null,
};
export function operation(
  r: ExtensionChangeRequest = request,
  ready = false,
): McpAddOperation {
  if (!isAddRequest(r))
    throw new Error("Addition fixture received another domain");
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
            requestedEnabled: false,
            configuredEnabled: null,
            reportedEnabled: null,
            writeScope: {
              kind: "user",
              configDisplayPath: "~/.example/config.toml",
            },
            observedAtMs: Date.now(),
            validForMs: 300000,
            mutation: "addDisabledStdioMcp",
            nameAvailability: "absentInCheckedScopes",
            preservation: "otherConfigurationSemanticsPreserved",
            sessionApplicability: "unverified",
          }
        : null,
  };
}
export function written(
  r: ExtensionChangeRequest,
  unknown = false,
): McpAddOperation {
  return {
    ...operation(r, true),
    writeDispatched: true,
    writeAck: unknown ? "unknown" : "ok",
    outcome:
      r.action === "recheck" ? "observed" : unknown ? "unknown" : "verified",
    observation: {
      observedAtMs: Date.now(),
      configuration: "matching",
      mcp: "matching",
      configuredEnabled: false,
      reportedEnabled: false,
      sessionApplicability: "unverified",
    },
  };
}
export async function setup(empty = false) {
  const h = await mcpSetup();
  let serial = 0;
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
  const controller = new SkillManagementController(
    h.skills,
    100,
    () => `bbbbbbbb-bbbb-bbbb-bbbb-${String(++serial).padStart(12, "0")}`,
    () => Date.now(),
    h.port,
    port,
  );
  const result = empty
    ? { ...h.result, snapshot: { ...h.result.snapshot, items: [] } }
    : h.result;
  let live = true;
  const target = {
    kind: "mcpAddition" as const,
    owner: h.owner,
    result,
    inputId: id,
    input,
    current: () => live && h.owner.current(),
    changed: () => h.inventory.markStale(h.result),
  };
  const retire = () => {
    live = false;
    controller.retire(h.owner);
  };
  return {
    ...h,
    controller,
    port,
    enablePort: h.port,
    pending,
    result,
    target,
    retire,
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
