import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  lstat,
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

async function directChannelFixture(source) {
  const f = await fixture("real-agent");
  const attempt = f.receipt.attempts[0];
  for (const [
    index,
    item,
  ] of f.manifest.expectedCases[0].requiredObservations.entries()) {
    item.source = source;
    item.kind = "actual-agent-content-visible";
    attempt.observations[index].source = source;
    attempt.observations[index].kind = item.kind;
    attempt.evidence[index].source = source;
  }
  await f.saveManifest();
  return f;
}

const codes = (report) => report.errors.map((entry) => entry.code);

describe("acceptance receipt integrity", () => {
  it.each(["installed-ui", "official-interface"])(
    "accepts a real-Agent observation through the actual %s direct channel without demanding a second capture channel",
    async (source) => {
      const f = await directChannelFixture(source);
      const report = await validateReceipt(f.receipt, { rootDir: f.root });
      expect(report.mechanicallyValid).toBe(true);
      expect(report.allExpectedOutcomesMatched).toBe(true);
      expect(report.cases[0].level).toBe("real-agent");
      expect(report.acceptanceVerified).toBe(false);
      expect(report.requiresIndependentReview).toBe(true);
      expect(
        planRevalidation(f.manifest, {
          currentInputs: f.manifest.inputs,
          now: f.manifest.preparedAt,
        }),
      ).not.toHaveProperty("error");
    },
  );

  it.each(["controlled-peer", "filesystem", "os-observation"])(
    "does not turn %s-only evidence into a real-Agent observation by renaming its kind",
    async (source) => {
      const f = await directChannelFixture(source);
      const report = await validateReceipt(f.receipt, { rootDir: f.root });
      expect(report.mechanicallyValid).toBe(false);
      expect(report.counts.passed).toBe(0);
      expect(report.acceptanceVerified).toBe(false);
    },
  );

  it.each(["app", "selection"])(
    "still requires real-Agent %s context for an installed-UI-only observation",
    async (field) => {
      const f = await directChannelFixture("installed-ui");
      delete f.manifest.context[field];
      f.receipt.attempts[0].context = clone(f.manifest.context);
      await f.saveManifest();
      expect(
        codes(await validateReceipt(f.receipt, { rootDir: f.root })),
      ).toContain("invalid-run-context");
    },
  );

  it("keeps the direct observation tied to the actual evidence reference source", async () => {
    const f = await directChannelFixture("installed-ui");
    f.receipt.attempts[0].evidence[0].source = "controlled-peer";
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("required-observation-not-confirmed");
    expect(report.counts.passed).toBe(0);
  });

  it("still requires an installed UI observation for installed management cases", async () => {
    const f = await fixture("installed");
    f.manifest.expectedCases[0].requiredObservations[0].source =
      "official-interface";
    f.receipt.attempts[0].observations[0].source = "official-interface";
    f.receipt.attempts[0].evidence[0].source = "official-interface";
    await f.saveManifest();
    expect(
      codes(await validateReceipt(f.receipt, { rootDir: f.root })),
    ).toContain("missing-installed-observation");
  });

  it("retains requirement-only observations with an explicit empty standard claim and a safe public scope", async () => {
    const f = await fixture();
    f.manifest.expectedCases[0].standardIds = [];
    await f.saveManifest();
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(report.mechanicallyValid).toBe(true);
    expect(report.cases[0]).toMatchObject({
      standardIds: [],
      requirementIds: ["P18"],
      result: "passed",
      acceptanceVerified: false,
    });
    expect(report.cases[0].coveredConditions).toEqual(
      f.manifest.expectedCases[0].coveredConditions,
    );
    expect(report.cases[0].caseDefinitionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.cases[0].caseDefinitionSha256).not.toBe(
      digest(canonicalJson(f.manifest.expectedCases[0])),
    );
    expect(publicReceiptSummary(report).cases[0].claimScope).toBe(
      "requirement-only",
    );
    expect(publicReceiptSummary(report).acceptanceVerified).toBe(false);
    const normal = await fixture();
    const linked = await validateReceipt(normal.receipt, {
      rootDir: normal.root,
    });
    expect(publicReceiptSummary(linked).cases[0].claimScope).toBe(
      "includes-standard-claim",
    );
    const untrusted = clone(report);
    untrusted.cases[0].standardIds = ["PRIVATE-NOT-A-STANDARD"];
    expect(publicReceiptSummary(untrusted).cases[0].claimScope).toBeNull();
    expect(JSON.stringify(publicReceiptSummary(untrusted))).not.toContain(
      "PRIVATE",
    );
  });

  it("accepts an installed non-model observation without inventing a selected service or model", async () => {
    const f = await fixture("installed");
    f.manifest.expectedCases[0].standardIds = [];
    delete f.manifest.context.selection;
    delete f.receipt.attempts[0].context.selection;
    await f.saveManifest();
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(report.errors).toEqual([]);
    expect(report.mechanicallyValid).toBe(true);
    expect(report.cases[0]).toMatchObject({
      standardIds: [],
      level: "installed",
      result: "passed",
      acceptanceVerified: false,
    });
    expect(report.cases[0]).not.toHaveProperty("selection");
    expect(publicReceiptSummary(report).cases[0]).toMatchObject({
      claimScope: "requirement-only",
      level: "installed",
    });
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
    const summary = JSON.parse(cli.stdout);
    expect(summary.cases[0]).toMatchObject({
      claimScope: "requirement-only",
      level: "installed",
      result: "passed",
    });
    expect(summary.acceptanceVerified).toBe(false);
    expect(cli.stdout).not.toContain("/Applications");
    expect(cli.stdout).not.toContain("serviceId");
  });

  it.each(["app", "observedAgentVersion"])(
    "still requires installed %s when the non-model selection is omitted",
    async (field) => {
      const f = await fixture("installed");
      delete f.manifest.context.selection;
      delete f.manifest.context[field];
      f.receipt.attempts[0].context = clone(f.manifest.context);
      await f.saveManifest();
      expect(
        codes(await validateReceipt(f.receipt, { rootDir: f.root })),
      ).toContain("invalid-run-context");
    },
  );

  it.each([
    null,
    {},
    { serviceId: "service", modelId: "model" },
    {
      serviceId: "service",
      modelId: "model",
      reasoningId: null,
      privateExtra: "not-allowed",
    },
  ])(
    "strictly validates a supplied installed selection instead of treating malformed data as omitted: %j",
    async (selection) => {
      const f = await fixture("installed");
      f.manifest.context.selection = selection;
      f.receipt.attempts[0].context = clone(f.manifest.context);
      await f.saveManifest();
      expect(
        codes(await validateReceipt(f.receipt, { rootDir: f.root })),
      ).toContain("invalid-run-context");
    },
  );

  it("does not waive selected configuration for real-agent or mixed real-agent runs", async () => {
    for (const mixed of [false, true]) {
      const f = await fixture(mixed ? "installed" : "real-agent");
      delete f.manifest.context.selection;
      delete f.receipt.attempts[0].context.selection;
      if (mixed)
        f.manifest.expectedCases.push({
          ...clone(f.manifest.expectedCases[0]),
          caseId: "real-agent-case",
          level: "real-agent",
        });
      await f.saveManifest();
      expect(
        codes(await validateReceipt(f.receipt, { rootDir: f.root })),
      ).toContain("invalid-run-context");
    }
  });

  it("retains exact manifest/attempt context equality for an optional installed selection", async () => {
    const f = await fixture("installed");
    delete f.manifest.context.selection;
    await f.saveManifest();
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(codes(report)).toContain("attempt-context-mismatch");
    expect(report.counts.passed).toBe(0);
  });

  it.each([
    { standardIds: undefined },
    { standardIds: null },
    { standardIds: ["S9"] },
    { standardIds: [], requirementIds: [] },
    { standardIds: ["S5"], requirementIds: [] },
    {
      standardIds: [],
      coveredConditions: [
        {
          conditionId: "standard:S3",
          condition: "A full standard",
          excerpt: "full",
        },
      ],
    },
    {
      standardIds: [],
      coveredConditions: [
        {
          conditionId: "requirement:P32",
          condition: "A different requirement",
          excerpt: "different",
        },
      ],
    },
    {
      standardIds: [],
      coveredConditions: [
        {
          conditionId: "package:G",
          condition: "A package only",
          excerpt: "package",
        },
      ],
    },
    {
      standardIds: [],
      coveredConditions: [
        {
          conditionId: "requirement:P18",
          condition: "A complete condition",
          excerpt: "complete",
        },
        {
          conditionId: "standard:S3",
          condition: "A full standard",
          excerpt: "full",
        },
      ],
    },
    {
      standardIds: [],
      coveredConditions: [
        {
          conditionId: "requirement:P18",
          condition: "A complete condition",
          excerpt: "complete",
        },
        {
          conditionId: "requirement:P32",
          condition: "A different condition",
          excerpt: "different",
        },
      ],
    },
    { standardIds: [], requirementIds: ["P18", "P32"] },
  ])(
    "does not let requirement-only declarations lose their requirement anchor or smuggle a standard: %j",
    async (change) => {
      const f = await fixture();
      Object.assign(f.manifest.expectedCases[0], change);
      await f.saveManifest();
      const report = await validateReceipt(f.receipt, { rootDir: f.root });
      expect(report.mechanicallyValid).toBe(false);
      expect(report.acceptanceVerified).toBe(false);
    },
  );

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

  // Git/MSYS mkfifo is not a POSIX FIFO fixture for the Win32 Node process.
  it.skipIf(process.platform === "win32")(
    "rejects a POSIX FIFO evidence path without blocking on open",
    async () => {
      const f = await fixture();
      const fifo = "output/run/pipe";
      await exec("mkfifo", [path.join(f.root, fifo)]);
      expect((await lstat(path.join(f.root, fifo))).isFIFO()).toBe(true);
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
    },
  );

  it("bounds explicit CLI JSON inputs", async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.root, "oversize.json"),
      `${" ".repeat(4 * 1024 * 1024)}${JSON.stringify(f.receipt)}`,
    );
    let cli;
    try {
      cli = await exec(
        process.execPath,
        [
          path.resolve("scripts/acceptance-receipts.mjs"),
          "validate",
          "oversize.json",
        ],
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
  });

  it.skipIf(process.platform === "win32")(
    "refuses POSIX FIFO input without waiting for a writer",
    async () => {
      const f = await fixture();
      const fifo = path.join(f.root, "fifo.json");
      await exec("mkfifo", [fifo]);
      expect((await lstat(fifo)).isFIFO()).toBe(true);
      let cli;
      try {
        cli = await exec(
          process.execPath,
          [
            path.resolve("scripts/acceptance-receipts.mjs"),
            "validate",
            "fifo.json",
          ],
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
    },
  );
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

  it("revalidates requirement-only cases by the same explicit inputs and dependencies without adding standards", async () => {
    const f = await setup();
    f.manifest.expectedCases[0].standardIds = [];
    await f.saveManifest();
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(report.mechanicallyValid).toBe(true);
    const unchanged = planRevalidation(f.manifest, {
      ...f.changes,
      priorResults: report.cases,
    });
    expect(unchanged.cases[0]).toMatchObject({
      action: "reuse-candidate",
      reasons: [],
    });
    expect(unchanged.acceptanceVerified).toBe(false);
    const changed = planRevalidation(f.manifest, {
      ...f.changes,
      priorResults: report.cases,
      changes: [{ dependencyId: "source:diff", fingerprint: "changed" }],
    });
    expect(changed.cases[0].action).toBe("revalidate");
    expect(changed.cases[0].reasons).toContain("dependency-changed");
    expect(report.cases[0].standardIds).toEqual([]);
  });

  it.each([
    "agentId",
    "standardIds",
    "requirementIds",
    "level",
    "coveredConditions",
  ])(
    "does not reuse a clean old result after its %s claim scope changes or is absent",
    async (field) => {
      const f = await setup();
      const prior = clone(f.changes.priorResults);
      const changed = clone(prior);
      if (field === "agentId") changed[0][field] = "another-agent";
      if (field === "standardIds") changed[0][field] = [];
      if (field === "requirementIds") changed[0][field] = ["P32"];
      if (field === "level") changed[0][field] = "installed";
      if (field === "coveredConditions")
        changed[0][field][0].excerpt = "requirement";
      const before = clone(changed);
      const result = planRevalidation(f.manifest, {
        ...f.changes,
        priorResults: changed,
      });
      expect(result.cases[0].action).toBe("revalidate");
      expect(result.cases[0].reasons).toContain(
        "prior-scope-missing-or-changed",
      );
      expect(changed).toEqual(before);
      delete prior[0][field];
      expect(
        planRevalidation(f.manifest, { ...f.changes, priorResults: prior })
          .cases[0].reasons,
      ).toContain("prior-scope-missing-or-changed");
    },
  );

  it("never upgrades a prior requirement-only observation to a standard claim through reuse", async () => {
    const f = await setup();
    f.manifest.expectedCases[0].standardIds = [];
    await f.saveManifest();
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(report.mechanicallyValid).toBe(true);
    const prior = clone(report.cases);
    f.manifest.expectedCases[0].standardIds = ["S8"];
    const result = planRevalidation(f.manifest, {
      ...f.changes,
      priorResults: prior,
    });
    expect(result.cases[0].action).toBe("revalidate");
    expect(result.cases[0].reasons).toContain("prior-scope-missing-or-changed");
    expect(prior[0].standardIds).toEqual([]);
    expect(prior[0].result).toBe("passed");
    expect(result.acceptanceVerified).toBe(false);
  });

  it.each(["success", "rejection"])(
    "does not reuse a clean %s result as the opposite expected outcome",
    async (expectedOutcome) => {
      const f = await setup();
      f.manifest.expectedCases[0].expectedOutcome = expectedOutcome;
      f.receipt.attempts[0].outcome = expectedOutcome;
      await f.saveManifest();
      const report = await validateReceipt(f.receipt, { rootDir: f.root });
      expect(report.mechanicallyValid).toBe(true);
      const prior = clone(report.cases);
      f.manifest.expectedCases[0].expectedOutcome =
        expectedOutcome === "success" ? "rejection" : "success";
      const result = planRevalidation(f.manifest, {
        ...f.changes,
        priorResults: prior,
      });
      expect(result.cases[0].action).toBe("revalidate");
      expect(result.cases[0].reasons).toContain(
        "prior-result-missing-or-not-clean",
      );
      expect(prior).toEqual(report.cases);
    },
  );

  it.each([
    "requiredObservations",
    "safety",
    "dependencies",
    "coveredConditions",
  ])(
    "binds reuse to the complete expected-case definition including %s",
    async (field) => {
      const f = await setup();
      const prior = clone(f.changes.priorResults);
      const expected = f.manifest.expectedCases[0];
      if (field === "requiredObservations")
        expected.requiredObservations[0].expectedValue = false;
      if (field === "safety") expected.safety = "side-effect";
      if (field === "dependencies") expected.dependencies = ["source:diff"];
      if (field === "coveredConditions")
        expected.coveredConditions[0].excerpt = "requirement";
      const result = planRevalidation(f.manifest, {
        ...f.changes,
        priorResults: prior,
      });
      expect(result.cases[0].action).toBe("revalidate");
      expect(result.cases[0].reasons).toContain(
        "prior-definition-missing-or-changed",
      );
      expect(prior[0].result).toBe("passed");
      expect(prior).toEqual(f.changes.priorResults);
    },
  );

  it.each([undefined, "invalid-private-fingerprint", "a".repeat(63)])(
    "does not reuse old or malformed definition fingerprint %j",
    async (caseDefinitionSha256) => {
      const f = await setup();
      f.changes.priorResults[0].caseDefinitionSha256 = caseDefinitionSha256;
      const result = planRevalidation(f.manifest, f.changes);
      expect(result.cases[0].action).toBe("revalidate");
      expect(result.cases[0].reasons).toContain(
        "prior-definition-missing-or-changed",
      );
      expect(f.changes.priorResults[0].result).toBe("passed");
    },
  );

  it("canonicalizes definition object keys without weakening ordered arrays or editing the original manifest reference", async () => {
    const f = await setup();
    const originalRef = clone(f.receipt.manifest);
    const expected = f.manifest.expectedCases[0];
    f.manifest.expectedCases[0] = Object.fromEntries(
      Object.entries(expected).reverse(),
    );
    f.manifest.context = Object.fromEntries(
      Object.entries(f.manifest.context).reverse(),
    );
    f.manifest.inputs = Object.fromEntries(
      Object.entries(f.manifest.inputs).reverse(),
    );
    f.manifest.dependencies = f.manifest.dependencies.map((entry) =>
      Object.fromEntries(Object.entries(entry).reverse()),
    );
    const result = planRevalidation(f.manifest, f.changes);
    expect(result.cases[0]).toMatchObject({
      action: "reuse-candidate",
      reasons: [],
    });
    expect(f.receipt.manifest).toEqual(originalRef);
    expect(f.changes.priorResults[0].caseDefinitionSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it.each([
    "observedAgentVersion",
    "productCommit",
    "platform",
    "appVersion",
    "appBinary",
    "serviceId",
    "modelId",
    "reasoningId",
    "omittedSelection",
    "inputs",
    "dependencyFingerprint",
    "dependencyKind",
  ])(
    "binds prior reuse to inherited %s even without a separately reported change",
    async (field) => {
      const f = await fixture("installed");
      const report = await validateReceipt(f.receipt, { rootDir: f.root });
      expect(report.mechanicallyValid).toBe(true);
      const prior = clone(report.cases);
      if (field === "observedAgentVersion")
        f.manifest.context.observedAgentVersion = "different-observed-version";
      if (field === "productCommit")
        f.manifest.context.productCommit = "different-product-commit";
      if (field === "platform") f.manifest.context.platform = "win32-arm64";
      if (field === "appVersion")
        f.manifest.context.app.version = "different-app-version";
      if (field === "appBinary")
        f.manifest.context.app.binarySha256 = "b".repeat(64);
      if (["serviceId", "modelId", "reasoningId"].includes(field))
        f.manifest.context.selection[field] = "different-selected-value";
      if (field === "omittedSelection") delete f.manifest.context.selection;
      if (field === "inputs") f.manifest.inputs.fixture = "changed-input";
      if (field === "dependencyFingerprint")
        f.manifest.dependencies[0].fingerprint = "changed-declared-source";
      if (field === "dependencyKind")
        f.manifest.dependencies[0].kind = "fixture";
      const result = planRevalidation(f.manifest, {
        currentInputs: clone(f.manifest.inputs),
        priorResults: prior,
        changes: [],
        now: "2026-10-24T12:00:00Z",
      });
      expect(result.error).toBeUndefined();
      expect(result.cases[0].action).toBe("revalidate");
      expect(result.cases[0].reasons).toContain(
        "prior-definition-missing-or-changed",
      );
      expect(prior).toEqual(report.cases);
      expect(result.acceptanceVerified).toBe(false);
    },
  );

  it("keeps an unchanged installed run context eligible without changing its manifest reference", async () => {
    const f = await fixture("installed");
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    const reference = clone(f.receipt.manifest);
    const result = planRevalidation(f.manifest, {
      currentInputs: clone(f.manifest.inputs),
      priorResults: report.cases,
      now: "2026-10-24T12:00:00Z",
    });
    expect(report.mechanicallyValid).toBe(true);
    expect(result.cases[0]).toMatchObject({
      action: "reuse-candidate",
      reasons: [],
    });
    expect(f.receipt.manifest).toEqual(reference);
    expect(result.acceptanceVerified).toBe(false);
  });

  it("does not reuse an old case-only definition digest after inherited inputs become part of the definition", async () => {
    const f = await setup();
    f.changes.priorResults[0].caseDefinitionSha256 = digest(
      canonicalJson(f.manifest.expectedCases[0]),
    );
    const result = planRevalidation(f.manifest, f.changes);
    expect(result.cases[0].action).toBe("revalidate");
    expect(result.cases[0].reasons).toContain(
      "prior-definition-missing-or-changed",
    );
    expect(f.changes.priorResults[0].result).toBe("passed");
  });

  it("binds only the current case dependency declarations when a manifest dependency fingerprint changes", async () => {
    const f = await setup();
    const other = clone(f.manifest.expectedCases[0]);
    other.caseId = "P18-independent-declaration";
    other.dependencies = ["source:diff"];
    f.manifest.expectedCases.push(other);
    const second = clone(f.receipt.attempts[0]);
    second.caseId = other.caseId;
    second.attemptId = "independent-declaration-attempt";
    f.receipt.attempts.push(second);
    await f.saveManifest();
    const report = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(report.mechanicallyValid).toBe(true);
    f.manifest.dependencies[1].fingerprint = "changed-declared-contract";
    const result = planRevalidation(f.manifest, {
      ...f.changes,
      priorResults: report.cases,
      changes: [],
    });
    expect(result.cases.map((entry) => entry.action)).toEqual([
      "revalidate",
      "reuse-candidate",
    ]);
    expect(result.cases[0].reasons).toContain(
      "prior-definition-missing-or-changed",
    );
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
    const second = clone(f.receipt.attempts[0]);
    second.caseId = other.caseId;
    second.attemptId = "independent-attempt";
    f.receipt.attempts.push(second);
    await f.saveManifest();
    const validated = await validateReceipt(f.receipt, { rootDir: f.root });
    expect(validated.mechanicallyValid).toBe(true);
    f.changes.priorResults = validated.cases;
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
