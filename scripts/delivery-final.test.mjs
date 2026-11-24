import { describe, expect, it } from "vitest";
import {
  reviewPayload,
  targetFor,
  validateReviewedEvidence,
  verifyFinalDelivery,
} from "./delivery-final.mjs";
import { requiredAffectedCommands } from "./delivery-check.mjs";
import { classifyDeliveryPaths } from "./delivery-scope.mjs";

const target = {
  number: 7,
  repositoryId: 12,
  headRepo: 12,
  author: 21,
  createdAt: "2026-11-24T05:00:00Z",
  commits: 1,
  base: "a".repeat(40),
  head: "b".repeat(40),
  merge: "c".repeat(40),
  headTree: "d".repeat(40),
  mergeTree: "d".repeat(40),
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
};
const reviewer = { id: 22, login: "verifier", type: "User" };
const reportSha256 = "1".repeat(64);
const now = Date.parse("2026-11-24T08:00:00Z");

function record({ product = false, governance = false } = {}) {
  return {
    schemaVersion: 1,
    evidence: {
      base: target.base,
      head: target.head,
      merge: target.merge,
      stable: { required: product, sha256: product ? reportSha256 : null },
      installed: {
        required: product,
        receipts: product
          ? [
              {
                mode: "fresh",
                receiptSha256: "2".repeat(64),
                manifestSha256: "3".repeat(64),
                productCommit: target.head,
                binarySha256: "4".repeat(64),
                requirementIds: ["P01"],
                preparedAt: "2026-11-24T05:30:00Z",
                finishedAt: "2026-11-24T06:00:00Z",
                reviewBy: null,
                revalidationSha256: null,
                revalidatedAt: null,
                buildSha256: "5".repeat(64),
                sourceTree: target.headTree,
              },
            ]
          : [],
      },
    },
    engineeringRunId: run.id,
    engineeringRunAttempt: run.run_attempt,
    reviewSummary:
      "Checked the exact candidate and engineering report independently.",
    scopeReasons: product
      ? { stable: null, installed: null }
      : {
          stable: "Documentation only; no product code changes.",
          installed: "No product build or installed behavior changed.",
        },
    policyReview: governance
      ? {
          preservesRequirements: true,
          assessment:
            "The delivery workflow preserves all original checks and acceptance obligations.",
        }
      : null,
    originalsId: "private_handoff_1234",
  };
}

function approval(payload = record()) {
  return {
    id: 37,
    state: "APPROVED",
    submitted_at: "2026-11-24T07:00:00Z",
    commit_id: target.head,
    author_association: "COLLABORATOR",
    user: reviewer,
    body: JSON.stringify(payload),
  };
}

function client({
  path = "README.md",
  files = [{ filename: path, status: "modified" }],
  reviews = [approval()],
  author = { id: target.author },
  committer,
  permission = { user: reviewer, role_name: "write" },
  report,
  runList = [run],
} = {}) {
  const routes = {
    [`compare/${target.base}...${target.merge}`]: {
      base_commit: { sha: target.base },
      merge_base_commit: { sha: target.base },
      files,
    },
    "pulls/7/commits?per_page=100&page=1": [{ author, committer }],
    "pulls/7/reviews?per_page=100&page=1": reviews,
    "collaborators/verifier/permission": permission,
    "actions/workflows/delivery.yml": { id: 32 },
    [`actions/workflows/delivery.yml/runs?event=pull_request&head_sha=${target.head}&per_page=100`]:
      { workflow_runs: runList },
    "actions/runs/31/attempts/2/jobs?per_page=100": {
      jobs: [
        {
          name: "Farfold delivery check",
          head_sha: target.head,
          status: "completed",
          conclusion: "success",
        },
      ],
    },
    "actions/runs/31/artifacts?per_page=100": {
      artifacts: [
        {
          name: "delivery-checks-2",
          id: 35,
          workflow_run: { id: 31 },
          size_in_bytes: 534,
          expired: false,
          digest: `sha256:${reportSha256}`,
        },
      ],
    },
  };
  return {
    api(route) {
      if (!Object.hasOwn(routes, route))
        throw new Error(`Unexpected test route: ${route}`);
      return routes[route];
    },
    report: () =>
      report ?? {
        mode: "affected",
        head: target.merge,
        base: target.base,
        inputsStable: true,
        results: requiredAffectedCommands(
          classifyDeliveryPaths(
            files.flatMap(({ filename, previous_filename }) =>
              [filename, previous_filename].filter(Boolean),
            ),
          ),
          target.base,
          target.merge,
        ).map((command) => ({ command, exitCode: 0 })),
      },
  };
}

describe("final delivery", () => {
  it("accepts an independently approved non-product change with no skipped product obligations", () => {
    expect(verifyFinalDelivery(client(), target, now)).toMatchObject({
      runId: 31,
      runAttempt: 2,
      reviewId: 37,
      scope: { product: false },
    });
  });

  it("accepts authenticated fresh candidate build evidence without a reuse horizon", () => {
    const proof = client({
      path: "src/example.ts",
      reviews: [approval(record({ product: true }))],
    });
    expect(verifyFinalDelivery(proof, target, now).scope.product).toBe(true);
  });

  it("fails green engineering when an independent approving review is missing", () => {
    expect(() =>
      verifyFinalDelivery(client({ reviews: [] }), target, now),
    ).toThrow(/independent GitHub approving review/i);
  });

  it.each([
    [
      "PR author",
      {
        reviews: [{ ...approval(), user: { ...reviewer, id: target.author } }],
      },
    ],
    ["candidate commit author", { author: reviewer }],
    ["candidate commit committer", { committer: reviewer }],
    [
      "read-only reviewer",
      { permission: { user: reviewer, role_name: "read" } },
    ],
    [
      "a dismissed approval",
      { reviews: [approval(), { ...approval(), id: 40, state: "DISMISSED" }] },
    ],
    [
      "a previous head approval",
      { reviews: [{ ...approval(), commit_id: target.base }] },
    ],
  ])("does not accept %s", (_, overrides) => {
    expect(() => verifyFinalDelivery(client(overrides), target, now)).toThrow(
      /independent GitHub approving review/i,
    );
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

  it("refuses evidence recorded after the approving review", () => {
    const proof = client({
      path: "src/example.ts",
      reviews: [
        {
          ...approval(record({ product: true })),
          submitted_at: "2026-11-24T05:59:58Z",
        },
      ],
    });
    expect(() => verifyFinalDelivery(proof, target, now)).toThrow(
      /later than the approval/i,
    );
  });

  it("fails closed on an incomplete API path or rename record", () => {
    const truncated = Array.from({ length: 300 }, (_, i) => ({
      filename: `docs/page-${i}.md`,
    }));
    expect(() =>
      verifyFinalDelivery(client({ files: truncated }), target, now),
    ).toThrow(/complete exact merge-preview file list/i);
    expect(() =>
      verifyFinalDelivery(
        client({
          files: [{ filename: "README.md", status: "renamed" }],
        }),
        target,
        now,
      ),
    ).toThrow(/all required file paths/i);
  });

  it("applies product safeguards to a resource change or a rename out of public", () => {
    const negative = record({ product: true });
    negative.evidence.installed.receipts = [];
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
      expect(() =>
        verifyFinalDelivery(
          client({ files, reviews: [approval(negative)] }),
          target,
          now,
        ),
      ).toThrow(/reviewed installed evidence/i);
      expect(() => verifyFinalDelivery(client({ files }), target, now)).toThrow(
        /provide both for this product change/i,
      );
    }
  });

  it("requires an explicit policy assessment for changed workflow rules", () => {
    const path = ".github/workflows/delivery.yml";
    const negative = record({ governance: true });
    negative.policyReview.preservesRequirements = false;
    expect(() =>
      verifyFinalDelivery(
        client({ path, reviews: [approval(negative)] }),
        target,
        now,
      ),
    ).toThrow(/existing requirements are preserved/i);
    const proof = client({
      path,
      reviews: [approval(record({ governance: true }))],
    });
    expect(verifyFinalDelivery(proof, target, now).scope.governance).toBe(true);
  });

  it.each([
    ["base", target.head],
    ["head", target.base],
    ["merge", target.head],
  ])("rejects an approval for a different %s", (key, newValue) => {
    const payload = record();
    payload.evidence[key] = newValue;
    expect(() =>
      validateReviewedEvidence(
        payload,
        target,
        { product: false, governance: false },
        run,
        now,
      ),
    ).toThrow(/different base, head, or merge preview/i);
  });

  it("rejects an expired receipt despite an unchanged delivery tuple", () => {
    const payload = record({ product: true });
    payload.evidence.installed.receipts[0].reviewBy = "2026-11-24T08:00:00Z";
    expect(() =>
      validateReviewedEvidence(
        payload,
        target,
        { product: true, governance: false },
        run,
        now,
      ),
    ).toThrow(/review-horizon-reached/);
  });

  it("requires reviewed revalidation when using historical receipts", () => {
    const payload = record({ product: true });
    const receipt = payload.evidence.installed.receipts[0];
    receipt.mode = "reuse";
    receipt.reviewBy = "2026-11-25T08:00:00Z";
    expect(() =>
      validateReviewedEvidence(
        payload,
        target,
        { product: true, governance: false },
        run,
        now,
      ),
    ).toThrow(/reviewed revalidation/i);
    receipt.revalidationSha256 = "6".repeat(64);
    receipt.revalidatedAt = "2026-11-24T07:00:00Z";
    expect(() =>
      validateReviewedEvidence(
        payload,
        target,
        { product: true, governance: false },
        run,
        now,
      ),
    ).not.toThrow();
    receipt.revalidatedAt = "2026-11-24T04:00:00Z";
    expect(() =>
      validateReviewedEvidence(
        payload,
        target,
        { product: true, governance: false },
        run,
        now,
      ),
    ).toThrow(/revalidation was not captured for this PR/i);
  });

  it("denies candidate installation from a different source tree", () => {
    const payload = record({ product: true });
    expect(() =>
      validateReviewedEvidence(
        payload,
        { ...target, mergeTree: "f".repeat(40) },
        { product: true, governance: false },
        run,
        now,
      ),
    ).toThrow(/exact candidate source tree/i);
  });

  it("does not let an old receipt claim fresh execution on this pull request", () => {
    const payload = record({ product: true });
    payload.evidence.installed.receipts[0].preparedAt = "2026-11-24T04:30:00Z";
    expect(() =>
      validateReviewedEvidence(
        payload,
        target,
        { product: true, governance: false },
        run,
        now,
      ),
    ).toThrow(/fresh evidence prepared for this PR/i);
  });

  it("refuses arbitrary text instead of a bounded evidence record", () => {
    expect(() => reviewPayload("approved")).toThrow(/JSON delivery record/);
    expect(reviewPayload("```json\n{}\n```")).toEqual({});
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
