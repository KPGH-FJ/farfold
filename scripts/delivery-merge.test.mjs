import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeVerifiedDelivery } from "./delivery-merge.mjs";
import {
  deliveryProof,
  githubFinalReader,
  latestEngineeringRun,
  proofHash,
  publishedProof,
  targetFor,
  verifyFinalDelivery,
} from "./delivery-final.mjs";

vi.mock("./delivery-final.mjs", async (getActual) => ({
  ...(await getActual()),
  githubFinalReader: vi.fn(),
  latestEngineeringRun: vi.fn(),
  verifyFinalDelivery: vi.fn(),
  targetFor: vi.fn(),
  deliveryProof: vi.fn(),
}));

const base = "1".repeat(40),
  head = "2".repeat(40),
  merge = "3".repeat(40);
const actualMerge = "4".repeat(40);
const repo = "example/farfold",
  repository = { id: 10, full_name: repo, default_branch: "main" };
const target = { number: 12, base, head, merge, mergeTree: "5".repeat(40) };
const runUrl = `https://github.com/${repo}/actions/runs/71`;
const evidence = { installed: { required: true, receipts: [] } };
const verified = {
  scope: { product: true },
  runId: 52,
  runAttempt: 1,
  review: { reviewId: 82 },
  evidence: { evidenceId: 92, recordSha256: proofHash(evidence) },
};
const input = {
  ...target,
  prUrl: `https://github.com/${repo}/pull/12`,
  scope: verified.scope,
  engineeringRunId: 52,
  engineeringRunAttempt: 1,
  readEvidence: async () => evidence,
};

function fixture({
  checks = {},
  finalRun = {},
  dispatchFailure = false,
  watchFailure = false,
  conflictingMerge = false,
  dispatchId = 71,
  rotateKey = false,
} = {}) {
  let settingsReads = 0;
  const run = (args, options) => {
    if (args[1] === "repos/" + repo) return JSON.stringify(repository);
    if (args.includes("--slurp"))
      return JSON.stringify([
        {
          variables: [
            { name: "FARFOLD_FINAL_PUBLISHER_APP_ID", value: "121" },
            {
              name: "FARFOLD_PRIVATE_EVIDENCE_PUBLIC_KEY",
              value:
                rotateKey && settingsReads++ > 0
                  ? "rotated key"
                  : "fixture public key",
            },
          ],
        },
      ]);
    if (args.includes("POST")) {
      expect(JSON.parse(options.input)).toEqual({
        ref: "main",
        inputs: { pr_number: "12" },
      });
      if (dispatchFailure) throw new Error("dispatch failed");
      return JSON.stringify({ workflow_run_id: dispatchId, html_url: runUrl });
    }
    throw new Error("unexpected command");
  };
  const api = (path) => {
    if (path === "git/ref/heads/main") return { object: { sha: base } };
    if (path === "actions/runs/71")
      return {
        id: 71,
        run_attempt: 1,
        repository,
        event: "workflow_dispatch",
        path: ".github/workflows/delivery-final.yml",
        head_branch: "main",
        head_sha: base,
        status: "completed",
        conclusion: "success",
        ...finalRun,
      };
    if (path.includes("/check-runs?")) {
      const sha = path.split("/")[1];
      return {
        total_count: 1,
        check_runs: [
          {
            id: 42,
            head_sha: sha,
            name: "Farfold final delivery",
            app: { id: 121 },
            external_id: runUrl + "/attempts/1",
            status: "completed",
            conclusion: "success",
            output: {
              summary: JSON.stringify(publishedProof(target, verified)),
            },
            ...checks,
          },
        ],
      };
    }
    if (path === "pulls/12")
      return {
        merged: true,
        head: { sha: head },
        merge_commit_sha: actualMerge,
      };
    if (path === "git/commits/" + actualMerge)
      return {
        parents: [{ sha: base }, { sha: head }],
        tree: { sha: target.mergeTree },
      };
    throw new Error("unexpected read " + path);
  };
  githubFinalReader.mockReturnValue({ api, run });
  const mergeCalls = [];
  const execute = (_gh, args) => {
    if (args[0] === "run" && args[1] === "watch") {
      if (watchFailure)
        throw new Error("refresh failed before creating a check");
      return;
    }
    expect(args).toEqual([
      "pr",
      "merge",
      "12",
      "--repo",
      repo,
      "--merge",
      "--match-head-commit",
      head,
    ]);
    mergeCalls.push(args);
    if (conflictingMerge) throw new Error("response lost");
  };
  return { mergeCalls, run: () => mergeVerifiedDelivery(input, execute) };
}

beforeEach(() => {
  vi.resetAllMocks();
  targetFor.mockReturnValue(target);
  verifyFinalDelivery.mockReturnValue(verified);
  latestEngineeringRun.mockReturnValue({ id: 52, run_attempt: 1 });
  deliveryProof.mockReturnValue({
    review: verified.review,
    evidence: verified.evidence,
  });
});
describe("fresh final verification before ordinary merge", () => {
  it.each([
    ["reviewer key rotated", { rotateKey: true }],
    ["dispatch fails", { dispatchFailure: true }],
    ["dispatch response lacks an ID", { dispatchId: null }],
    [
      "publisher failed before it could replace cached success",
      { watchFailure: true },
    ],
    ["the verifier run failed", { finalRun: { conclusion: "failure" } }],
    ["rerun started", { finalRun: { run_attempt: 2 } }],
    [
      "published check is from an earlier run",
      { checks: { external_id: runUrl.replace("71", "70") + "/attempts/1" } },
    ],
    ["another App used the check name", { checks: { app: { id: 15368 } } }],
    [
      "the latest check was superseded or failed",
      { checks: { conclusion: "failure" } },
    ],
    [
      "the final decision does not bind the current evidence",
      { checks: { output: { summary: '{"decision":"verified"}' } } },
    ],
  ])("never sends a merge request when %s", async (_reason, condition) => {
    const f = fixture(condition);
    await expect(f.run()).rejects.toThrow();
    expect(f.mergeCalls).toHaveLength(0);
  });
  it("stops if the private witness disappears after the green decision", async () => {
    deliveryProof.mockImplementation(() => {
      throw new Error("witness revoked");
    });
    const f = fixture();
    await expect(f.run()).rejects.toThrow("witness revoked");
    expect(f.mergeCalls).toHaveLength(0);
  });
  it("rejects a superseding engineering attempt after the green decision", async () => {
    latestEngineeringRun.mockReturnValue({ id: 52, run_attempt: 2 });
    const f = fixture();
    await expect(f.run()).rejects.toThrow(/engineering attempt changed/);
    expect(f.mergeCalls).toHaveLength(0);
  });
  it("submits only the exact candidate after current proof and source checks", async () => {
    const f = fixture();
    await expect(f.run()).resolves.toMatchObject({
      decision: "merged",
      mergeCommit: actualMerge,
    });
    expect(f.mergeCalls).toHaveLength(1);
  });
  it("reads back the exact result if the merge response is lost", async () => {
    const f = fixture({ conflictingMerge: true });
    await expect(f.run()).resolves.toMatchObject({
      decision: "merged",
      mergeCommit: actualMerge,
    });
    expect(f.mergeCalls).toHaveLength(1);
  });
});
