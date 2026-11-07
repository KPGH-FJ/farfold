import { vi } from "vitest";
import { setup as skillSetup, iid, rid } from "./skill_management.test-support";
import { deferred, flush } from "./extension_inventory.test-support";
import { SkillManagementController } from "./skill_management_controller";
import type { SkillManagementPort } from "./skill_management";
import {
  isSkillPreferenceRemoveRequest,
  type ExtensionChangeRequest,
} from "./extension_management_types";
import type {
  SkillPreferenceRemoveOperation,
  SkillPreferenceRemoveRequest,
} from "./skill_preference_remove_types";

export { iid, rid };
export const displayPath = "~/project/.agents/skills/search";
export const request: SkillPreferenceRemoveRequest = {
  agentId: "fixture",
  requestId: iid,
  action: "inspect",
  cwd: "/controlled",
  target: {
    kind: "skillPreferenceRemoval",
    inventoryRequestId: iid,
    itemId: 0,
    name: "sample:search",
    origin: "repo",
  },
  requestedEnabled: null,
  operationId: null,
};
export function operation(
  r: ExtensionChangeRequest = request,
  ready = false,
): SkillPreferenceRemoveOperation {
  if (!isSkillPreferenceRemoveRequest(r))
    throw new Error("Wrong fixture domain");
  const target = {
    ...r.target,
    displayPath: r.target.displayPath ?? displayPath,
  };
  return {
    ...r,
    target,
    state: ready ? "ready" : "running",
    phase: ready ? "complete" : "reading",
    settled: ready,
    writeDispatched: false,
    writeAck: "none",
    outcome: null,
    code: null,
    observation: null,
    review:
      ready && r.action === "inspect"
        ? {
            reviewId: rid,
            agentId: r.agentId,
            cwd: r.cwd,
            target,
            requestedEnabled: null,
            configuredEnabled: false,
            reportedEnabled: false,
            rulesBefore: 2,
            rulesAfter: 1,
            writeScope: {
              kind: "profile",
              configDisplayPath: "~/.example/config.toml",
            },
            observedAtMs: Date.now(),
            validForMs: 300000,
            mutation: "removeSkillPathPreference",
            parentHandling: "preserveSiblings",
            preservation: "otherConfigurationSemanticsPreserved",
            sessionApplicability: "unverified",
          }
        : null,
  };
}
export function written(
  r: ExtensionChangeRequest,
  unknown = false,
): SkillPreferenceRemoveOperation {
  return {
    ...operation(r, true),
    state: unknown ? "failed" : "ready",
    writeDispatched: true,
    writeAck: unknown ? "unknown" : "ok",
    outcome: unknown
      ? "unknown"
      : r.action === "recheck"
        ? "observed"
        : "verified",
    code: unknown ? "writeUncertain" : null,
    observation: unknown
      ? null
      : {
          observedAtMs: Date.now(),
          configuration: "matching",
          skill: "reported",
          configuredEnabled: null,
          reportedEnabled: false,
          parentOutcome: "nonempty",
          sessionApplicability: "unverified",
        },
  };
}
export async function setup(useRealPort = false) {
  const base = await skillSetup();
  let n = 0;
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
  const legacy: SkillManagementPort = {
    inspect: vi.fn(),
    confirm: vi.fn(),
    status: vi.fn(),
    cancel: vi.fn(),
    recheck: vi.fn(),
  };
  const controller = new SkillManagementController(
    legacy,
    100,
    () => `aaaaaaaa-aaaa-aaaa-aaaa-${String(++n).padStart(12, "0")}`,
    () => Date.now(),
    legacy,
    legacy,
    legacy,
    useRealPort ? undefined : port,
  );
  const target = { ...base.target, kind: "skillPreferenceRemoval" as const };
  const close = () => {
    base.close();
    controller.retire(base.owner);
  };
  return { ...base, controller, target, pending, port, legacy, close };
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
