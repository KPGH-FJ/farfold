import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  privateAttestationBytes,
  verifyDeliveryPrivateAttestation,
} from "./delivery-private-attestation.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const verifier = publicKey.export({ type: "spki", format: "pem" });
const base = "a".repeat(40);
const head = "b".repeat(40);
const merge = "c".repeat(40);
const tree = "1".repeat(40);
const createdAt = "2026-11-24T08:00:00Z";
const reviewedAt = "2026-11-24T11:00:00Z";

function signed(claim, key = privateKey) {
  return {
    schemaVersion: 1,
    claim,
    signature: sign(null, privateAttestationBytes(claim), key).toString(
      "base64url",
    ),
  };
}

function installed(platform = "macos-arm64") {
  return {
    mode: "fresh",
    receiptSha256: (platform === "macos-arm64" ? "a" : "1").repeat(64),
    manifestSha256: "2".repeat(64),
    productCommit: merge,
    binarySha256: "3".repeat(64),
    platform,
    requirementIds: ["P01"],
    preparedAt: "2026-11-24T09:00:00Z",
    finishedAt: "2026-11-24T10:00:00Z",
    reviewBy: null,
    revalidationSha256: null,
    revalidatedAt: null,
    buildSha256: "4".repeat(64),
    sourceTree: tree,
  };
}

function fixture({
  macProduct = true,
  windowsProduct = false,
  governance = false,
} = {}) {
  const product = macProduct || windowsProduct;
  const scope = { product, macProduct, windowsProduct, governance };
  const target = {
    repositoryId: 1348426218,
    number: 5,
    base,
    head,
    merge,
    headTree: tree,
    mergeTree: tree,
    createdAt,
  };
  const run = { id: 44, run_attempt: 2 };
  const evidence = {
    base,
    head,
    merge,
    stable: {
      required: macProduct,
      sha256: macProduct ? "5".repeat(64) : null,
    },
    installed: { required: product, receipts: [] },
  };
  if (macProduct) evidence.installed.receipts.push(installed());
  if (windowsProduct)
    evidence.installed.receipts.push(installed("windows-x64"));
  const claim = {
    repositoryId: target.repositoryId,
    pr: target.number,
    base,
    head,
    merge,
    engineeringRunId: run.id,
    engineeringRunAttempt: run.run_attempt,
    executionId: "review_run_a01",
    transcriptSha256: "6".repeat(64),
    reviewedAt,
    originalsId: "restricted_01",
    decision: "approved",
    evidence,
    policyReview: governance
      ? {
          preservesRequirements: true,
          assessment:
            "Existing requirements and failure paths remain verified in the review.",
        }
      : null,
  };
  const options = {
    publicKey: verifier,
    target,
    scope,
    run,
    now: Date.parse("2026-11-24T12:00:00Z"),
  };
  return {
    claim,
    options,
    verify: () => verifyDeliveryPrivateAttestation(signed(claim), options),
  };
}

describe("detached private evidence attestation", () => {
  it("accepts separately signed current evidence from both required platforms", () => {
    const f = fixture({ windowsProduct: true, governance: true });
    expect(f.verify()).toEqual({
      executionId: f.claim.executionId,
      reviewedAt,
      originalsId: f.claim.originalsId,
      evidence: f.claim.evidence,
    });
  });

  it("allows a signed native Windows case without the macOS stable-batch report", () => {
    const f = fixture({ macProduct: false, windowsProduct: true });
    expect(f.verify().evidence.stable).toEqual({
      required: false,
      sha256: null,
    });
    expect(f.verify().evidence.installed.receipts).toHaveLength(1);
    expect(f.verify().evidence.installed.receipts[0].platform).toBe(
      "windows-x64",
    );
  });

  it("allows a governance-only attestation with a meaningful policy review and no product receipts", () => {
    const f = fixture({ macProduct: false, governance: true });
    expect(f.verify().evidence.installed).toEqual({
      required: false,
      receipts: [],
    });
  });

  it("fails closed when the protected signer key is unavailable", () => {
    const f = fixture();
    f.options.publicKey = "";
    expect(f.verify).toThrow("No trusted private evidence signer");
  });

  it("rejects a signature from a different Ed25519 key", () => {
    const f = fixture();
    const other = generateKeyPairSync("ed25519");
    expect(() =>
      verifyDeliveryPrivateAttestation(
        signed(f.claim, other.privateKey),
        f.options,
      ),
    ).toThrow("does not match the trusted signer");
  });

  it("rejects changes to evidence or reviewer metadata after signing", () => {
    const f = fixture();
    const envelope = signed(f.claim);
    envelope.claim.evidence.installed.receipts[0].binarySha256 = "f".repeat(64);
    expect(() => verifyDeliveryPrivateAttestation(envelope, f.options)).toThrow(
      "does not match the trusted signer",
    );
  });

  it.each([
    ["repositoryId", 17722012],
    ["pr", 8],
    ["base", "f".repeat(40)],
    ["head", "f".repeat(40)],
    ["merge", "f".repeat(40)],
    ["engineeringRunId", 56],
    ["engineeringRunAttempt", 1],
  ])("rejects a valid signature for a different %s", (field, wrongValue) => {
    const f = fixture();
    f.claim[field] = wrongValue;
    expect(f.verify).toThrow(
      "different repository, PR, candidate, or engineering attempt",
    );
  });

  it("refuses an explicitly expired receipt on the same candidate", () => {
    const f = fixture();
    f.claim.evidence.installed.receipts[0].reviewBy = "2026-11-24T12:00:00Z";
    expect(f.verify).toThrow("review-horizon-reached");
  });

  it("requires a current revalidation digest and capture time for historical evidence", () => {
    const f = fixture();
    const receipt = f.claim.evidence.installed.receipts[0];
    receipt.mode = "reuse";
    receipt.preparedAt = "2026-11-23T06:30:00Z";
    receipt.finishedAt = "2026-11-23T07:00:00Z";
    receipt.reviewBy = "2026-11-25T00:00:00Z";
    expect(f.verify).toThrow("current signed revalidation");
    receipt.revalidationSha256 = "b".repeat(64);
    receipt.revalidatedAt = "2026-11-23T07:45:00Z";
    expect(f.verify).toThrow("not captured for this PR");
    receipt.revalidatedAt = "2026-11-24T10:45:00Z";
    expect(f.verify().evidence.installed.receipts[0].mode).toBe("reuse");
  });

  it("does not accept Mac observability as Windows coverage even with a valid signature", () => {
    const f = fixture({ windowsProduct: true });
    f.claim.evidence.installed.receipts = [installed()];
    expect(f.verify).toThrow("native Windows installed evidence");
  });

  it("does not allow author-like scope exemptions or attestations without a source-bound build", () => {
    const f = fixture();
    f.claim.evidence.stable.required = false;
    expect(f.verify).toThrow("seven-check report");
    f.claim.evidence.stable.required = true;
    f.claim.evidence.installed.required = false;
    expect(f.verify).toThrow("applicability differs");
    f.claim.evidence.installed.required = true;
    f.claim.evidence.installed.receipts[0].sourceTree = "f".repeat(40);
    expect(f.verify).toThrow("exact tested candidate source tree");
  });

  it("requires the signer to attest preservation of the existing policy", () => {
    const f = fixture({ governance: true });
    f.claim.policyReview.preservesRequirements = false;
    expect(f.verify).toThrow("explicit assessment");
  });

  it("rejects extra fields that could disclose raw private evidence or file paths", () => {
    const f = fixture();
    f.claim.evidence.installed.receipts[0].rawPath =
      "/private/sample/for-test-only";
    expect(f.verify).toThrow("summary is incomplete");
  });
});
