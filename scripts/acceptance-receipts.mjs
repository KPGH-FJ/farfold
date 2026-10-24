#!/usr/bin/env node
// Evidence-side checks only. No Agent execution or product-state updates.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RECEIPT_SCHEMA_VERSION = 1;
export const EVIDENCE_LEVELS = Object.freeze([
  "shared",
  "protocol",
  "installed",
  "real-agent",
]);

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed-out"]);
const SOURCES = new Set([
  "test-runner",
  "controlled-peer",
  "official-interface",
  "installed-ui",
  "filesystem",
  "os-observation",
]);
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,159}$/;
const CONDITION_ID =
  /^(standard:S[1-8]|requirement:[A-Z][A-Z0-9-]*|package:[A-NXZ]|common:[1-9][0-9]*)$/;
const FORBIDDEN_KEY =
  /^(env|environment|credentials?|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|stdout|stderr|body|database)$/i;
const ALLOWED_PREFIXES = ["docs/evidence/", "docs/maintenance/", "output/"];

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 8192;
const identifier = (value) => typeof value === "string" && ID.test(value);
const time = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const subsetKeys = (value, allowed) =>
  object(value) && Object.keys(value).every((key) => allowed.includes(key));
const uniqueIds = (values) =>
  Array.isArray(values) &&
  values.length > 0 &&
  values.every(identifier) &&
  new Set(values).size === values.length;

function inputMap(value) {
  return (
    object(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([key, entry]) => identifier(key) && text(entry),
    )
  );
}

function hasForbiddenMetadata(value, agentScope = false) {
  if (Array.isArray(value)) {
    return value.some((entry) => hasForbiddenMetadata(entry, agentScope));
  }
  if (!object(value)) return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      FORBIDDEN_KEY.test(key) ||
      (agentScope && /sha|hash|digest|binary/i.test(key)) ||
      hasForbiddenMetadata(entry, agentScope || key === "agent"),
  );
}

function contextValid(context, requiresInstalled) {
  if (
    !subsetKeys(context, [
      "agentId",
      "platform",
      "productCommit",
      "app",
      "observedAgentVersion",
      "selection",
    ]) ||
    !identifier(context.agentId) ||
    !identifier(context.platform) ||
    !text(context.productCommit)
  ) {
    return false;
  }
  if (
    context.observedAgentVersion !== undefined &&
    !text(context.observedAgentVersion)
  ) {
    return false;
  }
  const app = context.app;
  if (
    app !== undefined &&
    (!subsetKeys(app, [
      "bundleId",
      "version",
      "binarySha256",
      "installedPath",
    ]) ||
      app.bundleId !== "ai.farfold.desktop" ||
      !text(app.version) ||
      !HEX.test(app.binarySha256 ?? "") ||
      !text(app.installedPath))
  ) {
    return false;
  }
  const selection = context.selection;
  if (
    selection !== undefined &&
    (!subsetKeys(selection, ["serviceId", "modelId", "reasoningId"]) ||
      !text(selection.serviceId) ||
      !text(selection.modelId) ||
      !(selection.reasoningId === null || text(selection.reasoningId)))
  ) {
    return false;
  }
  return (
    !requiresInstalled ||
    (app !== undefined &&
      selection !== undefined &&
      text(context.observedAgentVersion))
  );
}

function safeRef(ref) {
  if (
    !subsetKeys(ref, [
      "path",
      "sha256",
      "visibility",
      "privacyReviewed",
      "level",
      "source",
    ]) ||
    !text(ref.path) ||
    !HEX.test(ref.sha256 ?? "") ||
    !["public", "private"].includes(ref.visibility) ||
    (ref.visibility === "public" && ref.privacyReviewed !== true) ||
    !ALLOWED_PREFIXES.some((prefix) => ref.path.startsWith(prefix)) ||
    path.isAbsolute(ref.path) ||
    /[\\\x00-\x1f]/.test(ref.path) ||
    ref.path
      .split("/")
      .some((part) => ["", ".", "..", ".git", "node_modules"].includes(part))
  ) {
    return false;
  }
  return true;
}

function inside(rootDir, candidate) {
  const relative = path.relative(rootDir, candidate);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

// Evidence bytes are streamed into a digest, never copied or printed. Only the
// bounded JSON run manifest is parsed. Static symlinks and observed path changes
// are rejected. Node exposes no directory-fd-relative open here, so this is not
// a sandbox against a hostile concurrent ancestor-directory swap. Run only over
// owned, quiescent evidence paths; independent source/privacy review still applies.
async function inspectRef(ref, rootDir, parseManifest = false) {
  if (!safeRef(ref)) return { error: "unsafe-evidence-reference" };
  const root = await realpath(rootDir);
  const file = path.resolve(root, ref.path);
  if (!inside(root, file)) return { error: "unsafe-evidence-reference" };
  let handle;
  try {
    let cursor = root;
    for (const part of ref.path.split("/")) {
      cursor = path.join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) {
        return { error: "symlink-evidence-reference" };
      }
    }
    if ((await realpath(file)) !== file) {
      return { error: "unsafe-evidence-reference" };
    }
    if (!(await lstat(file)).isFile()) {
      return { error: "not-regular-evidence-file" };
    }
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile()) return { error: "not-regular-evidence-file" };
    if (parseManifest && before.size > 4 * 1024 * 1024) {
      return { error: "manifest-too-large" };
    }
    const hash = createHash("sha256");
    const parts = [];
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      if (bytesRead === 0) break;
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      if (parseManifest) parts.push(Buffer.from(bytes));
      offset += bytesRead;
    }
    const after = await handle.stat();
    const pathname = await lstat(file);
    if (
      offset !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== pathname.ino ||
      before.dev !== pathname.dev ||
      pathname.isSymbolicLink() ||
      (await realpath(file)) !== file
    ) {
      return { error: "evidence-changed-during-read" };
    }
    if (hash.digest("hex") !== ref.sha256) {
      return { error: "evidence-digest-mismatch" };
    }
    if (!parseManifest) return { bytes: after.size };
    try {
      return { value: JSON.parse(Buffer.concat(parts).toString("utf8")) };
    } catch {
      return { error: "manifest-not-json" };
    }
  } catch {
    return { error: "evidence-unreadable" };
  } finally {
    await handle?.close();
  }
}

function validateManifest(manifest, runId, errors) {
  if (
    !subsetKeys(manifest, [
      "schemaVersion",
      "runId",
      "preparedAt",
      "reviewBy",
      "context",
      "inputs",
      "dependencies",
      "expectedCases",
    ]) ||
    manifest.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    manifest.runId !== runId ||
    !time(manifest.preparedAt) ||
    !inputMap(manifest.inputs) ||
    !Array.isArray(manifest.expectedCases) ||
    manifest.expectedCases.length === 0 ||
    !Array.isArray(manifest.dependencies) ||
    manifest.dependencies.length === 0
  ) {
    errors.push({ code: "invalid-run-manifest" });
    return false;
  }
  if (
    manifest.reviewBy !== undefined &&
    (!time(manifest.reviewBy) ||
      Date.parse(manifest.reviewBy) <= Date.parse(manifest.preparedAt))
  ) {
    errors.push({ code: "invalid-review-horizon" });
  }
  const dependencies = new Set();
  for (const entry of manifest.dependencies) {
    if (
      !subsetKeys(entry, ["id", "kind", "fingerprint"]) ||
      !identifier(entry.id) ||
      ![
        "source",
        "app",
        "agent-version",
        "selection",
        "platform",
        "fixture",
        "official-contract",
      ].includes(entry.kind) ||
      !text(entry.fingerprint) ||
      (entry.kind === "agent-version" && HEX.test(entry.fingerprint)) ||
      dependencies.has(entry.id)
    ) {
      errors.push({ code: "invalid-dependency" });
    } else {
      dependencies.add(entry.id);
    }
  }
  const installed = manifest.expectedCases.some((entry) =>
    ["installed", "real-agent"].includes(entry?.level),
  );
  if (!contextValid(manifest.context, installed)) {
    errors.push({ code: "invalid-run-context" });
  }
  const caseIds = new Set();
  for (const [index, entry] of manifest.expectedCases.entries()) {
    const code = (value) => errors.push({ code: value, caseIndex: index });
    if (
      !subsetKeys(entry, [
        "caseId",
        "agentId",
        "standardIds",
        "requirementIds",
        "level",
        "expectedOutcome",
        "safety",
        "coveredConditions",
        "requiredObservations",
        "dependencies",
      ]) ||
      !identifier(entry.caseId) ||
      caseIds.has(entry.caseId) ||
      entry.agentId !== manifest.context?.agentId ||
      !uniqueIds(entry.standardIds) ||
      !entry.standardIds.every((id) => /^S[1-8]$/.test(id)) ||
      !uniqueIds(entry.requirementIds) ||
      !EVIDENCE_LEVELS.includes(entry.level) ||
      !["success", "rejection"].includes(entry.expectedOutcome) ||
      !["observation", "side-effect"].includes(entry.safety) ||
      !uniqueIds(entry.dependencies) ||
      !entry.dependencies.every((id) => dependencies.has(id))
    ) {
      code("invalid-expected-case");
      continue;
    }
    caseIds.add(entry.caseId);
    if (
      !Array.isArray(entry.coveredConditions) ||
      entry.coveredConditions.length === 0 ||
      entry.coveredConditions.some(
        (condition) =>
          !subsetKeys(condition, ["conditionId", "condition", "excerpt"]) ||
          !CONDITION_ID.test(condition.conditionId ?? "") ||
          !text(condition.condition) ||
          !text(condition.excerpt) ||
          !condition.condition.includes(condition.excerpt),
      )
    ) {
      code("invalid-condition-coverage");
    }
    if (
      !Array.isArray(entry.requiredObservations) ||
      entry.requiredObservations.length === 0 ||
      entry.requiredObservations.some(
        (observation) =>
          !subsetKeys(observation, [
            "observationId",
            "kind",
            "source",
            "expectedValue",
          ]) ||
          !identifier(observation.observationId) ||
          !identifier(observation.kind) ||
          !SOURCES.has(observation.source) ||
          !["string", "boolean", "number"].includes(
            typeof observation.expectedValue,
          ) ||
          ["unknown", "missing", "unconfirmed"].includes(
            observation.expectedValue,
          ),
      ) ||
      new Set(entry.requiredObservations.map((item) => item?.observationId))
        .size !== entry.requiredObservations.length
    ) {
      code("invalid-observation-requirements");
    }
    if (
      ["installed", "real-agent"].includes(entry.level) &&
      !entry.requiredObservations.some((item) => item.source === "installed-ui")
    ) {
      code("missing-installed-observation");
    }
    if (
      entry.level === "real-agent" &&
      !entry.requiredObservations.some(
        (item) => item.source === "official-interface",
      )
    ) {
      code("missing-official-observation");
    }
  }
  return true;
}

function validateAttempt(attempt, expected, manifest, previous, errors, index) {
  const issues = [];
  const add = (code) => {
    issues.push(code);
    errors.push({ code, attemptIndex: index });
  };
  if (
    !subsetKeys(attempt, [
      "attemptId",
      "caseId",
      "startedAt",
      "finishedAt",
      "status",
      "outcome",
      "level",
      "context",
      "inputsBefore",
      "inputsAfter",
      "observations",
      "evidence",
      "retryOf",
    ]) ||
    !identifier(attempt.attemptId) ||
    !time(attempt.startedAt) ||
    ![...TERMINAL, "started"].includes(attempt.status) ||
    !["success", "rejection", "failure", "unknown"].includes(attempt.outcome) ||
    !EVIDENCE_LEVELS.includes(attempt.level)
  ) {
    add("invalid-attempt");
    return issues;
  }
  if (
    Date.parse(attempt.startedAt) < Date.parse(manifest.preparedAt) ||
    (TERMINAL.has(attempt.status) &&
      (!time(attempt.finishedAt) ||
        Date.parse(attempt.finishedAt) < Date.parse(attempt.startedAt))) ||
    (attempt.status === "started" && attempt.finishedAt !== undefined)
  ) {
    add("invalid-attempt-time-order");
  }
  if (
    attempt.status !== "completed" &&
    ["success", "rejection"].includes(attempt.outcome)
  ) {
    add("non-completed-attempt-claims-success");
  }
  if (
    !contextValid(
      attempt.context,
      ["installed", "real-agent"].includes(attempt.level),
    ) ||
    !equal(attempt.context, manifest.context)
  ) {
    add("attempt-context-mismatch");
  }
  if (
    !inputMap(attempt.inputsBefore) ||
    !inputMap(attempt.inputsAfter) ||
    !equal(attempt.inputsBefore, manifest.inputs) ||
    !equal(attempt.inputsAfter, manifest.inputs)
  ) {
    add("attempt-inputs-not-stable");
  }
  if (attempt.level !== expected.level) add("evidence-level-mismatch");
  if (previous) {
    if (attempt.retryOf !== previous.attemptId)
      add("retry-chain-not-preserved");
    if (
      !time(previous.finishedAt) ||
      Date.parse(attempt.startedAt) < Date.parse(previous.finishedAt)
    ) {
      add("overlapping-or-unfinished-attempt");
    }
    if (
      expected.safety === "side-effect" &&
      (previous.outcome === "unknown" ||
        ["started", "timed-out", "cancelled"].includes(previous.status))
    ) {
      add("unsafe-retry-after-unknown-result");
    }
  } else if (attempt.retryOf !== undefined) {
    add("retry-target-missing");
  }
  if (!Array.isArray(attempt.evidence) || attempt.evidence.length === 0) {
    add("missing-attempt-evidence");
  }
  const observations = attempt.observations;
  if (
    !Array.isArray(observations) ||
    observations.some(
      (observation) =>
        !subsetKeys(observation, [
          "observationId",
          "kind",
          "source",
          "value",
          "evidenceIndexes",
        ]) ||
        !identifier(observation.observationId) ||
        !identifier(observation.kind) ||
        !SOURCES.has(observation.source) ||
        !["string", "boolean", "number"].includes(typeof observation.value) ||
        !Array.isArray(observation.evidenceIndexes) ||
        observation.evidenceIndexes.length === 0 ||
        observation.evidenceIndexes.some(
          (evidenceIndex) =>
            !Number.isInteger(evidenceIndex) ||
            evidenceIndex < 0 ||
            !Array.isArray(attempt.evidence) ||
            evidenceIndex >= attempt.evidence.length,
        ),
    ) ||
    new Set(observations.map((item) => item?.observationId)).size !==
      observations.length
  ) {
    add("invalid-observations");
    return issues;
  }
  if (
    attempt.status === "completed" &&
    attempt.outcome === expected.expectedOutcome
  ) {
    for (const required of expected.requiredObservations ?? []) {
      const actual = observations.find(
        (item) => item.observationId === required.observationId,
      );
      if (
        !actual ||
        actual.kind !== required.kind ||
        actual.source !== required.source ||
        actual.value !== required.expectedValue ||
        actual.evidenceIndexes.some(
          (evidenceIndex) =>
            attempt.evidence[evidenceIndex]?.source !== required.source ||
            attempt.evidence[evidenceIndex]?.level !== attempt.level,
        )
      ) {
        add("required-observation-not-confirmed");
      }
    }
    if (
      observations.some(
        (actual) =>
          !(expected.requiredObservations ?? []).some(
            (item) => item.observationId === actual.observationId,
          ),
      )
    ) {
      add("unexpected-observation");
    }
  }
  return issues;
}

/**
 * Check a single run against its immutable-by-digest run manifest and evidence.
 * A mechanical match is never product acceptance or independent factual review.
 * Self-reported timestamps and observation labels are not tamper-proof attestations.
 */
export async function validateReceipt(
  receipt,
  { rootDir = process.cwd() } = {},
) {
  const report = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    mechanicallyValid: false,
    complete: false,
    allExpectedOutcomesMatched: false,
    acceptanceVerified: false,
    requiresIndependentReview: true,
    errors: [],
    counts: {
      expectedCases: 0,
      attempts: 0,
      passed: 0,
      expectedRejection: 0,
      failed: 0,
      incomplete: 0,
      unstable: 0,
      invalid: 0,
      evidenceFiles: 0,
      privateEvidenceFiles: 0,
    },
    cases: [],
  };
  const errors = report.errors;
  if (
    !subsetKeys(receipt, [
      "schemaVersion",
      "runId",
      "manifest",
      "attempts",
      "inputsAfter",
      "finishedAt",
    ]) ||
    receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    !identifier(receipt.runId) ||
    !Array.isArray(receipt.attempts) ||
    hasForbiddenMetadata(receipt)
  ) {
    errors.push({ code: "invalid-receipt" });
    return report;
  }
  const loaded = await inspectRef(receipt.manifest, rootDir, true);
  if (loaded.error) {
    errors.push({ code: loaded.error });
    return report;
  }
  const manifest = loaded.value;
  if (hasForbiddenMetadata(manifest)) {
    errors.push({ code: "forbidden-run-metadata" });
    return report;
  }
  if (!validateManifest(manifest, receipt.runId, errors)) return report;
  // Reject malformed manifests before using any of their claims.
  if (errors.length > 0) return report;
  report.runId = receipt.runId;
  report.counts.expectedCases = manifest.expectedCases.length;
  report.counts.attempts = receipt.attempts.length;
  if (!equal(receipt.inputsAfter, manifest.inputs)) {
    errors.push({ code: "final-inputs-missing-or-changed" });
  }
  if (
    !time(receipt.finishedAt) ||
    Date.parse(receipt.finishedAt) < Date.parse(manifest.preparedAt)
  ) {
    errors.push({ code: "invalid-run-finish-time" });
  }
  const expectedById = new Map(
    manifest.expectedCases.map((entry) => [entry.caseId, entry]),
  );
  const attemptsByCase = new Map();
  const attemptIds = new Set();
  for (const [index, attempt] of receipt.attempts.entries()) {
    if (!object(attempt) || !expectedById.has(attempt.caseId)) {
      errors.push({ code: "unexpected-case", attemptIndex: index });
      continue;
    }
    const expected = expectedById.get(attempt.caseId);
    const prior = attemptsByCase.get(attempt.caseId) ?? [];
    const issues = validateAttempt(
      attempt,
      expected,
      manifest,
      prior.at(-1)?.attempt,
      errors,
      index,
    );
    if (attemptIds.has(attempt.attemptId)) {
      issues.push("duplicate-attempt-id");
      errors.push({ code: "duplicate-attempt-id", attemptIndex: index });
    }
    attemptIds.add(attempt.attemptId);
    if (
      time(attempt.finishedAt) &&
      time(receipt.finishedAt) &&
      Date.parse(attempt.finishedAt) > Date.parse(receipt.finishedAt)
    ) {
      issues.push("attempt-after-run-finish");
      errors.push({ code: "attempt-after-run-finish", attemptIndex: index });
    }
    for (const [evidenceIndex, evidence] of (Array.isArray(attempt.evidence)
      ? attempt.evidence
      : []
    ).entries()) {
      if (evidence?.level !== attempt.level || !SOURCES.has(evidence?.source)) {
        issues.push("evidence-provenance-mismatch");
        errors.push({
          code: "evidence-provenance-mismatch",
          attemptIndex: index,
          evidenceIndex,
        });
      }
      const inspected = await inspectRef(evidence, rootDir);
      if (inspected.error) {
        issues.push(inspected.error);
        errors.push({
          code: inspected.error,
          attemptIndex: index,
          evidenceIndex,
        });
      } else {
        report.counts.evidenceFiles += 1;
        if (evidence.visibility === "private") {
          report.counts.privateEvidenceFiles += 1;
        }
      }
    }
    prior.push({ attempt, issues });
    attemptsByCase.set(attempt.caseId, prior);
  }
  for (const expected of manifest.expectedCases) {
    const attempts = attemptsByCase.get(expected.caseId) ?? [];
    let result;
    if (attempts.length === 0) {
      result = "incomplete";
      errors.push({ code: "missing-case", caseId: expected.caseId });
    } else if (attempts.some((item) => item.issues.length > 0)) {
      result = "invalid";
    } else if (
      attempts.some(
        ({ attempt }) =>
          !TERMINAL.has(attempt.status) || attempt.outcome === "unknown",
      )
    ) {
      result = "incomplete";
    } else if (
      attempts.some(
        ({ attempt }) =>
          attempt.status !== "completed" ||
          attempt.outcome !== expected.expectedOutcome,
      )
    ) {
      const latest = attempts.at(-1).attempt;
      result =
        latest.status === "completed" &&
        latest.outcome === expected.expectedOutcome
          ? "unstable"
          : "failed";
    } else {
      result =
        expected.expectedOutcome === "rejection"
          ? "expectedRejection"
          : "passed";
    }
    report.counts[result] += 1;
    report.cases.push({
      runId: receipt.runId,
      caseId: expected.caseId,
      agentId: expected.agentId,
      standardIds: expected.standardIds,
      requirementIds: expected.requirementIds,
      level: expected.level,
      coveredConditions: expected.coveredConditions,
      result,
      acceptanceVerified: false,
      requiresIndependentReview: true,
      attemptResults: attempts.map(({ attempt, issues }) => ({
        attemptId: attempt.attemptId,
        status: attempt.status,
        outcome: attempt.outcome,
        level: attempt.level,
        issues,
      })),
    });
  }
  report.mechanicallyValid = errors.length === 0;
  report.complete = report.mechanicallyValid && report.counts.incomplete === 0;
  report.allExpectedOutcomesMatched =
    report.complete &&
    report.counts.failed === 0 &&
    report.counts.unstable === 0 &&
    report.counts.invalid === 0;
  return report;
}

/**
 * Decide reuse from explicit dependency fingerprints, current inputs, evidence
 * availability, review horizon, and known concerns. No version pinning or writes.
 */
export function planRevalidation(manifest, changeSet = {}) {
  const result = {
    acceptanceVerified: false,
    requiresIndependentReview: true,
    cases: [],
  };
  const errors = [];
  if (
    !object(manifest) ||
    !validateManifest(manifest, manifest.runId, errors) ||
    errors.length > 0 ||
    hasForbiddenMetadata(manifest)
  ) {
    return { ...result, error: "invalid-run-manifest" };
  }
  if (!object(changeSet)) return { ...result, error: "invalid-change-set" };
  const {
    currentInputs,
    changes = [],
    missingEvidence = [],
    concerns = [],
    priorResults = [],
    now = new Date().toISOString(),
  } = changeSet;
  if (
    !object(changeSet) ||
    !Array.isArray(changes) ||
    !Array.isArray(missingEvidence) ||
    !Array.isArray(concerns) ||
    !Array.isArray(priorResults) ||
    !time(now)
  ) {
    return { ...result, error: "invalid-change-set" };
  }
  const dependencyIds = new Set(manifest.dependencies.map((entry) => entry.id));
  for (const expected of manifest.expectedCases) {
    const reasons = [];
    if (!inputMap(currentInputs) || !equal(currentInputs, manifest.inputs)) {
      reasons.push("current-inputs-missing-or-changed");
    }
    if (!manifest.reviewBy) reasons.push("review-horizon-not-defined");
    else if (Date.parse(now) >= Date.parse(manifest.reviewBy)) {
      reasons.push("review-horizon-reached");
    }
    if (Date.parse(now) < Date.parse(manifest.preparedAt)) {
      reasons.push("clock-order-uncertain");
    }
    for (const change of changes) {
      if (
        !subsetKeys(change, ["dependencyId", "fingerprint"]) ||
        !identifier(change.dependencyId) ||
        !text(change.fingerprint) ||
        !dependencyIds.has(change.dependencyId)
      ) {
        reasons.push("unmapped-change");
      } else if (
        expected.dependencies.includes(change.dependencyId) &&
        manifest.dependencies.find((item) => item.id === change.dependencyId)
          ?.fingerprint !== change.fingerprint
      ) {
        reasons.push("dependency-changed");
      }
    }
    for (const missing of missingEvidence) {
      if (
        !identifier(missing?.caseId) ||
        !manifest.expectedCases.some((item) => item.caseId === missing.caseId)
      ) {
        reasons.push("unmapped-missing-evidence");
      } else if (missing.caseId === expected.caseId) {
        reasons.push("evidence-missing");
      }
    }
    for (const concern of concerns) {
      if (
        !object(concern) ||
        !identifier(concern.code) ||
        (!identifier(concern.caseId) && !identifier(concern.dependencyId)) ||
        (concern.caseId &&
          !manifest.expectedCases.some(
            (item) => item.caseId === concern.caseId,
          )) ||
        (concern.dependencyId && !dependencyIds.has(concern.dependencyId))
      ) {
        reasons.push("unmapped-concern");
      } else if (
        concern.caseId === expected.caseId ||
        expected.dependencies.includes(concern.dependencyId)
      ) {
        reasons.push("known-concern");
      }
    }
    const prior = priorResults.filter(
      (entry) => entry?.caseId === expected.caseId,
    );
    if (
      prior.length !== 1 ||
      !["passed", "expectedRejection"].includes(prior[0].result)
    ) {
      reasons.push("prior-result-missing-or-not-clean");
    }
    result.cases.push({
      caseId: expected.caseId,
      action: reasons.length ? "revalidate" : "reuse-candidate",
      reasons: [...new Set(reasons)],
    });
  }
  return result;
}

// Deliberately omit supplied context, prose, paths and evidence bodies. Invalid
// enums also remain untrusted, including when the receipt has been rejected.
export function publicReceiptSummary(report) {
  const enumValue = (value, allowed) =>
    allowed.includes(value) ? value : null;
  return {
    schemaVersion: report.schemaVersion,
    mechanicallyValid: report.mechanicallyValid,
    complete: report.complete,
    allExpectedOutcomesMatched: report.allExpectedOutcomesMatched,
    acceptanceVerified: false,
    requiresIndependentReview: true,
    counts: report.counts,
    errors: (report.errors ?? []).map((entry) => ({
      code: entry.code,
      ...(Number.isInteger(entry.caseIndex)
        ? { caseIndex: entry.caseIndex }
        : {}),
      ...(Number.isInteger(entry.attemptIndex)
        ? { attemptIndex: entry.attemptIndex }
        : {}),
      ...(Number.isInteger(entry.evidenceIndex)
        ? { evidenceIndex: entry.evidenceIndex }
        : {}),
    })),
    cases: (report.cases ?? []).map((entry, caseIndex) => ({
      caseIndex,
      level: enumValue(entry.level, EVIDENCE_LEVELS),
      result: enumValue(entry.result, [
        "passed",
        "expectedRejection",
        "failed",
        "incomplete",
        "unstable",
        "invalid",
      ]),
      attempts: entry.attemptResults.map((attempt, attemptIndex) => ({
        attemptIndex,
        status: enumValue(attempt.status, [...TERMINAL, "started"]),
        outcome: enumValue(attempt.outcome, [
          "success",
          "rejection",
          "failure",
          "unknown",
        ]),
        level: enumValue(attempt.level, EVIDENCE_LEVELS),
        issues: attempt.issues,
      })),
    })),
  };
}

async function readJsonInput(file) {
  let handle;
  try {
    if (!(await lstat(file)).isFile()) throw new Error("not-regular");
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size > 4 * 1024 * 1024) {
      throw new Error("not-bounded-json");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const pathname = await lstat(file);
    if (
      offset !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      pathname.isSymbolicLink() ||
      before.ino !== pathname.ino ||
      before.dev !== pathname.dev
    ) {
      throw new Error("changed-json");
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await handle?.close();
  }
}

async function main() {
  const [command, receiptFile, changeFile] = process.argv.slice(2);
  if (
    !["validate", "revalidate"].includes(command) ||
    !receiptFile ||
    (command === "revalidate" && !changeFile)
  ) {
    process.stderr.write(
      "Usage: node scripts/acceptance-receipts.mjs validate <receipt.json> | revalidate <receipt.json> <changes.json>\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const receipt = await readJsonInput(receiptFile);
    const report = await validateReceipt(receipt);
    if (command === "validate") {
      process.stdout.write(
        `${JSON.stringify(publicReceiptSummary(report), null, 2)}\n`,
      );
      process.exitCode = report.allExpectedOutcomesMatched ? 0 : 1;
      return;
    }
    if (!report.mechanicallyValid) {
      process.stdout.write(
        `${JSON.stringify(publicReceiptSummary(report), null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const loaded = await inspectRef(receipt.manifest, process.cwd(), true);
    const changes = await readJsonInput(changeFile);
    const planned = planRevalidation(loaded.value, {
      ...changes,
      priorResults: report.cases,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          ...planned,
          cases: planned.cases.map(({ action, reasons }, caseIndex) => ({
            caseIndex,
            action,
            reasons,
          })),
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = planned.error ? 1 : 0;
  } catch {
    process.stderr.write(
      "Receipt input could not be safely read or validated.\n",
    );
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
