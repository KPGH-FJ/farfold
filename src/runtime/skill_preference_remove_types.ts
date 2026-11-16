import type {
  SkillChangeInspectInput,
  SkillChangeConfirmInput,
  SkillChangeRequestKey,
  SkillChangeRecheckInput,
  SkillChangeScope,
  SkillChangeOperation,
  SkillChangeTarget,
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

export type SkillPreferenceRemoveTarget = SkillChangeTarget & {
  kind: "skillPreferenceRemoval";
};
export type SkillPreferenceRemoveReview = {
  reviewId: string;
  agentId: string;
  cwd: string;
  target: SkillPreferenceRemoveTarget;
  requestedEnabled: null;
  configuredEnabled: boolean;
  reportedEnabled: boolean;
  rulesBefore: number;
  rulesAfter: number;
  writeScope: SkillChangeScope;
  observedAtMs: number;
  validForMs: 300000;
  mutation: "removeSkillPathPreference";
  parentHandling: "mayRemainEmpty" | "preserveSiblings";
  preservation: "otherConfigurationSemanticsPreserved";
  sessionApplicability: "unverified";
};
export type SkillPreferenceRemoveObservation = {
  observedAtMs: number;
  configuration: "matching" | "different";
  skill: "reported" | "missing";
  configuredEnabled: boolean | null;
  reportedEnabled: boolean | null;
  parentOutcome: "absent" | "empty" | "nonempty" | null;
  sessionApplicability: "unverified";
};
export type SkillPreferenceRemoveOperation = Omit<
  SkillChangeOperation,
  "action" | "target" | "requestedEnabled" | "review" | "observation" | "code"
> & {
  action: "inspect" | "remove" | "recheck";
  target: SkillPreferenceRemoveTarget;
  requestedEnabled: null;
  review: SkillPreferenceRemoveReview | null;
  observation: SkillPreferenceRemoveObservation | null;
  code: SkillPreferenceRemoveCode | null;
};
export type SkillPreferenceRemoveInspectInput = Omit<
  SkillChangeInspectInput,
  "enabled"
>;
export type SkillPreferenceRemoveConfirmInput = SkillChangeConfirmInput;
export type SkillPreferenceRemoveRequestKey = SkillChangeRequestKey;
export type SkillPreferenceRemoveRecheckInput = SkillChangeRecheckInput;
export type SkillPreferenceRemoveRequest = Pick<
  SkillPreferenceRemoveOperation,
  | "agentId"
  | "requestId"
  | "action"
  | "cwd"
  | "requestedEnabled"
  | "operationId"
> & {
  target: Omit<SkillPreferenceRemoveTarget, "displayPath"> & {
    displayPath?: string;
  };
};
export const SKILL_PREFERENCE_REMOVE_CODES = [
  ...SKILL_CHANGE_CODES,
  "preferenceNotConfigured",
] as const;
export type SkillPreferenceRemoveCode =
  (typeof SKILL_PREFERENCE_REMOVE_CODES)[number];
export function skillPreferenceRemoveFailure(
  raw: unknown,
): SkillPreferenceRemoveCode | null {
  try {
    return one(record(raw, ["code"]).code, SKILL_PREFERENCE_REMOVE_CODES);
  } catch {
    return null;
  }
}

function target(
  raw: unknown,
  expected: SkillPreferenceRemoveRequest,
): SkillPreferenceRemoveTarget {
  const v = record(raw, [
    "kind",
    "inventoryRequestId",
    "itemId",
    "name",
    "origin",
    "displayPath",
  ]);
  if (
    v.kind !== "skillPreferenceRemoval" ||
    !validInventoryId(v.inventoryRequestId) ||
    v.inventoryRequestId !== expected.target.inventoryRequestId ||
    integer(v.itemId, 511) !== expected.target.itemId ||
    v.name !== expected.target.name ||
    v.origin !== expected.target.origin
  )
    invalid();
  const displayPath = text(v.displayPath);
  if (
    expected.target.displayPath !== undefined &&
    displayPath !== expected.target.displayPath
  )
    invalid();
  return {
    kind: "skillPreferenceRemoval",
    inventoryRequestId: v.inventoryRequestId,
    itemId: v.itemId as number,
    name: text(v.name, 256),
    origin: one(v.origin, ["user", "repo"]),
    displayPath,
  };
}

function review(
  raw: unknown,
  expected: SkillPreferenceRemoveRequest,
): SkillPreferenceRemoveReview {
  const v = record(raw, [
    "reviewId",
    "agentId",
    "cwd",
    "target",
    "requestedEnabled",
    "configuredEnabled",
    "reportedEnabled",
    "rulesBefore",
    "rulesAfter",
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
    v.validForMs !== 300000 ||
    v.mutation !== "removeSkillPathPreference" ||
    v.preservation !== "otherConfigurationSemanticsPreserved" ||
    v.sessionApplicability !== "unverified"
  )
    invalid();
  const before = integer(v.rulesBefore, 1024),
    after = integer(v.rulesAfter, 1024);
  if (
    before < 1 ||
    after !== before - 1 ||
    (after > 0 && v.parentHandling !== "preserveSiblings")
  )
    invalid();
  const scope = record(v.writeScope, ["kind", "configDisplayPath"]);
  return {
    reviewId: v.reviewId,
    agentId: expected.agentId,
    cwd: expected.cwd,
    target: target(v.target, expected),
    requestedEnabled: null,
    configuredEnabled: bool(v.configuredEnabled),
    reportedEnabled: bool(v.reportedEnabled),
    rulesBefore: before,
    rulesAfter: after,
    writeScope: {
      kind: one(scope.kind, ["user", "profile"]),
      configDisplayPath: text(scope.configDisplayPath),
    },
    observedAtMs: integer(v.observedAtMs),
    validForMs: 300000,
    mutation: "removeSkillPathPreference",
    parentHandling: one(v.parentHandling, [
      "mayRemainEmpty",
      "preserveSiblings",
    ]),
    preservation: "otherConfigurationSemanticsPreserved",
    sessionApplicability: "unverified",
  };
}

function observation(raw: unknown): SkillPreferenceRemoveObservation {
  const v = record(raw, [
    "observedAtMs",
    "configuration",
    "skill",
    "configuredEnabled",
    "reportedEnabled",
    "parentOutcome",
    "sessionApplicability",
  ]);
  if (v.sessionApplicability !== "unverified") invalid();
  const configuration = one(v.configuration, ["matching", "different"]),
    skill = one(v.skill, ["reported", "missing"]),
    configuredEnabled =
      v.configuredEnabled === null ? null : bool(v.configuredEnabled),
    reportedEnabled =
      v.reportedEnabled === null ? null : bool(v.reportedEnabled),
    parentOutcome =
      v.parentOutcome === null
        ? null
        : one(v.parentOutcome, ["absent", "empty", "nonempty"]);
  if (
    (configuration === "matching" &&
      (configuredEnabled !== null || parentOutcome === null)) ||
    (skill === "reported"
      ? reportedEnabled === null
      : reportedEnabled !== null) ||
    ((parentOutcome === "absent" || parentOutcome === "empty") &&
      configuredEnabled !== null)
  )
    invalid();
  return {
    observedAtMs: integer(v.observedAtMs),
    configuration,
    skill,
    configuredEnabled,
    reportedEnabled,
    parentOutcome,
    sessionApplicability: "unverified",
  };
}

export function parseSkillPreferenceRemoveOperation(
  raw: unknown,
  expected: SkillPreferenceRemoveRequest,
): SkillPreferenceRemoveOperation {
  const v = record(raw, OPERATION_KEYS);
  one(expected.action, ["inspect", "remove", "recheck"]);
  if (
    expected.requestedEnabled !== null ||
    expected.target.kind !== "skillPreferenceRemoval"
  )
    invalid();
  operationIdentity(v, expected);
  const parsedTarget = target(v.target, expected),
    rev = v.review === null ? null : review(v.review, expected),
    obs = v.observation === null ? null : observation(v.observation);
  if (rev && rev.target.displayPath !== parsedTarget.displayPath) invalid();
  const state = lifecycle(
    v,
    expected,
    {
      hasReview: !!rev,
      hasObservation: !!obs,
      inspectionFailureOutcome: "notDispatched",
      matching: obs?.configuration === "matching" && obs.skill === "reported",
      different: obs?.configuration === "different" || obs?.skill === "missing",
    },
    SKILL_PREFERENCE_REMOVE_CODES,
  );
  if (
    (!state.settled && (rev !== null || obs !== null)) ||
    (state.state === "ready" && state.code !== null) ||
    (state.state === "cancelled" && state.code !== "cancelled") ||
    (state.code === "preferenceNotConfigured" &&
      (expected.action !== "inspect" || state.state !== "failed"))
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

export function parseSkillPreferenceRemoveCancellation(
  raw: unknown,
  expected: SkillPreferenceRemoveRequest,
): SkillPreferenceRemoveOperation | null {
  const operation = cancelledOperation(raw, expected);
  return operation === null
    ? null
    : parseSkillPreferenceRemoveOperation(operation, expected);
}
