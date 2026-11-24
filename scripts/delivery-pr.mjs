import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReceipt } from "./acceptance-receipts.mjs";
import { stableChecks } from "./delivery-check.mjs";

const checkName = "Farfold delivery check";
const sha = /^[a-f0-9]{40}$/;
const jsonFile = (file) => JSON.parse(readFileSync(file, "utf8"));

function reviewedJson(file, expectedDigest) {
  const bytes = readFileSync(file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, expectedDigest, "Reviewed record bytes changed.");
  return JSON.parse(bytes);
}

function gh(...args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

async function main([number, recordPath, ...extra]) {
  assert.ok(
    /^[1-9]\d*$/.test(number ?? "") && recordPath && !extra.length,
    "Use delivery-pr.mjs <PR number> <delivery-record.json> from the repository root.",
  );
  const record = jsonFile(recordPath);
  const { base, head, review, installed, stable } = record;
  assert.ok(
    sha.test(base ?? "") && sha.test(head ?? ""),
    "A delivery record needs full base and head SHAs.",
  );
  assert.ok(
    review?.verdict === "approved" &&
      review.base === base &&
      review.head === head &&
      review.reviewer?.trim() &&
      review.summary?.trim(),
    "An independent review of this exact base and head must be recorded.",
  );
  assert.ok(
    typeof stable?.required === "boolean" && stable.reason?.trim(),
    "Record why the stable checks apply or do not apply.",
  );
  assert.ok(
    typeof installed?.required === "boolean" &&
      installed.reason?.trim() &&
      Array.isArray(installed.receipts),
    "Record the scope of the installed-app verification.",
  );
  assert.ok(
    !installed.required || installed.receipts.length > 0,
    "Applicable installed verification needs receipt paths.",
  );
  if (stable.required) {
    const report = reviewedJson(stable.report, stable.sha256);
    assert.ok(
      report.mode === "stable" &&
        report.platform === "darwin-arm64" &&
        report.inputsStable &&
        report.head === head &&
        report.results?.every(({ exitCode }) => exitCode === 0),
      "Applicable stable checks must pass on the reviewed candidate.",
    );
    assert.deepEqual(
      report.results.map(({ command }) => command),
      stableChecks,
      "Stable check command list changed.",
    );
  }

  const pr = gh(
    "pr",
    "view",
    number,
    "--json",
    "url,state,isDraft,baseRefName,baseRefOid,headRefOid,potentialMergeCommit,mergeable,reviewDecision",
  );
  assert.ok(
    pr.state === "OPEN" && !pr.isDraft && pr.baseRefName === "main",
    "Expected an open, ready PR targeting main.",
  );
  assert.ok(
    pr.baseRefOid === base && pr.headRefOid === head,
    "PR base or head changed after review.",
  );
  assert.ok(
    pr.mergeable === "MERGEABLE" && pr.reviewDecision !== "CHANGES_REQUESTED",
    "PR cannot be merged or has requested changes.",
  );
  const merge = pr.potentialMergeCommit?.oid;
  assert.ok(
    sha.test(merge ?? ""),
    "GitHub has not published a candidate merge commit.",
  );
  const integration = gh("api", `repos/{owner}/{repo}/commits/${merge}`);
  assert.deepEqual(
    integration.parents.map(({ sha }) => sha),
    [base, head],
    "GitHub tested merge parents differ from the reviewed base and head.",
  );
  for (const entry of installed.receipts) {
    const receipt = reviewedJson(entry.path, entry.sha256);
    const report = await validateReceipt(receipt);
    assert.ok(
      report.allExpectedOutcomesMatched &&
        report.cases.every(({ level }) =>
          ["installed", "real-agent"].includes(level),
        ),
      "Installed verification requires matching installed observations.",
    );
    assert.ok(
      Array.isArray(entry.requirementIds) &&
        entry.requirementIds.length &&
        entry.requirementIds.every((requirement) =>
          report.cases.some(({ requirementIds }) =>
            requirementIds.includes(requirement),
          ),
        ),
      "Installed receipt requirements differ from the reviewed scope.",
    );
    assert.ok(
      receipt.attempts.every(
        ({ context }) =>
          context.productCommit === entry.productCommit &&
          context.app.binarySha256 === entry.binarySha256,
      ),
      "Installed receipt identity differs from the reviewed build.",
    );
    if (installed.required)
      assert.ok(
        [head, merge].includes(entry.productCommit),
        "Applicable installation evidence must identify a build of this candidate.",
      );
  }

  const { workflow_runs: runs } = gh(
    "api",
    `repos/{owner}/{repo}/actions/workflows/delivery.yml/runs?event=pull_request&head_sha=${head}&per_page=30`,
  );
  // The run's nested PR refs can be refreshed by GitHub. The per-attempt
  // artifact below preserves the base and synthetic merge actually tested.
  const run = runs.find(
    (item) =>
      item.head_sha === head &&
      item.path === ".github/workflows/delivery.yml" &&
      item.pull_requests.some(
        (candidate) => candidate.number === Number(number),
      ),
  );
  assert.ok(
    run?.conclusion === "success",
    "A successful delivery workflow run for this PR and base is required.",
  );
  const { jobs } = gh(
    "api",
    `repos/{owner}/{repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
  );
  const check = jobs.find(
    (item) => item.name === checkName && item.head_sha === head,
  );
  assert.ok(
    check?.status === "completed" && check.conclusion === "success",
    "The delivery check did not pass for this run.",
  );
  const directory = mkdtempSync(join(tmpdir(), "farfold-delivery-"));
  try {
    execFileSync("gh", [
      "run",
      "download",
      String(run.id),
      "--name",
      `delivery-checks-${run.run_attempt}`,
      "--dir",
      directory,
    ]);
    const report = jsonFile(join(directory, "delivery-checks.json"));
    assert.ok(
      report.mode === "affected" &&
        report.head === merge &&
        report.base === base &&
        report.inputsStable &&
        report.results?.length &&
        report.results.every(({ exitCode }) => exitCode === 0),
      "The CI report does not match the current synthetic merge commit and base.",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const branch = gh("api", "repos/{owner}/{repo}/branches/main");
  assert.equal(
    branch.commit.sha,
    base,
    "main changed. Review the new base and recheck.",
  );
  console.log(
    JSON.stringify(
      {
        pr: pr.url,
        base,
        head,
        testedMerge: merge,
        check: check.html_url,
        branchProtected: branch.protected,
        decision: "record-and-checks-current",
      },
      null,
      2,
    ),
  );
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
