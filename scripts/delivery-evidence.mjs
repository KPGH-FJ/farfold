import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { planRevalidation, validateReceipt } from "./acceptance-receipts.mjs";
import { stableChecks } from "./delivery-check.mjs";
import {
  assertEvidenceScope,
  assertInstalledEvidencePlatforms,
  isEvidencePlatform,
} from "./delivery-private-attestation.mjs";

const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const dated = (value) =>
  typeof value === "string" &&
  timestamp.test(value) &&
  Number.isFinite(Date.parse(value));
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;

function reviewedJson(file, expectedDigest, rootDir) {
  assert.ok(
    typeof file === "string" && file && digest.test(expectedDigest),
    "A reviewed JSON file and its SHA-256 digest are required.",
  );
  const bytes = readFileSync(resolve(rootDir, file));
  const actual = createHash("sha256").update(bytes).digest("hex");
  assert.equal(actual, expectedDigest, "Reviewed record bytes changed.");
  return JSON.parse(bytes);
}

function validateStableReport(stable, head, rootDir) {
  const report = reviewedJson(stable.report, stable.sha256, rootDir);
  assert.ok(
    report.mode === "stable" &&
      report.platform === "darwin-arm64" &&
      report.inputsStable === true &&
      report.head === head &&
      Array.isArray(report.results) &&
      report.results.every(({ exitCode }) => exitCode === 0),
    "Applicable stable checks must pass on the reviewed candidate.",
  );
  assert.deepEqual(
    report.results.map(({ command }) => command),
    stableChecks,
    "Stable check command list changed.",
  );
}

function verifyReuse({
  entry,
  manifest,
  receipt,
  report,
  review,
  base,
  head,
  now,
  freshSince,
  rootDir,
}) {
  const ref = entry.revalidation;
  assert.ok(ref, "Historical evidence needs a current revalidation capture.");
  const capture = reviewedJson(ref.path, ref.sha256, rootDir);
  assert.ok(
    capture?.base === base &&
      capture?.head === head &&
      capture?.receiptSha256 === entry.sha256,
    "Revalidation capture identity differs from this candidate or receipt.",
  );
  assert.ok(
    dated(capture.capturedAt) &&
      Date.parse(capture.capturedAt) >= Date.parse(receipt.finishedAt) &&
      Date.parse(capture.capturedAt) <= Date.parse(now),
    "Current inputs were not captured between receipt completion and delivery.",
  );
  assert.ok(
    dated(freshSince) &&
      Date.parse(capture.capturedAt) >= Date.parse(freshSince),
    "Current inputs must be captured within the current pull request window.",
  );
  assert.ok(
    Array.isArray(capture.currentDependencies) &&
      Array.isArray(capture.missingEvidence) &&
      Array.isArray(capture.concerns),
    "Historical evidence needs explicit dependencies, evidence availability, and known concerns.",
  );
  const dependencyIds = capture.currentDependencies.map(
    (item) => item?.dependencyId,
  );
  assert.equal(
    new Set(dependencyIds).size,
    dependencyIds.length,
    "The current capture has duplicate dependencies.",
  );
  const required = new Set(
    manifest.expectedCases.flatMap(({ dependencies }) => dependencies),
  );
  assert.ok(
    [...required].every((id) => dependencyIds.includes(id)),
    "The current capture is missing applicable dependency fingerprints.",
  );
  const revalidation = planRevalidation(manifest, {
    currentInputs: capture.currentInputs,
    changes: capture.currentDependencies,
    missingEvidence: capture.missingEvidence,
    concerns: capture.concerns,
    priorResults: report.cases,
    now,
  });
  if (revalidation.error)
    throw new Error(`Evidence revalidation failed: ${revalidation.error}.`);
  const reasons = [
    ...new Set(
      revalidation.cases
        .filter(({ action }) => action !== "reuse-candidate")
        .flatMap(({ reasons }) => reasons),
    ),
  ];
  assert.ok(
    revalidation.cases.length > 0 &&
      revalidation.cases.every(({ action }) => action === "reuse-candidate"),
    `Historical evidence must be revalidated: ${reasons.join(", ")}.`,
  );
  const bindings = review.revalidations;
  assert.ok(
    Array.isArray(bindings) &&
      bindings.filter(
        (binding) =>
          binding?.receiptSha256 === entry.sha256 &&
          binding?.revalidationSha256 === ref.sha256,
      ).length === 1,
    "Independent review of this candidate must bind the receipt and current revalidation digests.",
  );
  return { revalidationSha256: ref.sha256, revalidatedAt: capture.capturedAt };
}

function verifyInstalledBuild(
  entry,
  { manifest, installedRequired, merge, sourceTrees, rootDir },
) {
  if (!entry.build && !installedRequired)
    return { buildSha256: null, sourceTree: null };
  assert.ok(
    entry.build,
    "Applicable installation evidence needs a digest-bound build record from the candidate checkout.",
  );
  const build = reviewedJson(entry.build.path, entry.build.sha256, rootDir);
  assert.ok(
    build?.schemaVersion === 1 &&
      sha.test(build.sourceCommit) &&
      sha.test(build.sourceTree) &&
      build.sourceCommit === entry.productCommit &&
      build.binarySha256 === entry.binarySha256 &&
      build.platform === manifest.context.platform &&
      dated(build.builtAt) &&
      Date.parse(build.builtAt) <= Date.parse(manifest.preparedAt),
    "The build record must match the sealed installation and predate test preparation.",
  );
  assert.equal(
    build.sourceTree,
    sourceTrees?.[entry.productCommit],
    "Installed build source tree differs from the GitHub candidate.",
  );
  assert.equal(
    build.sourceTree,
    sourceTrees?.[merge],
    "Installed build source tree differs from the tested merge preview.",
  );
  return { buildSha256: entry.build.sha256, sourceTree: build.sourceTree };
}

async function verifyInstalledReceipt(
  entry,
  {
    base,
    head,
    merge,
    installedRequired,
    sourceTrees,
    review,
    now,
    freshSince,
    rootDir,
  },
) {
  const receipt = reviewedJson(entry?.path, entry?.sha256, rootDir);
  const report = await validateReceipt(receipt, {
    rootDir,
    retainManifest: true,
  });
  const { manifest } = report;
  const errors = [...new Set(report.errors.map(({ code }) => code))];
  assert.ok(
    report.allExpectedOutcomesMatched &&
      report.cases.every(({ level }) =>
        ["installed", "real-agent"].includes(level),
      ),
    `Installed verification requires matching installed observations${errors.length ? `: ${errors.join(", ")}` : ""}.`,
  );
  assert.ok(
    Date.parse(receipt.finishedAt) <= Date.parse(now),
    "Installed receipt finishes after the delivery time.",
  );
  assert.ok(
    !manifest.reviewBy || Date.parse(now) < Date.parse(manifest.reviewBy),
    "Installed receipt has expired: review-horizon-reached.",
  );
  assert.ok(
    Array.isArray(entry.requirementIds) &&
      entry.requirementIds.length > 0 &&
      entry.requirementIds.every((requirement) =>
        report.cases.some(({ requirementIds }) =>
          requirementIds.includes(requirement),
        ),
      ),
    "Installed receipt requirements differ from the reviewed scope.",
  );
  assert.ok(
    manifest.context.productCommit === entry.productCommit &&
      manifest.context.app.binarySha256 === entry.binarySha256,
    "Installed receipt identity differs from the reviewed build.",
  );
  assert.ok(
    isEvidencePlatform(manifest.context.platform),
    "Installed evidence must identify the actual macOS arm64 or native Windows platform.",
  );
  if (installedRequired) {
    assert.ok(
      [head, merge].includes(entry.productCommit),
      "Applicable installation evidence must identify a build of this candidate.",
    );
  }
  assert.ok(
    ["fresh", "reuse"].includes(entry.mode),
    "Specify fresh or reuse as the installed receipt mode.",
  );
  assert.ok(
    entry.mode === "reuse" || !Object.hasOwn(entry, "revalidation"),
    "Newly executed evidence cannot carry a historical revalidation capture.",
  );
  if (entry.mode === "fresh") {
    assert.ok(
      dated(freshSince) &&
        Date.parse(manifest.preparedAt) >= Date.parse(freshSince),
      "Newly executed evidence must be prepared within the current pull request window; older evidence requires reuse and revalidation.",
    );
  }
  const revalidation =
    entry.mode === "reuse"
      ? verifyReuse({
          entry,
          manifest,
          receipt,
          report,
          review,
          base,
          head,
          now,
          freshSince,
          rootDir,
        })
      : { revalidationSha256: null, revalidatedAt: null };
  const build = verifyInstalledBuild(entry, {
    manifest,
    installedRequired,
    merge,
    sourceTrees,
    rootDir,
  });
  return {
    mode: entry.mode,
    receiptSha256: entry.sha256,
    manifestSha256: receipt.manifest.sha256,
    productCommit: entry.productCommit,
    binarySha256: entry.binarySha256,
    platform: manifest.context.platform,
    requirementIds: entry.requirementIds,
    preparedAt: manifest.preparedAt,
    finishedAt: receipt.finishedAt,
    reviewBy: manifest.reviewBy ?? null,
    ...revalidation,
    ...build,
  };
}

/** Verify from private originals, then return only fields suitable for a delivery attestation. */
export async function validateLocalDeliveryRecord(
  record,
  {
    base,
    head,
    merge,
    scope,
    sourceTrees,
    freshSince,
    now = new Date().toISOString(),
    rootDir = process.cwd(),
  },
) {
  assert.ok(
    sha.test(base) && sha.test(head) && sha.test(merge) && dated(now),
    "Full candidate identifiers and a valid delivery time are required.",
  );
  assert.ok(
    record?.base === base && record?.head === head,
    "The delivery record does not match this base and candidate.",
  );
  const { review, stable, installed } = record;
  assertEvidenceScope(scope);
  assert.ok(
    review?.verdict === "approved" &&
      review.base === base &&
      review.head === head &&
      typeof review.reviewer === "string" &&
      review.reviewer.trim() &&
      typeof review.summary === "string" &&
      review.summary.trim(),
    "An independent review of this exact base and head must be recorded.",
  );
  for (const [name, claim, required] of [
    ["stable", stable, scope.macProduct],
    ["installed", installed, scope.product],
  ]) {
    assert.ok(
      claim?.required === required,
      `The ${name} applicability claim differs from the assessed candidate scope.`,
    );
    assert.ok(
      typeof claim?.reason === "string" && claim.reason.trim(),
      `Record why ${name} verification applies or does not apply.`,
    );
  }
  if (scope.macProduct) validateStableReport(stable, head, rootDir);
  assert.ok(
    Array.isArray(installed.receipts) && installed.receipts.length <= 20,
    "Record a finite list of installed verification receipt paths.",
  );
  const receipts = [];
  for (const entry of installed.receipts) {
    receipts.push(
      await verifyInstalledReceipt(entry, {
        base,
        head,
        merge,
        installedRequired: scope.product,
        sourceTrees,
        review,
        now,
        freshSince,
        rootDir,
      }),
    );
  }
  assertInstalledEvidencePlatforms(scope, receipts);
  return {
    base,
    head,
    merge,
    stable: {
      required: scope.macProduct,
      sha256: scope.macProduct ? stable.sha256 : null,
    },
    installed: { required: scope.product, receipts },
  };
}
