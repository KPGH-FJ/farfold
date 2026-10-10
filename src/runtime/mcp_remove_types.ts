import type {
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
export type McpTransport = "stdio" | "streamableHttp";
export type McpRemoveAction = "inspect" | "remove" | "recheck";
export type McpRemoveTarget = {
  kind: "mcpRemoval";
  inventoryRequestId: string;
  itemId: number;
  name: string;
  transport: McpTransport;
};
export type McpRemoveReview = {
  reviewId: string;
  agentId: string;
  cwd: string;
  target: McpRemoveTarget;
  requestedEnabled: null;
  configuredEnabled: false;
  reportedEnabled: false;
  writeScope: { kind: "user" | "profile"; configDisplayPath: string };
  observedAtMs: number;
  validForMs: 300000;
  mutation: "removeDisabledMcp";
  parentHandling: "mayRemainEmpty" | "preserveSiblings";
  preservation: "otherConfigurationSemanticsPreserved";
  sessionApplicability: "unverified";
};
export type McpRemoveObservation = {
  observedAtMs: number;
  configuration: "matching" | "different";
  mcp: "absent" | "present";
  parentOutcome: "absent" | "empty" | "nonempty" | null;
  configuredEnabled: boolean | null;
  reportedEnabled: boolean | null;
  sessionApplicability: "unverified";
};
export type McpRemoveOperation = {
  agentId: string;
  requestId: string;
  action: McpRemoveAction;
  cwd: string;
  target: McpRemoveTarget;
  requestedEnabled: null;
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
  code: McpRemoveCode | null;
  review: McpRemoveReview | null;
  observation: McpRemoveObservation | null;
};
export const MCP_REMOVE_CODES = [
  ...SKILL_CHANGE_CODES,
  "targetEnabled",
] as const;
export type McpRemoveCode = (typeof MCP_REMOVE_CODES)[number];
export function mcpRemoveFailure(value: unknown): McpRemoveCode | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1
  )
    return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" &&
    MCP_REMOVE_CODES.includes(code as McpRemoveCode)
    ? (code as McpRemoveCode)
    : null;
}
export type McpRemoveInspectInput = Omit<SkillChangeInspectInput, "enabled">;
export type McpRemoveConfirmInput = SkillChangeConfirmInput;
export type McpRemoveRequestKey = SkillChangeRequestKey;
export type McpRemoveRecheckInput = SkillChangeRecheckInput;
export type McpRemoveRequest = Pick<
  McpRemoveOperation,
  | "agentId"
  | "requestId"
  | "action"
  | "cwd"
  | "target"
  | "requestedEnabled"
  | "operationId"
>;
function target(raw: unknown, expected: McpRemoveRequest): McpRemoveTarget {
  const v = record(raw, [
    "kind",
    "inventoryRequestId",
    "itemId",
    "name",
    "transport",
  ]);
  if (
    v.kind !== "mcpRemoval" ||
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
    kind: "mcpRemoval",
    inventoryRequestId: v.inventoryRequestId as string,
    itemId: v.itemId as number,
    name,
    transport: one(v.transport, ["stdio", "streamableHttp"]),
  };
}
function review(raw: unknown, expected: McpRemoveRequest): McpRemoveReview {
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
    "parentHandling",
    "preservation",
    "sessionApplicability",
  ]);
  if (
    !validInventoryId(v.reviewId) ||
    v.agentId !== expected.agentId ||
    v.cwd !== expected.cwd ||
    v.requestedEnabled !== null ||
    v.configuredEnabled !== false ||
    v.reportedEnabled !== false ||
    v.validForMs !== 300000 ||
    v.mutation !== "removeDisabledMcp" ||
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
    configuredEnabled: false,
    reportedEnabled: false,
    writeScope: {
      kind: one(scope.kind, ["user", "profile"]),
      configDisplayPath: text(scope.configDisplayPath),
    },
    observedAtMs: integer(v.observedAtMs),
    validForMs: 300000,
    mutation: "removeDisabledMcp",
    parentHandling: one(v.parentHandling, [
      "mayRemainEmpty",
      "preserveSiblings",
    ]),
    preservation: "otherConfigurationSemanticsPreserved",
    sessionApplicability: "unverified",
  };
}
function observation(raw: unknown): McpRemoveObservation {
  const v = record(raw, [
    "observedAtMs",
    "configuration",
    "mcp",
    "parentOutcome",
    "configuredEnabled",
    "reportedEnabled",
    "sessionApplicability",
  ]);
  if (v.sessionApplicability !== "unverified") invalid();
  const configuration = one(v.configuration, ["matching", "different"]),
    mcp = one(v.mcp, ["absent", "present"]);
  const parentOutcome =
    v.parentOutcome === null
      ? null
      : one(v.parentOutcome, ["absent", "empty", "nonempty"]);
  const configuredEnabled =
      v.configuredEnabled === null ? null : bool(v.configuredEnabled),
    reportedEnabled =
      v.reportedEnabled === null ? null : bool(v.reportedEnabled);
  if (
    (configuration === "matching" &&
      (configuredEnabled !== null || parentOutcome === null)) ||
    (mcp === "absent" ? reportedEnabled !== null : reportedEnabled === null) ||
    ((parentOutcome === "empty" || parentOutcome === "absent") &&
      configuredEnabled !== null)
  )
    invalid();
  return {
    observedAtMs: integer(v.observedAtMs),
    configuration,
    mcp,
    parentOutcome,
    configuredEnabled,
    reportedEnabled,
    sessionApplicability: "unverified",
  };
}
export function parseMcpRemoveOperation(
  raw: unknown,
  expected: McpRemoveRequest,
): McpRemoveOperation {
  const v = record(raw, OPERATION_KEYS);
  one(expected.action, ["inspect", "remove", "recheck"]);
  if (expected.requestedEnabled !== null) invalid();
  operationIdentity(v, expected);
  const parsedTarget = target(v.target, expected),
    rev = v.review === null ? null : review(v.review, expected),
    obs = v.observation === null ? null : observation(v.observation);
  const state = lifecycle(
    v,
    expected,
    {
      hasReview: !!rev,
      hasObservation: !!obs,
      inspectionFailureOutcome: "notDispatched",
      matching: obs?.configuration === "matching" && obs.mcp === "absent",
      different: obs?.configuration === "different" || obs?.mcp === "present",
    },
    MCP_REMOVE_CODES,
  );
  // Removal has explicit null intent and a stricter terminal publication matrix.
  // Keep these rules local; legacy bool-domain acceptance does not expand.
  if (
    (!state.settled && (rev !== null || obs !== null)) ||
    (state.state === "ready" && state.code !== null) ||
    (state.state === "cancelled" && state.code !== "cancelled")
  )
    invalid();
  if (expected.action !== "inspect") {
    if (state.state === "ready") {
      if (
        !obs ||
        (expected.action === "remove"
          ? !state.writeDispatched ||
            !["ok", "okOverridden"].includes(state.writeAck) ||
            !["verified", "mismatch"].includes(state.outcome ?? "")
          : !["observed", "mismatch"].includes(state.outcome ?? ""))
      )
        invalid();
    } else if (obs !== null) invalid();
    if (state.settled && state.state !== "ready") {
      const rejected =
        expected.action === "remove" &&
        state.writeDispatched &&
        state.writeAck === "rejected";
      const required = rejected
        ? "rejected"
        : state.writeDispatched
          ? "unknown"
          : "notDispatched";
      if (
        state.outcome !== required ||
        (rejected &&
          ![
            "configurationReadOnly",
            "configurationChanged",
            "configurationRejected",
          ].includes(state.code ?? ""))
      )
        invalid();
    }
  }
  return {
    ...expected,
    target: parsedTarget,
    ...state,
    review: rev,
    observation: obs,
  };
}

export function parseMcpRemoveCancellation(
  raw: unknown,
  expected: McpRemoveRequest,
): McpRemoveOperation | null {
  const op = cancelledOperation(raw, expected);
  return op === null ? null : parseMcpRemoveOperation(op, expected);
}
