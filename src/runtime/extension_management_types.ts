// One finite preference lifecycle for both domains; each wire parser stays exact.
import type {
  InventoryOwner,
  InventoryResult,
} from "./extension_inventory_controller";
import type {
  InventoryItem,
  SkillInventoryItem,
} from "./extension_inventory_types";
import {
  parseSkillChangeOperation,
  parseSkillChangeCancellation,
  type SkillChangeRequest,
  type SkillChangeOperation,
  type SkillChangeReview,
} from "./skill_management_types";
import {
  parseMcpChangeOperation,
  parseMcpChangeCancellation,
  type McpChangeRequest,
  type McpChangeOperation,
  type McpChangeReview,
} from "./mcp_management_types";
export type ExtensionChangeRequest = SkillChangeRequest | McpChangeRequest;
export type ExtensionChangeOperation =
  SkillChangeOperation | McpChangeOperation;
export type ExtensionChangeReview = SkillChangeReview | McpChangeReview;
export interface ExtensionChangeTargetOwner {
  owner: InventoryOwner;
  result: InventoryResult;
  item: InventoryItem | SkillInventoryItem;
  requestedEnabled?: boolean;
  current(): boolean;
  changed(): void;
}
export function isMcpRequest(r: ExtensionChangeRequest): r is McpChangeRequest {
  return "kind" in r.target && r.target.kind === "mcp";
}
export function parseExtensionChangeOperation(
  raw: unknown,
  r: ExtensionChangeRequest,
): ExtensionChangeOperation {
  return isMcpRequest(r)
    ? parseMcpChangeOperation(raw, r)
    : parseSkillChangeOperation(raw, r);
}
export function parseExtensionChangeCancellation(
  raw: unknown,
  r: ExtensionChangeRequest,
): ExtensionChangeOperation | null {
  return isMcpRequest(r)
    ? parseMcpChangeCancellation(raw, r)
    : parseSkillChangeCancellation(raw, r);
}
export function requestForTarget(
  t: ExtensionChangeTargetOwner,
  requestId: string,
): ExtensionChangeRequest | null {
  const { result, item, owner } = t;
  if (
    !owner.current() ||
    !t.current() ||
    result.owner !== owner ||
    result.request.agentId !== owner.agentId ||
    result.stale ||
    !result.snapshot.complete ||
    result.snapshot.items[item.id] !== item ||
    !item.name
  )
    return null;
  const base = {
    agentId: owner.agentId,
    requestId,
    action: "inspect" as const,
    cwd: result.request.cwd,
    requestedEnabled: !item.reportedEnabled,
    operationId: null,
  };
  if (
    result.request.kind === "mcp" &&
    result.snapshot.source === "officialCli" &&
    "transport" in item
  ) {
    if (
      item.enablement?.availability !== "available" ||
      item.transport === "unknown" ||
      typeof t.requestedEnabled !== "boolean"
    )
      return null;
    return Object.freeze({
      ...base,
      requestedEnabled: t.requestedEnabled,
      target: Object.freeze({
        kind: "mcp",
        inventoryRequestId: result.request.requestId,
        itemId: item.id,
        name: item.name,
        transport: item.transport,
      }),
    });
  }
  if (
    result.request.kind !== "skills" ||
    result.snapshot.source !== "officialAppServer" ||
    !("pluginReported" in item) ||
    !["user", "repo"].includes(item.origin) ||
    item.pluginReported ||
    item.enablement.availability !== "reviewable"
  )
    return null;
  return Object.freeze({
    ...base,
    target: Object.freeze({
      inventoryRequestId: result.request.requestId,
      itemId: item.id,
      name: item.name,
      origin: item.origin as "user" | "repo",
    }),
  });
}
export function confirmedRequest(
  old: ExtensionChangeRequest,
  review: ExtensionChangeReview,
  requestId: string,
): ExtensionChangeRequest {
  // Both the exact review object and its target were validated before this point.
  if (isMcpRequest(old)) {
    if (!("configuredEnabled" in review)) throw { code: "invalidOutput" };
    return {
      ...old,
      requestId,
      action: "setEnabled",
      target: Object.freeze({ ...review.target }),
    };
  }
  if ("configuredEnabled" in review) throw { code: "invalidOutput" };
  return {
    ...old,
    requestId,
    action: "setEnabled",
    target: Object.freeze({ ...review.target }),
  };
}
