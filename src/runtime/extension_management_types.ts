import {
  parseMcpRemoveOperation,
  parseMcpRemoveCancellation,
  type McpRemoveRequest,
  type McpRemoveOperation,
  type McpRemoveReview,
} from "./mcp_remove_types";
import {
  parseMcpAddOperation,
  parseMcpAddCancellation,
  freezeMcpAddInput,
  type McpAddInput,
  type McpAddRequest,
  type McpAddOperation,
  type McpAddReview,
} from "./mcp_add_types";
import { validInventoryId } from "./extension_inventory_types";
// One finite extension configuration lifecycle; each domain wire parser stays exact.
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
export type ExtensionChangeRequest =
  SkillChangeRequest | McpChangeRequest | McpAddRequest | McpRemoveRequest;
export type ExtensionChangeOperation =
  | SkillChangeOperation
  | McpChangeOperation
  | McpAddOperation
  | McpRemoveOperation;
export type ExtensionChangeReview =
  SkillChangeReview | McpChangeReview | McpAddReview | McpRemoveReview;
interface TargetOwnerBase {
  owner: InventoryOwner;
  result: InventoryResult;
  current(): boolean;
  changed(): void;
}
export type ExtensionChangeTargetOwner = TargetOwnerBase &
  (
    | { item: InventoryItem | SkillInventoryItem; requestedEnabled?: boolean }
    | { kind: "mcpRemoval"; item: InventoryItem }
    | { kind: "mcpAddition"; inputId: string; input: McpAddInput }
  );
export function isRemoveRequest(
  r: ExtensionChangeRequest,
): r is McpRemoveRequest {
  return "kind" in r.target && r.target.kind === "mcpRemoval";
}
export function isAddRequest(r: ExtensionChangeRequest): r is McpAddRequest {
  return "kind" in r.target && r.target.kind === "mcpAddition";
}
export function isMcpRequest(r: ExtensionChangeRequest): r is McpChangeRequest {
  return "kind" in r.target && r.target.kind === "mcp";
}
export function parseExtensionChangeOperation(
  raw: unknown,
  r: ExtensionChangeRequest,
): ExtensionChangeOperation {
  return isRemoveRequest(r)
    ? parseMcpRemoveOperation(raw, r)
    : isAddRequest(r)
      ? parseMcpAddOperation(raw, r)
      : isMcpRequest(r)
        ? parseMcpChangeOperation(raw, r)
        : parseSkillChangeOperation(raw, r);
}
export function parseExtensionChangeCancellation(
  raw: unknown,
  r: ExtensionChangeRequest,
): ExtensionChangeOperation | null {
  return isRemoveRequest(r)
    ? parseMcpRemoveCancellation(raw, r)
    : isAddRequest(r)
      ? parseMcpAddCancellation(raw, r)
      : isMcpRequest(r)
        ? parseMcpChangeCancellation(raw, r)
        : parseSkillChangeCancellation(raw, r);
}
export function requestForTarget(
  t: ExtensionChangeTargetOwner,
  requestId: string,
): ExtensionChangeRequest | null {
  const { result, owner } = t;
  if (
    !owner.current() ||
    !t.current() ||
    result.owner !== owner ||
    result.request.agentId !== owner.agentId ||
    result.stale ||
    !result.snapshot.complete
  )
    return null;
  if ("kind" in t && t.kind === "mcpRemoval") {
    const item = t.item;
    if (
      result.request.kind !== "mcp" ||
      result.snapshot.source !== "officialCli" ||
      result.snapshot.items[item.id] !== item ||
      !item.name ||
      item.reportedEnabled !== false ||
      item.enablement?.availability !== "available" ||
      item.transport === "unknown"
    )
      return null;
    return Object.freeze({
      agentId: owner.agentId,
      requestId,
      action: "inspect",
      cwd: result.request.cwd,
      requestedEnabled: null,
      operationId: null,
      target: Object.freeze({
        kind: "mcpRemoval",
        inventoryRequestId: result.request.requestId,
        itemId: item.id,
        name: item.name,
        transport: item.transport,
      }),
    });
  }
  if ("kind" in t) {
    if (
      t.kind !== "mcpAddition" ||
      result.request.kind !== "mcp" ||
      result.snapshot.source !== "officialCli" ||
      !validInventoryId(t.inputId)
    )
      return null;
    try {
      freezeMcpAddInput(t.input);
    } catch {
      return null;
    }
    return Object.freeze({
      agentId: owner.agentId,
      requestId,
      action: "inspect",
      cwd: result.request.cwd,
      requestedEnabled: false,
      operationId: null,
      target: Object.freeze({
        kind: "mcpAddition",
        inventoryRequestId: result.request.requestId,
        inputId: t.inputId,
        name: t.input.name,
        transport: "stdio",
      }),
    });
  }
  const { item } = t;
  if (result.snapshot.items[item.id] !== item || !item.name) return null;
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
  if (isRemoveRequest(old)) {
    if (review.mutation !== "removeDisabledMcp")
      throw { code: "invalidOutput" };
    return {
      ...old,
      requestId,
      action: "remove",
      target: Object.freeze({ ...review.target }),
    };
  }
  if (isAddRequest(old)) {
    if (review.mutation !== "addDisabledStdioMcp")
      throw { code: "invalidOutput" };
    return {
      ...old,
      requestId,
      action: "add",
      target: Object.freeze({ ...review.target }),
    };
  }
  if (isMcpRequest(old)) {
    if (review.mutation !== "setMcpEnabledPreference")
      throw { code: "invalidOutput" };
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
