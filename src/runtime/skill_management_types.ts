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
// Public skill preference protocol. No raw configuration or path authority.
import {
  validInventoryDirectory,
  validInventoryId,
} from "./extension_inventory_types";
// Generic UI types; official Codex routing stays within acp_client.
export type SkillEnablementReason =
  | "incompleteInventory"
  | "unsupportedOrigin"
  | "pluginManaged"
  | "unsafeLabel"
  | "ambiguousTarget";
export type SkillEnablement =
  | { availability: "reviewable"; reason: null }
  | { availability: "unavailable"; reason: SkillEnablementReason };

// Add skillEnablement: InventoryCapability to ExtensionCapabilities, source
// officialAppServer. Add enablement: SkillEnablement to each SkillInventoryItem.
// Every frontend InventoryResult retains its ORIGINAL InventoryRequest, never
// the current view.request of a later MCP or skills query.

export type SkillChangeCode =
  | "notReviewed"
  | "entryUnverified"
  | "platformUnsupported"
  | "environmentUnavailable"
  | "selectionChanged"
  | "cwdUnavailable"
  | "busy"
  | "spawnFailed"
  | "queryFailed"
  | "invalidOutput"
  | "outputLimit"
  | "timedOut"
  | "cancelled"
  | "pendingCleanup"
  | "unknownRequest"
  | "invalidRequest"
  | "requestConflict"
  | "unavailable"
  | "targetUnavailable"
  | "targetChanged"
  | "inventoryIncomplete"
  | "reviewExpired"
  | "reviewConsumed"
  | "configurationUnsupported"
  | "configurationChanged"
  | "configurationReadOnly"
  | "configurationRejected"
  | "writeUncertain";

export interface SkillChangeInspectInput {
  agentId: string;
  requestId: string;
  inventoryRequestId: string;
  itemId: number;
  enabled: boolean;
}
export interface SkillChangeConfirmInput {
  agentId: string;
  requestId: string;
  reviewId: string;
}
export interface SkillChangeRequestKey {
  agentId: string;
  requestId: string;
}
export interface SkillChangeRecheckInput extends SkillChangeRequestKey {
  operationId: string; // original confirm request; this request has a NEW UUID
}
export interface SkillChangeTarget {
  inventoryRequestId: string;
  itemId: number;
  name: string;
  origin: "user" | "repo";
  displayPath: string; // allowlisted, plain-text locator; never write authority
}
export interface SkillChangeScope {
  kind: "user" | "profile";
  configDisplayPath: string; // exact selected writable layer, home shortened
}
export interface SkillChangeReview {
  reviewId: string;
  agentId: string;
  cwd: string;
  target: SkillChangeTarget;
  requestedEnabled: boolean;
  reportedEnabled: boolean;
  writeScope: SkillChangeScope;
  observedAtMs: number;
  validForMs: 300000; // display only; backend monotonic expiry is authoritative
  rulesBefore: number;
  rulesAfter: number;
  mutation: "appendPathRule" | "updateLastPathRule";
  preservation: "officialJsonValues";
  sessionApplicability: "unverified";
}
export interface SkillChangeObservation {
  observedAtMs: number;
  configuration: "matchesIntended" | "changed" | "unverified";
  skill: "matchesRequested" | "differs" | "missing" | "unverified";
  reportedEnabled: boolean | null;
  sessionApplicability: "unverified";
}
export type SkillChangeOutcome =
  | "notDispatched"
  | "rejected"
  | "verified"
  | "observed"
  | "mismatch"
  | "unknown";
export interface SkillChangeOperation {
  agentId: string;
  requestId: string;
  action: "inspect" | "setEnabled" | "recheck";
  cwd: string;
  target: SkillChangeTarget;
  requestedEnabled: boolean;
  operationId: string | null; // non-null only for recheck
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
  settled: boolean; // owned worker, child/group AND pipes finished
  writeDispatched: boolean; // recheck carries original confirm value, never writes
  writeAck: "none" | "ok" | "okOverridden" | "rejected" | "unknown";
  outcome: SkillChangeOutcome | null;
  code: SkillChangeCode | null;
  review: SkillChangeReview | null; // ready inspect only; not regranted by status
  observation: SkillChangeObservation | null;
}
export interface SkillChangeCancellation {
  agentId: string;
  requestId: string;
  cancelRequested: true;
  operation: SkillChangeOperation | null;
}

export interface SkillChangeRequest extends SkillChangeRequestKey {
  action: SkillChangeOperation["action"];
  cwd: string;
  target: Omit<SkillChangeTarget, "displayPath"> & { displayPath?: string };
  requestedEnabled: boolean;
  operationId: string | null;
}
export const SKILL_CHANGE_CODES: readonly SkillChangeCode[] = [
  "notReviewed",
  "entryUnverified",
  "platformUnsupported",
  "environmentUnavailable",
  "selectionChanged",
  "cwdUnavailable",
  "busy",
  "spawnFailed",
  "queryFailed",
  "invalidOutput",
  "outputLimit",
  "timedOut",
  "cancelled",
  "pendingCleanup",
  "unknownRequest",
  "invalidRequest",
  "requestConflict",
  "unavailable",
  "targetUnavailable",
  "targetChanged",
  "inventoryIncomplete",
  "reviewExpired",
  "reviewConsumed",
  "configurationUnsupported",
  "configurationChanged",
  "configurationReadOnly",
  "configurationRejected",
  "writeUncertain",
];
export function skillChangeFailure(raw: unknown): SkillChangeCode | null {
  try {
    return one(record(raw, ["code"]).code, SKILL_CHANGE_CODES);
  } catch {
    return null;
  }
}
function target(raw: unknown, expected: SkillChangeRequest): SkillChangeTarget {
  const t = record(raw, [
    "inventoryRequestId",
    "itemId",
    "name",
    "origin",
    "displayPath",
  ]);
  if (
    !validInventoryId(t.inventoryRequestId) ||
    t.inventoryRequestId !== expected.target.inventoryRequestId ||
    integer(t.itemId, 511) !== expected.target.itemId ||
    t.name !== expected.target.name ||
    t.origin !== expected.target.origin
  )
    return invalid();
  const displayPath = text(t.displayPath);
  if (
    expected.target.displayPath !== undefined &&
    displayPath !== expected.target.displayPath
  )
    return invalid();
  return {
    inventoryRequestId: t.inventoryRequestId,
    itemId: t.itemId as number,
    name: text(t.name, 256),
    origin: one(t.origin, ["user", "repo"]),
    displayPath,
  };
}
function review(raw: unknown, expected: SkillChangeRequest): SkillChangeReview {
  const v = record(raw, [
    "reviewId",
    "agentId",
    "cwd",
    "target",
    "requestedEnabled",
    "reportedEnabled",
    "writeScope",
    "observedAtMs",
    "validForMs",
    "rulesBefore",
    "rulesAfter",
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
    v.preservation !== "officialJsonValues" ||
    v.sessionApplicability !== "unverified"
  )
    return invalid();
  const scope = record(v.writeScope, ["kind", "configDisplayPath"]);
  const before = integer(v.rulesBefore, 1024),
    after = integer(v.rulesAfter, 1024);
  const mutation = one(v.mutation, ["appendPathRule", "updateLastPathRule"]);
  if (
    mutation === "appendPathRule"
      ? after !== before + 1
      : before < 1 || after !== before
  )
    return invalid();
  return {
    reviewId: v.reviewId,
    agentId: expected.agentId,
    cwd: expected.cwd,
    target: target(v.target, expected),
    requestedEnabled: expected.requestedEnabled,
    reportedEnabled: bool(v.reportedEnabled),
    writeScope: {
      kind: one(scope.kind, ["user", "profile"]),
      configDisplayPath: text(scope.configDisplayPath),
    },
    observedAtMs: integer(v.observedAtMs),
    validForMs: 300000,
    rulesBefore: before,
    rulesAfter: after,
    mutation,
    preservation: "officialJsonValues",
    sessionApplicability: "unverified",
  };
}
function observation(raw: unknown): SkillChangeObservation {
  const v = record(raw, [
    "observedAtMs",
    "configuration",
    "skill",
    "reportedEnabled",
    "sessionApplicability",
  ]);
  if (v.sessionApplicability !== "unverified") return invalid();
  const skill = one(v.skill, [
    "matchesRequested",
    "differs",
    "missing",
    "unverified",
  ]);
  if (
    skill === "matchesRequested" || skill === "differs"
      ? typeof v.reportedEnabled !== "boolean"
      : v.reportedEnabled !== null
  )
    return invalid();
  return {
    observedAtMs: integer(v.observedAtMs),
    configuration: one(v.configuration, [
      "matchesIntended",
      "changed",
      "unverified",
    ]),
    skill,
    reportedEnabled: v.reportedEnabled as boolean | null,
    sessionApplicability: "unverified",
  };
}
export function parseSkillChangeOperation(
  raw: unknown,
  expected: SkillChangeRequest,
): SkillChangeOperation {
  const v = record(raw, OPERATION_KEYS);
  operationIdentity(v, expected);
  const obs = v.observation === null ? null : observation(v.observation);
  if (
    (obs?.skill === "matchesRequested" &&
      obs.reportedEnabled !== expected.requestedEnabled) ||
    (obs?.skill === "differs" &&
      obs.reportedEnabled === expected.requestedEnabled)
  )
    invalid();
  const parsedTarget = target(v.target, expected),
    rev = v.review === null ? null : review(v.review, expected);
  if (rev && rev.target.displayPath !== parsedTarget.displayPath) invalid();
  return {
    ...expected,
    target: parsedTarget,
    ...lifecycle(v, expected, {
      hasObservation: !!obs,
      hasReview: !!rev,
      matching:
        obs?.configuration === "matchesIntended" &&
        obs.skill === "matchesRequested",
      different:
        obs?.configuration === "changed" ||
        obs?.skill === "differs" ||
        obs?.skill === "missing",
    }),
    review: rev,
    observation: obs,
  };
}
export function parseSkillChangeCancellation(
  raw: unknown,
  expected: SkillChangeRequest,
): SkillChangeOperation | null {
  const operation = cancelledOperation(raw, expected);
  return operation === null
    ? null
    : parseSkillChangeOperation(operation, expected);
}
