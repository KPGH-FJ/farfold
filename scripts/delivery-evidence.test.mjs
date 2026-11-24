import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { planRevalidation, validateReceipt } from "./acceptance-receipts.mjs";
import { stableChecks } from "./delivery-check.mjs";
import { validateLocalDeliveryRecord } from "./delivery-evidence.mjs";

const base = "1".repeat(40);
const head = "2".repeat(40);
const merge = "3".repeat(40);
const headTree = "4".repeat(40);
const mergeTree = headTree;
const binarySha256 = "a".repeat(64);
const now = "2026-11-24T09:30:00Z";
const freshSince = "2026-10-23T23:40:00Z";
const roots = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture({ reviewBy, mode = "fresh" } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), "farfold-delivery-evidence-"));
  roots.push(rootDir);
  mkdirSync(join(rootDir, "output"));
  function writeJson(path, value) {
    const bytes = JSON.stringify(value);
    writeFileSync(join(rootDir, path), bytes);
    return digest(bytes);
  }
  const context = {
    agentId: "delivery-controlled-sample",
    platform: "macos-arm64",
    productCommit: head,
    app: {
      bundleId: "ai.farfold.desktop",
      version: "0.1.7",
      binarySha256,
      installedPath: "/Applications/Farfold.app",
    },
    observedAgentVersion: "sample-v1",
  };
  const inputs = { installation: "private-fingerprint-fixture" };
  const manifest = {
    schemaVersion: 1,
    runId: "expiry-control",
    preparedAt: "2026-10-24T00:00:00Z",
    ...(reviewBy ? { reviewBy } : {}),
    context,
    inputs,
    dependencies: [{ id: "app", kind: "app", fingerprint: binarySha256 }],
    expectedCases: [
      {
        caseId: "draft",
        agentId: context.agentId,
        standardIds: [],
        requirementIds: ["P01"],
        level: "installed",
        expectedOutcome: "success",
        safety: "observation",
        coveredConditions: [
          {
            conditionId: "requirement:P01",
            condition: "Draft held",
            excerpt: "Draft held",
          },
        ],
        requiredObservations: [
          {
            observationId: "ui",
            kind: "draft-readback",
            source: "installed-ui",
            expectedValue: true,
          },
        ],
        dependencies: ["app"],
      },
    ],
  };
  const manifestSha256 = writeJson("output/manifest.json", manifest);
  const original = "Synthetic draft guard observation";
  const originalPath = "output/private-ui-observation.txt";
  writeFileSync(join(rootDir, originalPath), original);
  const finishedAt = "2026-10-24T00:02:00Z";
  const receipt = {
    schemaVersion: 1,
    runId: manifest.runId,
    manifest: {
      path: "output/manifest.json",
      sha256: manifestSha256,
      visibility: "private",
    },
    attempts: [
      {
        attemptId: "one",
        caseId: "draft",
        startedAt: "2026-10-24T00:01:00Z",
        finishedAt,
        status: "completed",
        outcome: "success",
        level: "installed",
        context,
        inputsBefore: inputs,
        inputsAfter: inputs,
        observations: [
          {
            observationId: "ui",
            kind: "draft-readback",
            source: "installed-ui",
            value: true,
            evidenceIndexes: [0],
          },
        ],
        evidence: [
          {
            path: originalPath,
            sha256: digest(original),
            visibility: "private",
            level: "installed",
            source: "installed-ui",
          },
        ],
      },
    ],
    inputsAfter: inputs,
    finishedAt,
  };
  const receiptSha256 = writeJson("output/receipt.json", receipt);
  const buildReport = {
    schemaVersion: 1,
    sourceCommit: head,
    sourceTree: headTree,
    binarySha256,
    platform: context.platform,
    builtAt: "2026-10-23T23:45:00Z",
  };
  const build = {
    path: "output/build.json",
    sha256: writeJson("output/build.json", buildReport),
  };
  const entry = {
    mode,
    path: "output/receipt.json",
    sha256: receiptSha256,
    productCommit: head,
    binarySha256,
    requirementIds: ["P01"],
    build,
  };
  const record = {
    base,
    head,
    review: {
      base,
      head,
      verdict: "approved",
      reviewer: "control",
      summary: "Review record fixture",
    },
    stable: {
      required: true,
      reason: "App paths changed",
      report: "output/stable.json",
      sha256: writeJson("output/stable.json", {
        mode: "stable",
        platform: "darwin-arm64",
        inputsStable: true,
        head,
        results: stableChecks.map((command) => ({ command, exitCode: 0 })),
      }),
    },
    installed: {
      required: true,
      reason: "App paths changed",
      receipts: [entry],
    },
  };
  const capture = {
    base,
    head,
    receiptSha256,
    capturedAt: "2026-11-24T09:00:00Z",
    currentInputs: inputs,
    currentDependencies: [{ dependencyId: "app", fingerprint: binarySha256 }],
    missingEvidence: [],
    concerns: [],
  };
  function bindCapture({ reviewed = true } = {}) {
    const path = "output/current-inputs.json";
    entry.revalidation = { path, sha256: writeJson(path, capture) };
    if (reviewed)
      record.review.revalidations = [
        { receiptSha256, revalidationSha256: entry.revalidation.sha256 },
      ];
  }
  if (mode === "reuse") bindCapture();
  const options = {
    base,
    head,
    merge,
    now,
    freshSince,
    rootDir,
    scope: { stable: true, installed: true },
    sourceTrees: { [head]: headTree, [merge]: mergeTree },
  };
  return {
    record,
    options,
    entry,
    receipt,
    manifest,
    capture,
    bindCapture,
    buildReport,
    originalPath,
    writeJson,
  };
}

describe("dispatch to the existing acceptance revalidation rules", () => {
  it("rejects the same candidate with an expired receipt that still matches every observation", async () => {
    const f = fixture({ reviewBy: now });
    const predecessor = await validateReceipt(f.receipt, {
      rootDir: f.options.rootDir,
    });
    expect(predecessor.allExpectedOutcomesMatched).toBe(true);
    expect(
      planRevalidation(f.manifest, {
        now,
        currentInputs: f.manifest.inputs,
        priorResults: predecessor.cases,
      }).cases,
    ).toMatchObject([
      { action: "revalidate", reasons: ["review-horizon-reached"] },
    ]);
    await expect(
      validateLocalDeliveryRecord(f.record, f.options),
    ).rejects.toThrow("review-horizon-reached");
  });

  it("accepts freshly executed candidate evidence without a review horizon and exports no private paths or inputs", async () => {
    const f = fixture();
    const summary = await validateLocalDeliveryRecord(f.record, f.options);
    expect(summary.installed.receipts[0]).toMatchObject({
      mode: "fresh",
      preparedAt: f.manifest.preparedAt,
      reviewBy: null,
      revalidationSha256: null,
      revalidatedAt: null,
      buildSha256: f.entry.build.sha256,
      sourceTree: headTree,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /private-fingerprint|output\/|private-ui-observation/,
    );
  });

  it("accepts historical evidence when current inputs and dependencies match and the review binds the updated capture", async () => {
    const f = fixture({ reviewBy: "2027-01-01T00:00:00Z", mode: "reuse" });
    f.options.freshSince = "2026-11-24T08:00:00Z";
    const summary = await validateLocalDeliveryRecord(f.record, f.options);
    expect(summary.installed.receipts[0]).toMatchObject({
      mode: "reuse",
      revalidationSha256: f.entry.revalidation.sha256,
      revalidatedAt: f.capture.capturedAt,
    });
  });

  it("does not let a prior receipt escape revalidation by declaring it fresh", async () => {
    const f = fixture();
    f.options.freshSince = "2026-11-24T08:00:00Z";
    await expect(
      validateLocalDeliveryRecord(f.record, f.options),
    ).rejects.toThrow("older evidence requires reuse and revalidation");
  });

  it("rejects a revalidation capture made before this pull request", async () => {
    const f = fixture({ reviewBy: "2027-01-01T00:00:00Z", mode: "reuse" });
    f.options.freshSince = "2026-11-24T08:00:00Z";
    f.capture.capturedAt = "2026-11-24T07:45:00Z";
    f.bindCapture();
    await expect(
      validateLocalDeliveryRecord(f.record, f.options),
    ).rejects.toThrow(
      "Current inputs must be captured within the current pull request window",
    );
  });

  it.each([
    [
      "missing current inputs",
      (c) => {
        delete c.currentInputs;
      },
      "current-inputs-missing-or-changed",
    ],
    [
      "changed dependency",
      (c) => {
        c.currentDependencies[0].fingerprint = "different";
      },
      "dependency-changed",
    ],
    [
      "missing dependency",
      (c) => {
        c.currentDependencies = [];
      },
      "missing applicable dependency",
    ],
    [
      "known unavailable original",
      (c) => {
        c.missingEvidence = [{ caseId: "draft" }];
      },
      "evidence-missing",
    ],
    [
      "current capture for the wrong candidate",
      (c) => {
        c.head = merge;
      },
      "capture identity differs",
    ],
  ])(
    "rejects complete historic receipt with %s",
    async (_label, change, message) => {
      const f = fixture({ reviewBy: "2027-01-01T00:00:00Z", mode: "reuse" });
      change(f.capture);
      f.bindCapture();
      await expect(
        validateLocalDeliveryRecord(f.record, f.options),
      ).rejects.toThrow(message);
    },
  );

  it("requires a horizon for reuse even when a newly executed receipt would be valid", async () => {
    const f = fixture({ mode: "reuse" });
    await expect(
      validateLocalDeliveryRecord(f.record, f.options),
    ).rejects.toThrow("review-horizon-not-defined");
  });

  it("rejects historical receipt when an original cannot be inspected", async () => {
    const f = fixture({ reviewBy: "2027-01-01T00:00:00Z", mode: "reuse" });
    rmSync(join(f.options.rootDir, f.originalPath));
    await expect(
      validateLocalDeliveryRecord(f.record, f.options),
    ).rejects.toThrow("evidence-unreadable");
  });

  it("rejects a reuse-candidate whose current capture was replaced after independent review", async () => {
    const f = fixture({ reviewBy: "2027-01-01T00:00:00Z", mode: "reuse" });
    f.capture.capturedAt = "2026-11-24T09:01:00Z";
    f.bindCapture({ reviewed: false });
    await expect(
      validateLocalDeliveryRecord(f.record, f.options),
    ).rejects.toThrow("Independent review of this candidate must bind");
  });

  it.each([
    [
      "different base",
      (f) => {
        f.options.base = "7".repeat(40);
      },
      "does not match this base and candidate",
    ],
    [
      "different head",
      (f) => {
        f.options.head = "7".repeat(40);
      },
      "does not match this base and candidate",
    ],
    [
      "self-exemption from installed evidence",
      (f) => {
        f.record.installed.required = false;
      },
      "applicability claim differs",
    ],
    [
      "app identity mismatch",
      (f) => {
        f.entry.binarySha256 = "b".repeat(64);
      },
      "identity differs from the reviewed build",
    ],
    [
      "build record missing",
      (f) => {
        delete f.entry.build;
      },
      "needs a digest-bound build record",
    ],
    [
      "source tree mismatch",
      (f) => {
        f.options.sourceTrees[head] = "f".repeat(40);
      },
      "source tree differs from the GitHub candidate",
    ],
    [
      "head build differs from tested merge preview",
      (f) => {
        f.options.sourceTrees[merge] = "f".repeat(40);
      },
      "source tree differs from the tested merge preview",
    ],
  ])("rejects verification with %s", async (_label, change, message) => {
    const f = fixture();
    change(f);
    await expect(
      validateLocalDeliveryRecord(f.record, f.options),
    ).rejects.toThrow(message);
  });
});

it.skipIf(process.platform === "win32").each([
  ["expired installed receipt", () => {}, "review-horizon-reached"],
  [
    "different comparison merge base",
    (comparison) => {
      comparison.merge_base_commit.sha = head;
    },
    "complete candidate scope",
  ],
  [
    "rename without its original path",
    (comparison) => {
      comparison.files[0].status = "renamed";
    },
    "all required file paths",
  ],
])(
  "rejects %s on the actual CLI before reading the CI",
  (_label, change, message) => {
    const f = fixture({ reviewBy: "2026-10-25T00:00:00Z" });
    f.writeJson("output/record.json", f.record);
    const comparison = {
      base_commit: { sha: base },
      merge_base_commit: { sha: base },
      files: [{ filename: "public/brand/wordmark.svg", status: "modified" }],
    };
    change(comparison);
    const ghResults = {
      pr: {
        state: "OPEN",
        createdAt: freshSince,
        isDraft: false,
        baseRefName: "main",
        baseRefOid: base,
        headRefOid: head,
        mergeable: "MERGEABLE",
        potentialMergeCommit: { oid: merge },
      },
      [`commits/${merge}`]: {
        parents: [{ sha: base }, { sha: head }],
        commit: { tree: { sha: mergeTree } },
      },
      [`commits/${head}`]: { commit: { tree: { sha: headTree } } },
      [`compare/${base}...${merge}`]: comparison,
    };
    writeFileSync(
      join(f.options.rootDir, "gh"),
      `#!${process.execPath}\nconst results=${JSON.stringify(ghResults)}; const [method,path]=process.argv.slice(2); const key=method==='pr'?'pr':path.split('/').slice(3).join('/'); if (!(key in results)) { console.error('Unexpected GitHub request'); process.exit(8); } console.log(JSON.stringify(results[key]));\n`,
      { mode: 0o700 },
    );
    const cli = fileURLToPath(new URL("./delivery-pr.mjs", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [cli, "2", "output/record.json"],
      {
        cwd: f.options.rootDir,
        env: {
          ...process.env,
          PATH: `${f.options.rootDir}:${process.env.PATH}`,
        },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe("");
  },
);
