// Shared validation of finite preference operations; domain parsers retain exact shapes.
import {
  validInventoryDirectory,
  validInventoryId,
} from "./extension_inventory_types";
import {
  SKILL_CHANGE_CODES,
  type SkillChangeOperation,
  type SkillChangeCode,
  type SkillChangeRequest,
} from "./skill_management_types";
export function invalid(): never {
  throw { code: "invalidOutput" };
}
export function record(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  const v = raw as Record<string, unknown>;
  if (
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    return invalid();
  return v;
}
export function one<T extends string>(v: unknown, values: readonly T[]): T {
  return typeof v === "string" && values.includes(v as T)
    ? (v as T)
    : invalid();
}
export function integer(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  return Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max
    ? (v as number)
    : invalid();
}
export function text(v: unknown, max = 4096): string {
  if (
    typeof v !== "string" ||
    !v ||
    new TextEncoder().encode(v).length > max ||
    /[\u0000-\u001f\u007f-\u009f]/.test(v)
  )
    return invalid();
  return v;
}
export function bool(v: unknown): boolean {
  return typeof v === "boolean" ? v : invalid();
}

export const OPERATION_KEYS = [
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
];
type Identity = Omit<SkillChangeRequest, "target" | "action"> & {
  action: "inspect" | "setEnabled" | "add" | "recheck";
};
export function operationIdentity(
  v: Record<string, unknown>,
  expected: Identity,
) {
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
    invalid();
}
export function lifecycle<C extends string = SkillChangeCode>(
  v: Record<string, unknown>,
  expected: Identity,
  facts: {
    hasObservation: boolean;
    hasReview: boolean;
    matching: boolean;
    different: boolean;
    inspectionFailureOutcome?: "notDispatched";
  },
  codes?: readonly C[],
) {
  const state = one(v.state, [
    "running",
    "cancelling",
    "pendingCleanup",
    "ready",
    "failed",
    "cancelled",
  ] as const);
  const phase = one(v.phase, [
    "queued",
    "starting",
    "reading",
    "writing",
    "checking",
    "cleaning",
    "complete",
  ] as const);
  const settled = bool(v.settled),
    dispatched = bool(v.writeDispatched);
  const ack = one(v.writeAck, [
    "none",
    "ok",
    "okOverridden",
    "rejected",
    "unknown",
  ] as const);
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
        ] as const);
  const code =
    v.code === null
      ? null
      : (one<string>(v.code, codes ?? SKILL_CHANGE_CODES) as C);
  if (
    settled !== ["ready", "failed", "cancelled"].includes(state) ||
    settled !== (phase === "complete") ||
    (!settled && outcome !== null) ||
    (!dispatched && ack !== "none") ||
    (dispatched && (ack === "none" || state === "cancelled")) ||
    ((state === "failed" || state === "cancelled") && !code)
  )
    invalid();
  if (expected.action === "inspect") {
    const requiredOutcome = ["failed", "cancelled"].includes(state)
      ? (facts.inspectionFailureOutcome ?? null)
      : null;
    if (
      dispatched ||
      ack !== "none" ||
      outcome !== requiredOutcome ||
      facts.hasObservation ||
      (state === "ready") !== facts.hasReview
    )
      invalid();
  } else {
    if (facts.hasReview || (settled && outcome === null)) invalid();
    if (
      outcome === "verified" &&
      (!["setEnabled", "add"].includes(expected.action) ||
        !dispatched ||
        !["ok", "okOverridden"].includes(ack) ||
        !facts.matching ||
        state !== "ready")
    )
      invalid();
    if (
      outcome === "observed" &&
      (expected.action !== "recheck" || !facts.matching || state !== "ready")
    )
      invalid();
    if (outcome === "notDispatched" && dispatched) invalid();
    if (outcome === "rejected" && dispatched && ack !== "rejected") invalid();
    if (outcome === "mismatch" && !facts.different) invalid();
  }
  return {
    state,
    phase,
    settled,
    writeDispatched: dispatched,
    writeAck: ack,
    outcome,
    code,
  } satisfies Omit<
    Pick<
      SkillChangeOperation,
      | "state"
      | "phase"
      | "settled"
      | "writeDispatched"
      | "writeAck"
      | "outcome"
      | "code"
    >,
    "code"
  > & { code: C | null };
}
export function cancelledOperation(
  raw: unknown,
  expected: { agentId: string; requestId: string },
) {
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
    invalid();
  return v.operation;
}
