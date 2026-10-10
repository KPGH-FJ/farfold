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
function invalid(): never {
  throw { code: "invalidOutput" };
}
function record(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  const v = raw as Record<string, unknown>;
  if (
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    return invalid();
  return v;
}
function one<T extends string>(v: unknown, values: readonly T[]): T {
  return typeof v === "string" && values.includes(v as T)
    ? (v as T)
    : invalid();
}
function integer(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  return Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max
    ? (v as number)
    : invalid();
}
function text(v: unknown, max = 4096): string {
  if (
    typeof v !== "string" ||
    !v ||
    new TextEncoder().encode(v).length > max ||
    /[\u0000-\u001f\u007f-\u009f]/.test(v)
  )
    return invalid();
  return v;
}
function bool(v: unknown): boolean {
  return typeof v === "boolean" ? v : invalid();
}
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
  const v = record(raw, [
    "agentId",
    "requestId",
    "action",
    "cwd",
    "target",
    "requestedEnabled",
    "operationId",
    "state",
    "phase",
    "settled",
    "writeDispatched",
    "writeAck",
    "outcome",
    "code",
    "review",
    "observation",
  ]);
  if (
    !validInventoryId(expected.requestId) ||
    !validInventoryDirectory(expected.cwd) ||
    v.agentId !== expected.agentId ||
    v.requestId !== expected.requestId ||
    v.action !== expected.action ||
    v.cwd !== expected.cwd ||
    v.requestedEnabled !== expected.requestedEnabled ||
    v.operationId !== expected.operationId ||
    (expected.action === "recheck"
      ? !validInventoryId(v.operationId)
      : v.operationId !== null)
  )
    return invalid();
  const state = one(v.state, [
    "running",
    "cancelling",
    "pendingCleanup",
    "ready",
    "failed",
    "cancelled",
  ]);
  const phase = one(v.phase, [
    "queued",
    "starting",
    "reading",
    "writing",
    "checking",
    "cleaning",
    "complete",
  ]);
  const settled = bool(v.settled),
    dispatched = bool(v.writeDispatched);
  const ack = one(v.writeAck, [
    "none",
    "ok",
    "okOverridden",
    "rejected",
    "unknown",
  ]);
  const outcome =
    v.outcome === null
      ? null
      : one(v.outcome, [
          "notDispatched",
          "rejected",
          "verified",
          "observed",
          "mismatch",
          "unknown",
        ]);
  const code = v.code === null ? null : one(v.code, SKILL_CHANGE_CODES);
  const obs = v.observation === null ? null : observation(v.observation);
  if (
    settled !== ["ready", "failed", "cancelled"].includes(state) ||
    settled !== (phase === "complete") ||
    (!settled && outcome !== null) ||
    (!dispatched && ack !== "none") ||
    (dispatched && (ack === "none" || state === "cancelled")) ||
    ((state === "failed" || state === "cancelled") && !code)
  )
    return invalid();
  if (
    obs?.skill === "matchesRequested" &&
    obs.reportedEnabled !== expected.requestedEnabled
  )
    return invalid();
  if (
    obs?.skill === "differs" &&
    obs.reportedEnabled === expected.requestedEnabled
  )
    return invalid();
  const parsedTarget = target(v.target, expected);
  const rev = v.review === null ? null : review(v.review, expected);
  if (rev && rev.target.displayPath !== parsedTarget.displayPath)
    return invalid();
  if (expected.action === "inspect") {
    if (
      dispatched ||
      ack !== "none" ||
      outcome !== null ||
      obs !== null ||
      (state === "ready") !== (rev !== null)
    )
      return invalid();
  } else {
    if (rev || (settled && outcome === null)) return invalid();
    const matching =
      obs?.configuration === "matchesIntended" &&
      obs.skill === "matchesRequested";
    if (
      outcome === "verified" &&
      (expected.action !== "setEnabled" ||
        !dispatched ||
        !["ok", "okOverridden"].includes(ack) ||
        !matching ||
        state !== "ready")
    )
      return invalid();
    if (
      outcome === "observed" &&
      (expected.action !== "recheck" || !matching || state !== "ready")
    )
      return invalid();
    if (outcome === "notDispatched" && dispatched) return invalid();
    if (outcome === "rejected" && dispatched && ack !== "rejected")
      return invalid();
    if (
      outcome === "mismatch" &&
      !(
        obs?.configuration === "changed" ||
        obs?.skill === "differs" ||
        obs?.skill === "missing"
      )
    )
      return invalid();
  }
  return {
    ...expected,
    target: parsedTarget,
    state,
    phase,
    settled,
    writeDispatched: dispatched,
    writeAck: ack,
    outcome,
    code,
    review: rev,
    observation: obs,
  };
}
export function parseSkillChangeCancellation(
  raw: unknown,
  expected: SkillChangeRequest,
): SkillChangeOperation | null {
  const v = record(raw, [
    "agentId",
    "requestId",
    "cancelRequested",
    "operation",
  ]);
  if (
    v.agentId !== expected.agentId ||
    v.requestId !== expected.requestId ||
    v.cancelRequested !== true
  )
    return invalid();
  return v.operation === null
    ? null
    : parseSkillChangeOperation(v.operation, expected);
}
