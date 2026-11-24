import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "./acceptance-receipts.mjs";

const digest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const oid = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const opaqueId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(value);
const appPlatforms = ["macos-arm64", "windows-x64", "windows-arm64"];

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function date(value) {
  assert.ok(
    typeof value === "string" &&
      timestamp.test(value) &&
      Number.isFinite(Date.parse(value)),
    "The private evidence timestamp is invalid.",
  );
  return Date.parse(value);
}

export function isEvidencePlatform(platform) {
  return appPlatforms.includes(platform);
}

export function assertEvidenceScope(scope) {
  assert.ok(
    typeof scope?.macProduct === "boolean" &&
      typeof scope.windowsProduct === "boolean" &&
      scope.product === (scope.macProduct || scope.windowsProduct),
    "Platform-specific product scope is unavailable or inconsistent.",
  );
}

export function assertInstalledEvidencePlatforms(scope, receipts) {
  assertEvidenceScope(scope);
  if (scope.macProduct) {
    assert.ok(
      receipts.some(({ platform }) => platform === "macos-arm64"),
      "Applicable product changes require macOS arm64 installed evidence.",
    );
  }
  if (scope.windowsProduct) {
    assert.ok(
      receipts.some(
        ({ platform }) =>
          platform === "windows-x64" || platform === "windows-arm64",
      ),
      "Applicable product changes require native Windows installed evidence.",
    );
  }
}

export function privateAttestationBytes(claim, schemaVersion = 1) {
  return Buffer.from(
    `Farfold private delivery evidence v${schemaVersion}\n${canonicalJson(claim)}`,
    "utf8",
  );
}

function verifySignature(claim, encodedSignature, publicKey, schemaVersion) {
  assert.ok(
    typeof publicKey === "string" && publicKey.trim(),
    "No trusted private evidence signer is configured.",
  );
  assert.ok(
    publicKey.length <= 512 &&
      /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----$/.test(
        publicKey.trim(),
      ),
    "The trusted private evidence verifier must be an Ed25519 SPKI public key.",
  );
  let key;
  try {
    key = createPublicKey(publicKey);
  } catch {
    throw new Error("The trusted private evidence public key is malformed.");
  }
  assert.equal(
    key.asymmetricKeyType,
    "ed25519",
    "The trusted private evidence key must use Ed25519.",
  );
  assert.ok(
    typeof encodedSignature === "string" &&
      /^[A-Za-z0-9_-]{86}$/.test(encodedSignature),
    "The private evidence signature encoding is invalid.",
  );
  const bytes = Buffer.from(encodedSignature, "base64url");
  assert.ok(
    bytes.toString("base64url") === encodedSignature &&
      verify(null, privateAttestationBytes(claim, schemaVersion), key, bytes),
    "The private evidence signature does not match the trusted signer.",
  );
}

function sameCandidate(record, target) {
  return (
    record.base === target.base &&
    record.head === target.head &&
    record.merge === target.merge
  );
}

function assertPolicyReview(policyReview, scope) {
  assert.ok(
    typeof scope.governance === "boolean",
    "The delivery policy scope is unavailable.",
  );
  assert.ok(
    scope.governance
      ? exactKeys(policyReview, ["preservesRequirements", "assessment"]) &&
          policyReview.preservesRequirements === true &&
          typeof policyReview.assessment === "string" &&
          policyReview.assessment.trim().length >= 30 &&
          policyReview.assessment.length <= 1600
      : policyReview === null,
    "Delivery policy changes need the trusted reviewer's explicit assessment that existing requirements are preserved.",
  );
}

function validateInstalledReceipt(receipt, target, now, reviewedAt, product) {
  assert.ok(
    exactKeys(receipt, [
      "mode",
      "receiptSha256",
      "manifestSha256",
      "productCommit",
      "binarySha256",
      "platform",
      "requirementIds",
      "preparedAt",
      "finishedAt",
      "reviewBy",
      "revalidationSha256",
      "revalidatedAt",
      "buildSha256",
      "sourceTree",
    ]) &&
      digest(receipt.receiptSha256) &&
      digest(receipt.manifestSha256) &&
      digest(receipt.binarySha256) &&
      isEvidencePlatform(receipt.platform) &&
      typeof receipt.productCommit === "string" &&
      receipt.productCommit.length > 0 &&
      receipt.productCommit.length <= 128 &&
      Array.isArray(receipt.requirementIds) &&
      receipt.requirementIds.length > 0 &&
      receipt.requirementIds.length <= 50 &&
      receipt.requirementIds.every(
        (id) => typeof id === "string" && /^[A-Z][A-Z0-9-]{1,30}$/.test(id),
      ) &&
      new Set(receipt.requirementIds).size === receipt.requirementIds.length,
    "The signed installed evidence summary is incomplete.",
  );
  const createdAt = date(target.createdAt);
  const preparedAt = date(receipt.preparedAt);
  const finishedAt = date(receipt.finishedAt);
  assert.ok(
    preparedAt <= finishedAt && finishedAt <= reviewedAt && finishedAt <= now,
    "Installed evidence timing conflicts with the independent review.",
  );
  if (receipt.reviewBy !== null) {
    const reviewBy = date(receipt.reviewBy);
    assert.ok(
      reviewBy > finishedAt && now < reviewBy,
      "Installed evidence has expired (review-horizon-reached).",
    );
  }
  if (receipt.mode === "fresh") {
    assert.ok(
      preparedAt >= createdAt &&
        receipt.revalidationSha256 === null &&
        receipt.revalidatedAt === null,
      "Fresh installed evidence must be prepared within this PR's review window.",
    );
  } else {
    assert.ok(
      receipt.mode === "reuse" &&
        receipt.reviewBy !== null &&
        digest(receipt.revalidationSha256),
      "Historical installed evidence needs current signed revalidation and an unexpired review horizon.",
    );
    const revalidatedAt = date(receipt.revalidatedAt);
    assert.ok(
      revalidatedAt >= Math.max(createdAt, finishedAt) &&
        revalidatedAt <= reviewedAt,
      "Historical evidence revalidation was not captured for this PR before the approving review.",
    );
  }
  if (product || receipt.buildSha256 !== null || receipt.sourceTree !== null) {
    const sourceTree =
      receipt.productCommit === target.head
        ? target.headTree
        : receipt.productCommit === target.merge
          ? target.mergeTree
          : null;
    assert.ok(
      digest(receipt.buildSha256) &&
        oid(receipt.sourceTree) &&
        receipt.sourceTree === sourceTree &&
        receipt.sourceTree === target.mergeTree,
      "Installed evidence must identify the signed build for the exact tested candidate source tree.",
    );
  }
}

function validateEvidence(evidence, { target, scope, now, reviewedAt }) {
  assert.ok(
    exactKeys(evidence, ["base", "head", "merge", "stable", "installed"]) &&
      sameCandidate(evidence, target),
    "Signed evidence belongs to a different candidate.",
  );
  const { stable, installed } = evidence;
  assert.ok(
    exactKeys(stable, ["required", "sha256"]) &&
      stable.required === scope.macProduct &&
      (scope.macProduct ? digest(stable.sha256) : stable.sha256 === null),
    "Applicable macOS product changes require the signed seven-check report.",
  );
  assert.ok(
    exactKeys(installed, ["required", "receipts"]) &&
      installed.required === scope.product &&
      Array.isArray(installed.receipts) &&
      installed.receipts.length <= 20,
    "Installed evidence applicability differs from the assessed product scope.",
  );
  for (const receipt of installed.receipts)
    validateInstalledReceipt(receipt, target, now, reviewedAt, scope.product);
  assertInstalledEvidencePlatforms(scope, installed.receipts);
}

/** Verify the independently signed compact proof, while originals remain with the custodian. */
export function verifyDeliveryPrivateAttestation(
  envelope,
  { publicKey, target, scope, run, now, witnessId },
) {
  assertEvidenceScope(scope);
  const schemaVersion = witnessId === undefined ? 1 : 2;
  assert.ok(
    exactKeys(envelope, ["schemaVersion", "claim", "signature"]) &&
      envelope.schemaVersion === schemaVersion,
    "Expected one versioned private evidence attestation.",
  );
  const { claim, signature } = envelope;
  assert.ok(
    exactKeys(claim, [
      "repositoryId",
      "pr",
      "base",
      "head",
      "merge",
      "engineeringRunId",
      "engineeringRunAttempt",
      "executionId",
      "transcriptSha256",
      "reviewedAt",
      "originalsId",
      "decision",
      "evidence",
      "policyReview",
      ...(schemaVersion === 2 ? ["witnessId"] : []),
    ]),
    "The signed private evidence claim is incomplete.",
  );
  verifySignature(claim, signature, publicKey, schemaVersion);
  if (schemaVersion === 2) {
    assert.ok(
      Number.isSafeInteger(witnessId) &&
        witnessId > 0 &&
        claim.witnessId === witnessId,
      "Private evidence attestation belongs to a different witness comment.",
    );
  }
  assert.ok(
    Number.isSafeInteger(target.repositoryId) &&
      claim.repositoryId === target.repositoryId &&
      Number.isSafeInteger(target.number) &&
      claim.pr === target.number &&
      sameCandidate(claim, target) &&
      Number.isSafeInteger(run.id) &&
      claim.engineeringRunId === run.id &&
      Number.isSafeInteger(run.run_attempt) &&
      claim.engineeringRunAttempt === run.run_attempt,
    "Private evidence attestation belongs to a different repository, PR, candidate, or engineering attempt.",
  );
  assert.ok(
    claim.decision === "approved" &&
      opaqueId(claim.executionId) &&
      opaqueId(claim.originalsId) &&
      digest(claim.transcriptSha256),
    "A trusted approval must bind a private review execution transcript and originals locator.",
  );
  const reviewedAt = date(claim.reviewedAt);
  assert.ok(
    Number.isFinite(now) &&
      reviewedAt >= date(target.createdAt) &&
      reviewedAt <= now,
    "The trusted review was not executed within this PR's review window.",
  );
  assertPolicyReview(claim.policyReview, scope);
  validateEvidence(claim.evidence, { target, scope, now, reviewedAt });
  return {
    executionId: claim.executionId,
    reviewedAt: claim.reviewedAt,
    originalsId: claim.originalsId,
    evidence: claim.evidence,
  };
}
