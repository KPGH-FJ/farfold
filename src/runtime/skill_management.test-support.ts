import { vi } from "vitest";
import {
  ExtensionInventoryController,
  type InventoryOwner,
} from "./extension_inventory_controller";
import { SkillManagementController } from "./skill_management_controller";
import { deferred, flush } from "./extension_inventory.test-support";
import type { InventoryPort } from "./extension_inventory";
import type { SkillManagementPort } from "./skill_management";
import type {
  SkillChangeRequest,
  SkillChangeOperation,
} from "./skill_management_types";
export const iid = "11111111-1111-1111-1111-111111111111";
export const rid = "22222222-2222-2222-2222-222222222222";
export const item = {
  id: 0,
  name: "sample:search",
  description: "Plain <a>text</a>",
  descriptionTruncated: false,
  descriptionRedacted: false,
  reportedEnabled: false,
  origin: "repo" as const,
  pluginReported: false,
  enablement: { availability: "reviewable" as const, reason: null },
};
export function operation(
  r: SkillChangeRequest,
  state: SkillChangeOperation["state"] = "running",
): SkillChangeOperation {
  const ready = state === "ready";
  return {
    ...r,
    target: {
      ...r.target,
      displayPath: r.target.displayPath ?? "~/project/.agents/skills/search",
    },
    state,
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
            reviewId: rid,
            agentId: r.agentId,
            cwd: r.cwd,
            target: {
              ...r.target,
              displayPath: "~/project/.agents/skills/search",
            },
            requestedEnabled: r.requestedEnabled,
            reportedEnabled: false,
            writeScope: {
              kind: "profile",
              configDisplayPath: "~/.example/config.toml",
            },
            observedAtMs: Date.now(),
            validForMs: 300000,
            rulesBefore: 2,
            rulesAfter: 3,
            mutation: "appendPathRule",
            preservation: "officialJsonValues",
            sessionApplicability: "unverified",
          }
        : null,
  };
}
export function written(
  r: SkillChangeRequest,
  ack: "ok" | "okOverridden" | "unknown" = "ok",
): SkillChangeOperation {
  return {
    ...operation(r, "ready"),
    writeDispatched: true,
    writeAck: ack,
    outcome:
      r.action === "recheck"
        ? "observed"
        : ack === "unknown"
          ? "unknown"
          : "verified",
    observation: {
      observedAtMs: Date.now(),
      configuration: "matchesIntended",
      skill: "matchesRequested",
      reportedEnabled: r.requestedEnabled,
      sessionApplicability: "unverified",
    },
  };
}
export async function setup() {
  let live = true,
    n = 0;
  const owner: InventoryOwner = {
    agentId: "fixture",
    token: {},
    current: () => live,
  };
  const ip: InventoryPort = {
    read: vi.fn(async ({ selectionId: _, ...r }) => ({
      ...r,
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
    })),
    status: vi.fn(),
    cancel: vi.fn(async (r) => ({
      agentId: r.agentId,
      requestId: r.requestId,
      cancelRequested: true,
      operation: null,
    })),
  };
  const inventory = new ExtensionInventoryController(ip, 100, () => iid);
  inventory.begin(owner, "/controlled", iid, "skills");
  await flush();
  const result = inventory.get("fixture").results.skills!;
  const inspect = deferred(),
    confirm = deferred(),
    status = deferred(),
    cancel = deferred(),
    recheck = deferred();
  const port = {
    inspect: vi.fn<SkillManagementPort["inspect"]>(() => inspect.promise),
    confirm: vi.fn<SkillManagementPort["confirm"]>(() => confirm.promise),
    status: vi.fn<SkillManagementPort["status"]>(() => status.promise),
    cancel: vi.fn<SkillManagementPort["cancel"]>(() => cancel.promise),
    recheck: vi.fn<SkillManagementPort["recheck"]>(() => recheck.promise),
  };
  const client = new SkillManagementController(
    port,
    100,
    () => `aaaaaaaa-aaaa-aaaa-aaaa-${String(++n).padStart(12, "0")}`,
  );
  const target = {
    owner,
    result,
    item: result.snapshot.items[0] as typeof item,
    current: () => inventory.isCurrentResult(owner, result),
    changed: () => inventory.markStale(result),
  };
  const close = () => {
    live = false;
    inventory.retire(owner);
    client.retire(owner);
  };
  return {
    owner,
    inventory,
    result,
    target,
    client,
    port,
    inspect,
    confirm,
    status,
    cancel,
    recheck,
    close,
  };
}
export async function reviewed(h: Awaited<ReturnType<typeof setup>>) {
  h.client.inspect(h.target);
  await flush();
  h.inspect.resolve(operation(h.client.get("fixture").request!, "ready"));
  await flush();
  return h.client.get("fixture").review!;
}
