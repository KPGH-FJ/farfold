import type {
  SkillChangeCode,
  SkillChangeInspectInput,
  SkillChangeConfirmInput,
  SkillChangeRequestKey,
  SkillChangeRecheckInput,
} from "./skill_management_types";
import { SKILL_CHANGE_CODES } from "./skill_management_types";
import { validInventoryId } from "./extension_inventory_types";
import {
  invalid,
  record,
  one,
  integer,
  text,
  bool,
  OPERATION_KEYS,
  operationIdentity,
  lifecycle,
  cancelledOperation,
} from "./extension_change_validation";
// MCP preference DTO: safe metadata only; no public write authority.
const SCOPE_REFUSALS = [
  "configurationProjectOnly",
  "configurationInherited",
  "configurationLayerConflict",
] as const;
export type McpTransport = "stdio" | "streamableHttp";
export type McpChangeAction = "inspect" | "setEnabled" | "recheck";
export type McpChangeTarget = {
  kind: "mcp";
  inventoryRequestId: string;
  itemId: number;
  name: string;
  transport: McpTransport;
};
export type McpChangeReview = {
  reviewId: string;
  agentId: string;
  cwd: string;
  target: McpChangeTarget;
  requestedEnabled: boolean;
  configuredEnabled: boolean;
  reportedEnabled: boolean;
  writeScope: { kind: "user" | "profile"; configDisplayPath: string };
  observedAtMs: number;
  validForMs: 300000;
  mutation: "setMcpEnabledPreference";
  preservation: "otherConfigurationSemanticsPreserved";
  sessionApplicability: "unverified";
};
export type McpChangeObservation = {
  observedAtMs: number;
  configuration: "matching" | "different";
  mcp: "matching" | "different" | "missing";
  configuredEnabled: boolean | null;
  reportedEnabled: boolean | null;
  sessionApplicability: "unverified";
};
export type McpChangeOperation = {
  agentId: string;
  requestId: string;
  action: McpChangeAction;
  cwd: string;
  target: McpChangeTarget;
  requestedEnabled: boolean;
  operationId: string | null;
  state:
    | "running"
    | "cancelling"
    | "pendingCleanup"
    | "ready"
    | "failed"
    | "cancelled";
  phase:
    | "queued"
    | "starting"
    | "reading"
    | "writing"
    | "checking"
    | "cleaning"
    | "complete";
  settled: boolean;
  writeDispatched: boolean;
  writeAck: "none" | "ok" | "okOverridden" | "rejected" | "unknown";
  outcome:
    | "notDispatched"
    | "rejected"
    | "verified"
    | "observed"
    | "mismatch"
    | "unknown"
    | null;
  code: SkillChangeCode | null;
  review: McpChangeReview | null;
  observation: McpChangeObservation | null;
};
export type McpEnablement =
  | { availability: "available"; reason?: null }
  | {
      availability: "unavailable";
      reason:
        | "unsafeLabel"
        | "unsupportedTransport"
        | "ambiguousTarget"
        | "incompleteInventory";
    };

export type McpChangeInspectInput = SkillChangeInspectInput;
export type McpChangeConfirmInput = SkillChangeConfirmInput;
export type McpChangeRequestKey = SkillChangeRequestKey;
export type McpChangeRecheckInput = SkillChangeRecheckInput;
export type McpChangeRequest = Pick<
  McpChangeOperation,
  | "agentId"
  | "requestId"
  | "action"
  | "cwd"
  | "target"
  | "requestedEnabled"
  | "operationId"
>;
export function parseMcpEnablement(raw: unknown): McpEnablement {
  if (
    raw &&
    typeof raw === "object" &&
    "availability" in raw &&
    raw.availability === "available"
  ) {
    const hasReason = Object.hasOwn(raw, "reason");
    const v = record(
      raw,
      hasReason ? ["availability", "reason"] : ["availability"],
    );
    if (hasReason && v.reason !== null) invalid();
    return {
      availability: "available",
      ...(hasReason ? { reason: null } : {}),
    };
  }
  const v = record(raw, ["availability", "reason"]);
  if (v.availability !== "unavailable") invalid();
  return {
    availability: "unavailable",
    reason: one(v.reason, [
      "unsafeLabel",
      "unsupportedTransport",
      "ambiguousTarget",
      "incompleteInventory",
    ]),
  };
}
function target(raw: unknown, expected: McpChangeRequest): McpChangeTarget {
  const v = record(raw, [
    "kind",
    "inventoryRequestId",
    "itemId",
    "name",
    "transport",
  ]);
  if (
    v.kind !== "mcp" ||
    !validInventoryId(v.inventoryRequestId) ||
    v.inventoryRequestId !== expected.target.inventoryRequestId ||
    integer(v.itemId, 511) !== expected.target.itemId ||
    v.name !== expected.target.name ||
    v.transport !== expected.target.transport
  )
    invalid();
  const name = text(v.name, 256);
  if (name.includes("..") || !/^[\p{Alphabetic}\p{Number} ._-]+$/u.test(name))
    invalid();
  return {
    kind: "mcp",
    inventoryRequestId: v.inventoryRequestId as string,
    itemId: v.itemId as number,
    name,
    transport: one(v.transport, ["stdio", "streamableHttp"]),
  };
}
function review(raw: unknown, expected: McpChangeRequest): McpChangeReview {
  const v = record(raw, [
    "reviewId",
    "agentId",
    "cwd",
    "target",
    "requestedEnabled",
    "configuredEnabled",
    "reportedEnabled",
    "writeScope",
    "observedAtMs",
    "validForMs",
    "mutation",
    "preservation",
    "sessionApplicability",
  ]);
  if (
    !validInventoryId(v.reviewId) ||
    v.agentId !== expected.agentId ||
    v.cwd !== expected.cwd ||
    v.requestedEnabled !== expected.requestedEnabled ||
    v.validForMs !== 300000 ||
    v.mutation !== "setMcpEnabledPreference" ||
    v.preservation !== "otherConfigurationSemanticsPreserved" ||
    v.sessionApplicability !== "unverified"
  )
    invalid();
  const scope = record(v.writeScope, ["kind", "configDisplayPath"]);
  return {
    reviewId: v.reviewId as string,
    agentId: expected.agentId,
    cwd: expected.cwd,
    target: target(v.target, expected),
    requestedEnabled: expected.requestedEnabled,
    configuredEnabled: bool(v.configuredEnabled),
    reportedEnabled: bool(v.reportedEnabled),
    writeScope: {
      kind: one(scope.kind, ["user", "profile"]),
      configDisplayPath: text(scope.configDisplayPath),
    },
    observedAtMs: integer(v.observedAtMs),
    validForMs: 300000,
    mutation: "setMcpEnabledPreference",
    preservation: "otherConfigurationSemanticsPreserved",
    sessionApplicability: "unverified",
  };
}
function observation(
  raw: unknown,
  expected: McpChangeRequest,
): McpChangeObservation {
  const v = record(raw, [
    "observedAtMs",
    "configuration",
    "mcp",
    "configuredEnabled",
    "reportedEnabled",
    "sessionApplicability",
  ]);
  if (v.sessionApplicability !== "unverified") invalid();
  const configuration = one(v.configuration, ["matching", "different"]),
    mcp = one(v.mcp, ["matching", "different", "missing"]);
  const configuredEnabled =
      v.configuredEnabled === null ? null : bool(v.configuredEnabled),
    reportedEnabled =
      v.reportedEnabled === null ? null : bool(v.reportedEnabled);
  if (
    (configuration === "matching" &&
      configuredEnabled !== expected.requestedEnabled) ||
    (mcp === "missing" ? reportedEnabled !== null : reportedEnabled === null) ||
    (mcp === "matching" && reportedEnabled !== expected.requestedEnabled) ||
    (mcp === "different" && reportedEnabled === expected.requestedEnabled)
  )
    invalid();
  return {
    observedAtMs: integer(v.observedAtMs),
    configuration,
    mcp,
    configuredEnabled,
    reportedEnabled,
    sessionApplicability: "unverified",
  };
}
export function parseMcpChangeOperation(
  raw: unknown,
  expected: McpChangeRequest,
): McpChangeOperation {
  if (typeof expected.requestedEnabled !== "boolean") invalid();
  const v = record(raw, OPERATION_KEYS);
  operationIdentity(v, expected);
  const parsedTarget = target(v.target, expected),
    rev = v.review === null ? null : review(v.review, expected),
    obs = v.observation === null ? null : observation(v.observation, expected);
  const status = lifecycle(
    v,
    expected,
    {
      hasReview: !!rev,
      hasObservation: !!obs,
      matching: obs?.configuration === "matching" && obs.mcp === "matching",
      different:
        obs?.configuration === "different" ||
        obs?.mcp === "different" ||
        obs?.mcp === "missing",
    },
    [...SKILL_CHANGE_CODES, ...SCOPE_REFUSALS],
  );
  if (
    SCOPE_REFUSALS.some((code) => code === status.code) &&
    (expected.action !== "inspect" || status.state !== "failed")
  )
    invalid();
  return {
    ...expected,
    target: parsedTarget,
    ...status,
    review: rev,
    observation: obs,
  };
}
export function parseMcpChangeCancellation(
  raw: unknown,
  expected: McpChangeRequest,
): McpChangeOperation | null {
  const op = cancelledOperation(raw, expected);
  return op === null ? null : parseMcpChangeOperation(op, expected);
}
