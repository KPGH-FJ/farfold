import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  privateEvidenceFor,
  targetFor,
  verifyFinalDelivery,
} from "./delivery-final.mjs";
import {
  requiredAffectedCommands,
  requiredWindowsAffectedCommands,
  windowsAffectedTests,
} from "./delivery-check.mjs";
import { classifyDeliveryPaths } from "./delivery-scope.mjs";
import { privateAttestationBytes } from "./delivery-private-attestation.mjs";

const target = {
  number: 7,
  repositoryId: 12,
  headRepo: 12,
  base: "a".repeat(40),
  head: "b".repeat(40),
  merge: "c".repeat(40),
  headTree: "d".repeat(40),
  mergeTree: "d".repeat(40),
  createdAt: "2026-11-24T07:00:00Z",
  previewCreatedAt: "2026-11-24T07:01:00Z",
};
const run = {
  id: 31,
  workflow_id: 32,
  run_attempt: 2,
  event: "pull_request",
  path: ".github/workflows/delivery.yml",
  status: "completed",
  conclusion: "success",
  repository: { id: 12 },
  head_repository: { id: 12 },
  head_sha: target.head,
  pull_requests: [{ number: 7 }],
  run_started_at: "2026-11-24T07:05:00Z",
};
const now = Date.parse("2026-11-24T09:00:00Z");
const artifactDigest = "1".repeat(64);

function providerComment() {
  return {
    id: 7127685325,
    user: { id: 199175422, type: "Bot", login: "chatgpt-codex-connector[bot]" },
    performed_via_github_app: {
      id: 1144995,
      slug: "chatgpt-codex-connector",
      owner: { login: "openai" },
    },
    updated_at: "2026-11-24T08:05:00Z",
    body: [
      "<!-- codex-pull-request-review-summary -->",
      `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: target.head, status: "completed", has_any_findings: false, has_unresolved_findings: false } })} -->`,
      '| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-11-24T08:00:00.307599Z">2026-11-24T08:00:00.307599Z</relative-time> | `bbbbbbb` | PR opened |',
    ].join("\n"),
  };
}

function buildAttestation(scope, overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { base, head, merge, repositoryId } = target;
  const claim = {
    repositoryId,
    pr: target.number,
    base,
    head,
    merge,
    engineeringRunId: run.id,
    engineeringRunAttempt: run.run_attempt,
    executionId: "private_execution_1234",
    transcriptSha256: "2".repeat(64),
    reviewedAt: "2026-11-24T08:10:00Z",
    originalsId: "private_originals_1234",
    decision: "approved",
    evidence: {
      base,
      head,
      merge,
      stable: { required: false, sha256: null },
      installed: { required: false, receipts: [] },
    },
    policyReview: scope.governance
      ? {
          preservesRequirements: true,
          assessment:
            "Independently reviewed the policy change and preservation of the existing test scope.",
        }
      : null,
    ...overrides,
  };
  const signature = sign(
    null,
    privateAttestationBytes(claim),
    privateKey,
  ).toString("base64url");
  return {
    publicKey: publicKey.export({ format: "pem", type: "spki" }),
    comment: {
      id: 40,
      user: { id: 77, type: "User" },
      author_association: "OWNER",
      body:
        "<!-- farfold-private-delivery:v1 -->\n" +
        JSON.stringify({ schemaVersion: 1, claim, signature }),
    },
  };
}

function client({
  path = "README.md",
  files = [{ filename: path, status: "modified" }],
  comments = [providerComment()],
  report,
  runList = [run],
  windowsJob = true,
  windowsTests = windowsAffectedTests.map((name) => ({
    name,
    passed: 1,
    failed: 0,
    ignored: 0,
  })),
  publicKey,
} = {}) {
  const scope = classifyDeliveryPaths(
    files.flatMap(({ filename, previous_filename }) =>
      [filename, previous_filename].filter(Boolean),
    ),
  );
  const job = (name) => ({
    name,
    head_sha: target.head,
    status: "completed",
    conclusion: "success",
  });
  const artifact = (name, id) => ({
    id,
    name: `${name}-2`,
    workflow_run: { id: 31 },
    size_in_bytes: 534,
    expired: false,
    digest: `sha256:${artifactDigest}`,
  });
  const routes = {
    [`compare/${target.base}...${target.merge}`]: {
      base_commit: { sha: target.base },
      merge_base_commit: { sha: target.base },
      files,
    },
    [`compare/${target.base}...${target.head}?per_page=1`]: {
      base_commit: { sha: target.base },
      merge_base_commit: { sha: target.base },
      status: "ahead",
      ahead_by: 1,
    },
    "issues/7/comments?per_page=100&page=1": comments,
    "actions/workflows/delivery.yml": { id: 32 },
    [`actions/workflows/delivery.yml/runs?event=pull_request&head_sha=${target.head}&per_page=100`]:
      { workflow_runs: runList },
    "actions/runs/31/attempts/2/jobs?per_page=100": {
      jobs: [
        job("Farfold delivery check"),
        ...(windowsJob ? [job("Windows affected engineering checks")] : []),
      ],
    },
    "actions/runs/31/artifacts?per_page=100": {
      artifacts: [
        artifact("delivery-checks", 35),
        artifact("delivery-windows", 36),
      ],
    },
  };
  const results = (commands) =>
    commands.map((command) => ({
      command,
      exitCode: 0,
      signal: null,
      error: null,
    }));
  return {
    publicKey,
    api(route) {
      if (!Object.hasOwn(routes, route))
        throw new Error(`Unexpected test route: ${route}`);
      return routes[route];
    },
    report(_artifact, entry) {
      const header = {
        head: target.merge,
        base: target.base,
        inputsStable: true,
      };
      if (entry === "delivery-windows.json") {
        return {
          ...header,
          mode: "affected-windows",
          platform: "win32-x64",
          tests: windowsTests,
          results: results(
            requiredWindowsAffectedCommands(target.base, target.merge),
          ),
        };
      }
      return (
        report ?? {
          ...header,
          mode: "affected",
          results: results(
            requiredAffectedCommands(scope, target.base, target.merge),
          ),
        }
      );
    },
  };
}

describe("hosted final delivery", () => {
  it("can accept an authenticated Codex-reviewed docs change without a second GitHub account or a private signer", () => {
    expect(verifyFinalDelivery(client(), target, now)).toMatchObject({
      runId: 31,
      runAttempt: 2,
      review: { reviewId: 7127685325 },
      scope: { product: false, governance: false },
      evidence: null,
    });
  });

  it("fails green engineering when authenticated code review is missing", () => {
    expect(() =>
      verifyFinalDelivery(client({ comments: [] }), target, now),
    ).toThrow(/authenticated Codex App review summary/i);
  });

  it("fails closed on an incomplete exact-scope compare or rename record", () => {
    const truncated = Array.from({ length: 300 }, (_, i) => ({
      filename: `docs/page-${i}.md`,
    }));
    expect(() =>
      verifyFinalDelivery(client({ files: truncated }), target, now),
    ).toThrow(/complete exact merge-preview file list/i);
    expect(() =>
      verifyFinalDelivery(
        client({ files: [{ filename: "README.md", status: "renamed" }] }),
        target,
        now,
      ),
    ).toThrow(/all required file paths/i);
  });

  it("applies private installed-evidence prerequisites to a resource change or a rename out of public", () => {
    for (const files of [
      [{ filename: "public/brand/wordmark.svg", status: "modified" }],
      [
        {
          filename: "docs/wordmark.svg",
          previous_filename: "public/brand/wordmark.svg",
          status: "renamed",
        },
      ],
    ]) {
      expect(() => verifyFinalDelivery(client({ files }), target, now)).toThrow(
        /needs a configured trusted custodian key/i,
      );
    }
  });

  it("requires a signed policy assessment for delivery-governance changes", () => {
    const path = ".github/workflows/delivery.yml";
    const scope = classifyDeliveryPaths([path]);
    expect(() => verifyFinalDelivery(client({ path }), target, now)).toThrow(
      /policy assessment needs a configured trusted custodian key/i,
    );
    const { comment, publicKey } = buildAttestation(scope);
    expect(
      verifyFinalDelivery(
        client({ path, publicKey, comments: [providerComment(), comment] }),
        target,
        now,
      ),
    ).toMatchObject({
      scope: { governance: true },
      evidence: { evidenceId: 40 },
    });
  });

  it("does not treat a plain owner comment as independent private evidence", () => {
    const scope = classifyDeliveryPaths(["scripts/delivery-final.mjs"]);
    const { comment, publicKey } = buildAttestation(scope);
    const forged = comment.body.replace(
      "private_execution_1234",
      "private_execution_9999",
    );
    expect(() =>
      privateEvidenceFor(
        [{ ...comment, body: forged }],
        target,
        scope,
        run,
        now,
        publicKey,
      ),
    ).toThrow(/signature does not match/i);
  });

  it("does not fall back to older successful attempts when the current one failed", () => {
    expect(() =>
      verifyFinalDelivery(
        client({
          runList: [{ ...run, conclusion: "failure", run_attempt: 3 }, run],
        }),
        target,
        now,
      ),
    ).toThrow(/current PR needs a successful engineering workflow attempt/i);
  });

  it("rejects an engineering report from a different merge preview", () => {
    expect(() =>
      verifyFinalDelivery(
        client({
          report: {
            mode: "affected",
            base: target.base,
            head: target.head,
            inputsStable: true,
            results: [{ exitCode: 0 }],
          },
        }),
        target,
        now,
      ),
    ).toThrow(/exact merge preview and base/i);
  });

  it("refuses a green artifact that omits required affected-scope commands", () => {
    expect(() =>
      verifyFinalDelivery(
        client({
          report: {
            mode: "affected",
            base: target.base,
            head: target.merge,
            inputsStable: true,
            results: [
              {
                command: ["git", "diff", "--check", target.base, target.merge],
                exitCode: 0,
              },
            ],
          },
        }),
        target,
        now,
      ),
    ).toThrow(/omitted a required affected-scope check/i);
  });

  it("requires the separate job and all exact Windows test results when applicable", () => {
    const path = "src-tauri/src/worktrees/windows_git.rs";
    expect(() =>
      verifyFinalDelivery(client({ path, windowsJob: false }), target, now),
    ).toThrow(/Windows engineering job did not pass/i);
    expect(() =>
      verifyFinalDelivery(client({ path, windowsTests: [] }), target, now),
    ).toThrow(/Windows engineering report omitted/i);
    expect(() => verifyFinalDelivery(client({ path }), target, now)).toThrow(
      /needs a configured trusted custodian key/i,
    );
  });

  it("rejects a GitHub preview with mismatched parents", () => {
    const api = (path) =>
      ({
        "pulls/7": {
          number: 7,
          state: "open",
          base: { sha: target.base, ref: "main", repo: { id: 12 } },
          head: { sha: target.head, repo: { id: 12 } },
          merge_commit_sha: target.merge,
          user: { id: 21 },
        },
        [`git/commits/${target.merge}`]: {
          sha: target.merge,
          parents: [{ sha: target.head }, { sha: target.base }],
          tree: { sha: target.mergeTree },
        },
        [`git/commits/${target.head}`]: {
          sha: target.head,
          tree: { sha: target.headTree },
        },
      })[path];
    expect(() =>
      targetFor(api, target.number, target.base, target.repositoryId),
    ).toThrow(/preview or candidate tree/i);
  });
});
