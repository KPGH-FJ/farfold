import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateLocalDeliveryRecord } from "./delivery-evidence.mjs";
import { classifyDeliveryPaths } from "./delivery-scope.mjs";
import { requiredAffectedCommands } from "./delivery-check.mjs";

const checkName = "Farfold delivery check";
const sha = /^[a-f0-9]{40}$/;
const jsonFile = (file) => JSON.parse(readFileSync(file, "utf8"));

function gh(...args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

async function main([number, recordPath, ...extra]) {
  assert.ok(
    /^[1-9]\d*$/.test(number ?? "") && recordPath && !extra.length,
    "Use delivery-pr.mjs <PR number> <delivery-record.json> from the repository root.",
  );
  const record = jsonFile(recordPath);
  const { base, head } = record;
  assert.ok(
    sha.test(base ?? "") && sha.test(head ?? ""),
    "A delivery record needs full base and head SHAs.",
  );
  const pr = gh(
    "pr",
    "view",
    number,
    "--json",
    "url,state,isDraft,baseRefName,baseRefOid,headRefOid,potentialMergeCommit,mergeable,reviewDecision,createdAt",
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
  const comparison = gh(
    "api",
    `repos/{owner}/{repo}/compare/${base}...${merge}`,
  );
  const { files } = comparison;
  // GitHub truncates compare file lists at 300. Refuse ambiguous scope rather
  // than silently omitting the applicable evidence requirements.
  assert.ok(
    comparison.base_commit?.sha === base &&
      comparison.merge_base_commit?.sha === base &&
      Array.isArray(files) &&
      files.length > 0 &&
      files.length < 300,
    "Could not determine the complete candidate scope from GitHub.",
  );
  const paths = files.flatMap(
    ({ filename, previous_filename: previous, status }) => {
      assert.ok(
        typeof filename === "string" &&
          filename.length > 0 &&
          (!["renamed", "copied"].includes(status) ||
            (typeof previous === "string" && previous.length > 0)),
        "GitHub change did not include all required file paths.",
      );
      return previous ? [filename, previous] : [filename];
    },
  );
  const scope = classifyDeliveryPaths(paths);
  const receipts = record.installed?.receipts;
  const sourceTrees =
    scope.product ||
    (Array.isArray(receipts) && receipts.some((entry) => entry?.build))
      ? {
          [merge]: integration.commit?.tree?.sha,
          [head]: gh("api", `repos/{owner}/{repo}/commits/${head}`).commit?.tree
            ?.sha,
        }
      : {};
  const evidence = await validateLocalDeliveryRecord(record, {
    base,
    head,
    merge,
    scope: { stable: scope.product, installed: scope.product },
    sourceTrees,
    freshSince: pr.createdAt,
  });

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
        Array.isArray(report.results) &&
        report.results.every(({ exitCode }) => exitCode === 0),
      "The CI report does not match the current synthetic merge commit and base.",
    );
    assert.ok(
      requiredAffectedCommands(scope, base, merge).every((command) =>
        report.results.some(
          (result) =>
            JSON.stringify(result.command) === JSON.stringify(command),
        ),
      ),
      "The CI report does not include all checks required for this scope.",
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
        engineeringRunId: run.id,
        engineeringRunAttempt: run.run_attempt,
        evidence,
        scope,
        decision: "local-evidence-verified",
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
