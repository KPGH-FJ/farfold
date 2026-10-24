import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  canonicalJson,
  planRevalidation,
  publicReceiptSummary,
  validateReceipt,
} from "./acceptance-receipts.mjs";

const exec = promisify(execFile);
const roots = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clone = (value) => structuredClone(value);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function fixture(level = "shared") {
  const root = await mkdtemp(path.join(os.tmpdir(), "farfold-receipts-"));
  roots.push(root);
  await mkdir(path.join(root, "output/run"), { recursive: true });
  const context = {
    agentId: "sample-agent",
    platform: "darwin-arm64",
    productCommit: "1234abcd",
    ...(level === "installed" || level === "real-agent"
      ? {
          app: {
            bundleId: "ai.farfold.desktop",
            version: "0.1.7",
            binarySha256: "a".repeat(64),
            installedPath: "/Applications/Farfold.app",
          },
          observedAgentVersion: "observed-1.2.3",
          selection: {
            serviceId: "selected-service-reference",
            modelId: "selected-model",
            reasoningId: "selected-reasoning",
          },
        }
      : {}),
  };
  const inputs = { product: "1234abcd", fixture: "stable-input-digest" };
  const installed = level === "installed" || level === "real-agent";
  const source = installed ? "installed-ui" : "test-runner";
  const required = [
    {
      observationId: "file-content",
      kind: "content-confirmed",
      source,
      expectedValue: "expected-content-digest",
    },
  ];
  if (level === "real-agent") {
    required.push({
      observationId: "official-permission",
      kind: "permission-readback",
      source: "official-interface",
      expectedValue: "restricted-confirmed",
    });
  }
  const manifest = {
    schemaVersion: 1,
    runId: "run-01",
    preparedAt: "2026-10-24T00:00:00Z",
    reviewBy: "2026-10-25T00:00:00Z",
    context,
    inputs,
    dependencies: [
      { id: "source:diff", kind: "source", fingerprint: "source-revision" },
      {
        id: "official:permission",
        kind: "official-contract",
        fingerprint: "observed-contract-v1",
      },
    ],
    expectedCases: [
      {
        caseId: "P18-file-content",
        agentId: context.agentId,
        standardIds: ["S5"],
        requirementIds: ["P18"],
        level,
        expectedOutcome: "success",
        safety: "observation",
        coveredConditions: [
          {
            conditionId: "requirement:P18",
            condition: "A complete requirement; selected observed branch.",
            excerpt: "selected observed branch",
          },
        ],
        requiredObservations: required,
        dependencies: ["source:diff", "official:permission"],
      },
    ],
  };
  const evidence = [];
  for (const [index, observation] of required.entries()) {
    const bytes = Buffer.from(`Observed evidence ${index}; no session body.\n`);
    const relative = `output/run/evidence-${index}.txt`;
    await writeFile(path.join(root, relative), bytes);
    evidence.push({
      path: relative,
      sha256: digest(bytes),
      visibility: "private",
      level,
      source: observation.source,
    });
  }
  const receipt = {
    schemaVersion: 1,
    runId: manifest.runId,
    manifest: {},
    attempts: [
      {
        attemptId: "attempt-01",
        caseId: manifest.expectedCases[0].caseId,
        startedAt: "2026-10-24T00:01:00Z",
        finishedAt: "2026-10-24T00:02:00Z",
        status: "completed",
        outcome: "success",
        level,
        context: clone(context),
        inputsBefore: clone(inputs),
        inputsAfter: clone(inputs),
        observations: required.map((item, index) => ({
          observationId: item.observationId,
          kind: item.kind,
          source: item.source,
          value: item.expectedValue,
          evidenceIndexes: [index],
        })),
        evidence,
      },
    ],
    inputsAfter: clone(inputs),
    finishedAt: "2026-10-24T00:03:00Z",
  };
  async function saveManifest() {
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(root, "output/run/manifest.json"), bytes);
    receipt.manifest = {
      path: "output/run/manifest.json",
      sha256: digest(bytes),
      visibility: "public",
      privacyReviewed: true,
    };
  }
  await saveManifest();
  return { root, receipt, manifest, saveManifest };
}

const codes = (report) => report.errors.map((entry) => entry.code);

describe("acceptance receipt integrity", () => {
  it("matches the fixed manifest, checks actual evidence bytes, and retains review boundaries", async () => {
    const f = await fixture("real-agent");
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(report.mechanicallyValid).toBe(true);
    expect(report.allExpectedOutcomesMatched).toBe(true);
    expect(report.counts).toMatchObject({
      expectedCases: 1,
      attempts: 1,
      passed: 1,
      expectedRejection: 0,
      privateEvidenceFiles: 2,
    });
    expect(report.cases[0].level).toBe("real-agent");
    expect(report.acceptanceVerified).toBe(false);
    expect(report.requiresIndependentReview).toBe(true);
  });

  it("keeps an expected rejection separate from ordinary successes", async () => {
    const f = await fixture();
    f.manifest.expectedCases[0].expectedOutcome = "rejection";
    await f.saveManifest();
    f.receipt.attempts[0].outcome = "rejection";
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(report.allExpectedOutcomesMatched).toBe(true);
    expect(report.counts.passed).toBe(0);
    expect(report.counts.expectedRejection).toBe(1);
  });

  it("does not accept CI counts or unrelated test names in place of the expected case", async () => {
    const f = await fixture();
    f.receipt.attempts[0].caseId = "unrelated-ci-test";
    const evidence = f.receipt.attempts[0].evidence[0];
    const bytes = Buffer.from('{"passed":99999,"exitCode":0}');
    await writeFile(path.join(f.root, evidence.path), bytes);
    evidence.sha256 = digest(bytes);
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("unexpected-case");
    expect(codes(report)).toContain("missing-case");
    expect(report.allExpectedOutcomesMatched).toBe(false);
    expect(report.counts.passed).toBe(0);
  });

  it("rejects omitted, extra and duplicate actual cases instead of trusting an outer success", async () => {
    const f = await fixture();
    f.receipt.attempts = [];
    expect(
      codes(await validateReceipt(f.receipt, { rootDir: f.root })),
    ).toContain("missing-case");
    const fresh = await fixture();
    fresh.receipt.attempts.push(clone(fresh.receipt.attempts[0]));
    const report = await validateReceipt(fresh.receipt, {
      rootDir: fresh.root,
    });
    expect(codes(report)).toContain("duplicate-attempt-id");
    expect(codes(report)).toContain("retry-chain-not-preserved");
    expect(report.allExpectedOutcomesMatched).toBe(false);
  });

  it.each([
    ["started", "unknown", undefined],
    ["timed-out", "unknown", "2026-10-24T00:02:00Z"],
    ["completed", "success", undefined],
    ["started", "success", undefined],
  ])(
    "does not promote %s/%s or a missing terminal receipt",
    async (status, outcome, finishedAt) => {
      const f = await fixture();
      Object.assign(f.receipt.attempts[0], { status, outcome });
      if (finishedAt) f.receipt.attempts[0].finishedAt = finishedAt;
      else delete f.receipt.attempts[0].finishedAt;
      const report = await validateReceipt(f.receipt, { rootDir: f.root });
      expect(report.allExpectedOutcomesMatched).toBe(false);
      expect(report.counts.passed).toBe(0);
    },
  );

  it("fails genuine unexpected outcomes while preserving a mechanically complete failure", async () => {
    const f = await fixture();
    f.receipt.attempts[0].outcome = "failure";
    f.receipt.attempts[0].observations = [];
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(report.mechanicallyValid).toBe(true);
    expect(report.complete).toBe(true);
    expect(report.counts.failed).toBe(1);
    expect(report.allExpectedOutcomesMatched).toBe(false);
  });

  it("checks initial, final and per-attempt input stability independently", async () => {
    const f = await fixture();
    f.receipt.attempts[0].inputsBefore.fixture = "changed-before";
    f.receipt.attempts[0].inputsAfter.fixture = "changed-after";
    delete f.receipt.inputsAfter;
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("attempt-inputs-not-stable");
    expect(codes(report)).toContain("final-inputs-missing-or-changed");
    expect(report.allExpectedOutcomesMatched).toBe(false);
  });

  it("requires the prepared manifest before execution and verifies its digest", async () => {
    const f = await fixture();
    f.manifest.preparedAt = "2026-10-24T00:01:30Z";
    await f.saveManifest();
    let report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("invalid-attempt-time-order");
    await writeFile(path.join(f.root, f.receipt.manifest.path), "{}");
    report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("evidence-digest-mismatch");
  });

  it("recognizes only the sixteen contract package identifiers", async () => {
    const f = await fixture();
    const condition = f.manifest.expectedCases[0].coveredConditions[0];
    for (const packageId of ["X", "Z"]) {
      condition.conditionId = `package:${packageId}`;
      await f.saveManifest();
      expect(
        (await validateReceipt(f.receipt, { rootDir: f.root }))
          .mechanicallyValid,
      ).toBe(true);
    }
    for (const packageId of ["O", "P"]) {
      condition.conditionId = `package:${packageId}`;
      await f.saveManifest();
      expect(
        codes(await validateReceipt(f.receipt, { rootDir: f.root })),
      ).toContain("invalid-condition-coverage");
    }
  });

  it("does not upgrade shared/protocol sources into formal application or real-Agent evidence", async () => {
    const f = await fixture("real-agent");
    f.receipt.attempts[0].level = "protocol";
    f.receipt.attempts[0].evidence[0].level = "shared";
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("evidence-level-mismatch");
    expect(codes(report)).toContain("evidence-provenance-mismatch");
    expect(report.counts.passed).toBe(0);
  });

  it.each(["source", "value"])(
    "rejects an incorrect permission %s readback",
    async (field) => {
      const f = await fixture("real-agent");
      const permission = f.receipt.attempts[0].observations[1];
      permission[field] = field === "source" ? "controlled-peer" : "unknown";
      const report = await validateReceipt(f.receipt, { rootDir: f.root });
      expect(codes(report)).toContain("required-observation-not-confirmed");
      expect(report.allExpectedOutcomesMatched).toBe(false);
    },
  );

  it("requires the same actual identity, application, platform and selected configuration", async () => {
    for (const changed of [
      (context) => {
        context.agentId = "another-agent";
      },
      (context) => {
        context.platform = "windows-x64";
      },
      (context) => {
        context.app.binarySha256 = "b".repeat(64);
      },
      (context) => {
        context.observedAgentVersion = "different-observed-version";
      },
      (context) => {
        context.selection.modelId = "different-model";
      },
      (context) => {
        context.selection.reasoningId = "different-reasoning";
      },
    ]) {
      const f = await fixture("real-agent");
      changed(f.receipt.attempts[0].context);
      const report = await validateReceipt(f.receipt, { rootDir: f.root });
      expect(codes(report)).toContain("attempt-context-mismatch");
      expect(report.counts.passed).toBe(0);
    }
  });

  it("requires formal application identity and observed program version at installed levels", async () => {
    const f = await fixture("installed");
    delete f.manifest.context.app;
    await f.saveManifest();
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("invalid-run-context");
  });

  it("retains every failed attempt when observation retry later succeeds", async () => {
    const f = await fixture();
    const second = clone(f.receipt.attempts[0]);
    f.receipt.attempts[0].status = "failed";
    f.receipt.attempts[0].outcome = "failure";
    second.attemptId = "attempt-02";
    second.retryOf = "attempt-01";
    second.startedAt = "2026-10-24T00:02:01Z";
    second.finishedAt = "2026-10-24T00:02:30Z";
    f.receipt.attempts.push(second);
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(report.mechanicallyValid).toBe(true);
    expect(report.counts.attempts).toBe(2);
    expect(report.cases[0].attemptResults).toHaveLength(2);
    expect(report.cases[0].result).toBe("unstable");
    expect(report.allExpectedOutcomesMatched).toBe(false);
  });

  it("forbids retrying side effects with an unknown prior result", async () => {
    const f = await fixture();
    f.manifest.expectedCases[0].safety = "side-effect";
    await f.saveManifest();
    const second = clone(f.receipt.attempts[0]);
    f.receipt.attempts[0].status = "timed-out";
    f.receipt.attempts[0].outcome = "unknown";
    second.attemptId = "attempt-02";
    second.retryOf = "attempt-01";
    second.startedAt = "2026-10-24T00:02:01Z";
    second.finishedAt = "2026-10-24T00:02:30Z";
    f.receipt.attempts.push(second);
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("unsafe-retry-after-unknown-result");
    expect(report.allExpectedOutcomesMatched).toBe(false);
  });

  it.each([
    "/etc/passwd",
    "output/../../outside.json",
    "output/./run/evidence.txt",
    "output\\run\\evidence.txt",
    "src/private.json",
    "output/run/.git/config",
  ])("rejects unsafe evidence reference %s", async (unsafePath) => {
    const f = await fixture();
    f.receipt.attempts[0].evidence[0].path = unsafePath;
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("unsafe-evidence-reference");
  });

  it("rejects direct and intermediate symlinks even if the digest matches", async () => {
    const f = await fixture();
    const evidence = f.receipt.attempts[0].evidence[0];
    await symlink(
      path.join(f.root, evidence.path),
      path.join(f.root, "output/run/link.txt"),
    );
    evidence.path = "output/run/link.txt";
    let report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("symlink-evidence-reference");
    const external = await mkdtemp(path.join(os.tmpdir(), "farfold-external-"));
    roots.push(external);
    await writeFile(path.join(external, "private.txt"), "private");
    await symlink(external, path.join(f.root, "output/linked"));
    evidence.path = "output/linked/private.txt";
    report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("symlink-evidence-reference");
  });

  it("detects changed evidence and requires a privacy review for public references", async () => {
    const f = await fixture();
    const evidence = f.receipt.attempts[0].evidence[0];
    await writeFile(path.join(f.root, evidence.path), "changed");
    let report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("evidence-digest-mismatch");
    evidence.visibility = "public";
    report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("unsafe-evidence-reference");
  });

  it("rejects secrets/raw outputs and Agent binary hashes as metadata", async () => {
    const f = await fixture();
    f.receipt.attempts[0].context.apiKey = "private-value";
    let report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("invalid-receipt");
    delete f.receipt.attempts[0].context.apiKey;
    f.manifest.dependencies.push({
      id: "program",
      kind: "agent-version",
      fingerprint: "c".repeat(64),
    });
    await f.saveManifest();
    report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("invalid-dependency");
  });

  it("omits private context, identifiers, paths and arbitrary prose from public summaries and CLI output", async () => {
    const f = await fixture("real-agent");
    f.manifest.context.selection.serviceId = "PRIVATE-SERVICE-IDENTIFIER";
    f.manifest.expectedCases[0].coveredConditions[0].condition +=
      " PRIVATE-CONTEXT";
    await f.saveManifest();
    f.receipt.attempts[0].context = clone(f.manifest.context);
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(report.mechanicallyValid).toBe(true);
    const summary = JSON.stringify(publicReceiptSummary(report));
    for (const privateText of [
      "PRIVATE",
      "/Applications",
      "output/",
      "sample-agent",
      "P18-file-content",
    ]) {
      expect(summary).not.toContain(privateText);
    }
    await writeFile(
      path.join(f.root, "receipt.json"),
      JSON.stringify(f.receipt),
    );
    const cli = await exec(
      process.execPath,
      [
        path.resolve("scripts/acceptance-receipts.mjs"),
        "validate",
        "receipt.json",
      ],
      { cwd: f.root },
    );
    expect(cli.stdout).not.toContain("PRIVATE");
    expect(JSON.parse(cli.stdout).acceptanceVerified).toBe(false);
  });

  it("does not expose invalid attempt enum values through rejection summaries", async () => {
    const f = await fixture();
    Object.assign(f.receipt.attempts[0], {
      status: "PRIVATE_TEST_STATUS",
      outcome: "PRIVATE_TEST_OUTCOME",
      level: "PRIVATE_TEST_LEVEL",
    });
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(report.mechanicallyValid).toBe(false);
    expect(JSON.stringify(publicReceiptSummary(report))).not.toContain(
      "PRIVATE_TEST",
    );
  });

  it("rejects a FIFO evidence path without blocking on open", async () => {
    const f = await fixture();
    const fifo = "output/run/pipe";
    await exec("mkfifo", [path.join(f.root, fifo)]);
    f.receipt.attempts[0].evidence[0].path = fifo;
    await writeFile(
      path.join(f.root, "receipt.json"),
      JSON.stringify(f.receipt),
    );
    let cli;
    try {
      cli = await exec(
        process.execPath,
        [
          path.resolve("scripts/acceptance-receipts.mjs"),
          "validate",
          "receipt.json",
        ],
        { cwd: f.root, timeout: 1000 },
      );
    } catch (error) {
      cli = error;
    }
    expect(cli.killed).not.toBe(true);
    expect(JSON.parse(cli.stdout).errors).toContainEqual({
      code: "not-regular-evidence-file",
      attemptIndex: 0,
      evidenceIndex: 0,
    });
  });

  it("bounds explicit CLI JSON inputs and refuses FIFO input without waiting for a writer", async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.root, "oversize.json"),
      `${" ".repeat(4 * 1024 * 1024)}${JSON.stringify(f.receipt)}`,
    );
    await exec("mkfifo", [path.join(f.root, "fifo.json")]);
    for (const file of ["oversize.json", "fifo.json"]) {
      let cli;
      try {
        cli = await exec(
          process.execPath,
          [path.resolve("scripts/acceptance-receipts.mjs"), "validate", file],
          { cwd: f.root, timeout: 1000 },
        );
      } catch (error) {
        cli = error;
      }
      expect(cli.killed).not.toBe(true);
      expect(cli.code).toBe(2);
      expect(cli.stderr).toBe(
        "Receipt input could not be safely read or validated.\n",
      );
    }
  });
});

describe("incremental revalidation", () => {
  async function setup() {
    const f = await fixture();
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    return {
      ...f,
      changes: {
        currentInputs: clone(f.manifest.inputs),
        priorResults: report.cases,
        now: "2026-10-24T12:00:00Z",
      },
    };
  }

  it("offers only a reviewable reuse candidate for unchanged, bounded and complete evidence", async () => {
    const f = await setup();
    const result = planRevalidation(f.manifest, f.changes);
    expect(result.cases[0]).toMatchObject({
      action: "reuse-candidate",
      reasons: [],
    });
    expect(result.acceptanceVerified).toBe(false);
  });

  it("rejects null change input without throwing before validation", async () => {
    const f = await setup();
    expect(planRevalidation(f.manifest, null)).toMatchObject({
      error: "invalid-change-set",
    });
  });

  it.each([
    [
      {
        changes: [{ dependencyId: "source:diff", fingerprint: "new-revision" }],
      },
      "dependency-changed",
    ],
    [
      {
        changes: [
          { dependencyId: "new-unknown-dependency", fingerprint: "changed" },
        ],
      },
      "unmapped-change",
    ],
    [{ currentInputs: undefined }, "current-inputs-missing-or-changed"],
    [{ missingEvidence: [{ caseId: "P18-file-content" }] }, "evidence-missing"],
    [
      {
        concerns: [
          { dependencyId: "official:permission", code: "new-permission-doubt" },
        ],
      },
      "known-concern",
    ],
    [
      { concerns: [{ caseId: "unmapped-case", code: "unknown" }] },
      "unmapped-concern",
    ],
    [{ now: "2026-10-26T00:00:00Z" }, "review-horizon-reached"],
    [
      { priorResults: [{ caseId: "P18-file-content", result: "unstable" }] },
      "prior-result-missing-or-not-clean",
    ],
  ])(
    "invalidates for a material change or uncertainty %#",
    async (changed, reason) => {
      const f = await setup();
      const result = planRevalidation(f.manifest, { ...f.changes, ...changed });
      expect(result.cases[0].action).toBe("revalidate");
      expect(result.cases[0].reasons).toContain(reason);
    },
  );

  it("does not reuse forever just because the observed version did not change", async () => {
    const f = await setup();
    delete f.manifest.reviewBy;
    const result = planRevalidation(f.manifest, f.changes);
    expect(result.cases[0].reasons).toContain("review-horizon-not-defined");
  });

  it("keeps unaffected cases eligible while invalidating the explicit dependency closure", async () => {
    const f = await setup();
    const other = clone(f.manifest.expectedCases[0]);
    other.caseId = "P18-independent-observation";
    other.dependencies = ["source:diff"];
    f.manifest.expectedCases.push(other);
    f.changes.priorResults.push({ caseId: other.caseId, result: "passed" });
    f.changes.changes = [
      { dependencyId: "official:permission", fingerprint: "new-contract" },
    ];
    const result = planRevalidation(f.manifest, f.changes);
    expect(result.cases.map((entry) => entry.action)).toEqual([
      "revalidate",
      "reuse-candidate",
    ]);
  });

  it("canonicalizes key order without changing array order or falsy values", async () => {
    expect(canonicalJson({ b: "", a: [false, 0, null] })).toBe(
      canonicalJson({ a: [false, 0, null], b: "" }),
    );
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});
