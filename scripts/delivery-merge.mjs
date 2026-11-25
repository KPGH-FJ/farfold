import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  deliveryProof,
  finalCheck,
  githubFinalReader,
  latestEngineeringRun,
  proofHash,
  publishedProof,
  targetFor,
  verifyFinalDelivery,
} from "./delivery-final.mjs";

const workflow = "delivery-final.yml";
const publisherEnvironment = "farfold-final-publisher";
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;

export async function mergeVerifiedDelivery(input, execute = execFileSync) {
  const { number, base, head, merge, scope, readEvidence } = input;
  const url = new URL(input.prUrl);
  const match = /^\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(url.pathname);
  assert.ok(
    url.origin === "https://github.com" && Number(match?.[2]) === number,
    "The local delivery record did not identify a GitHub PR.",
  );
  const repo = match[1];
  const client = githubFinalReader(repo, process.env, execute);
  const { api, run } = client;
  const repository = JSON.parse(run(["api", "repos/" + repo]));
  assert.ok(
    repository.full_name === repo &&
      positiveId(repository.id) &&
      repository.default_branch === "main",
    "Expected the PR repository with main as its default branch.",
  );
  const readSettings = () => {
    const setting = "FARFOLD_PRIVATE_EVIDENCE_PUBLIC_KEY";
    const variables = JSON.parse(
      run([
        "api",
        "--paginate",
        "--slurp",
        `repos/${repo}/environments/${publisherEnvironment}/variables?per_page=100`,
      ]),
    );
    const variable = (name) =>
      variables
        .flatMap((page) => page.variables)
        .find((item) => item.name === name)?.value;
    const appId = Number(variable("FARFOLD_FINAL_PUBLISHER_APP_ID"));
    assert.ok(
      positiveId(appId) && appId !== 15368,
      "A dedicated publisher App is required.",
    );
    let publicKey;
    if (scope.product || scope.governance) {
      publicKey =
        variable(setting) ?? api("actions/variables/" + setting).value;
      assert.ok(publicKey?.trim(), "Missing trusted evidence public key.");
    }
    return { appId, publicKey };
  };
  const settings = readSettings();
  const { appId } = settings;
  client.publicKey = settings.publicKey;
  const snapshot = () => {
    const current = targetFor(api, number, base, repository.id);
    assert.ok(
      current.head === head &&
        current.merge === merge &&
        api("git/ref/heads/main").object?.sha === base,
      "The base, head or preview changed.",
    );
    return current;
  };
  snapshot();
  const dispatch = JSON.parse(
    run(
      [
        "api",
        "--method",
        "POST",
        "-H",
        "X-GitHub-Api-Version: 2026-03-10",
        `repos/${repo}/actions/workflows/${workflow}/dispatches`,
        "--input",
        "-",
      ],
      {
        input: JSON.stringify({
          ref: "main",
          inputs: { pr_number: String(number) },
        }),
      },
    ),
  );
  const id = dispatch.workflow_run_id;
  const runUrl = `https://github.com/${repo}/actions/runs/${id}`;
  assert.ok(
    positiveId(id) && dispatch.html_url === runUrl,
    "GitHub did not identify the dispatched final run.",
  );
  // A new dispatch starts at attempt 1. A retry is a separate evaluation.
  const attemptUrl = runUrl + "/attempts/1";
  execute(
    "gh",
    ["run", "watch", String(id), "--repo", repo, "--compact", "--exit-status"],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  const finalRun = () => {
    const current = api("actions/runs/" + id);
    assert.ok(
      current.id === id &&
        current.run_attempt === 1 &&
        current.repository?.id === repository.id &&
        current.event === "workflow_dispatch" &&
        current.path === ".github/workflows/" + workflow &&
        current.head_branch === "main" &&
        current.head_sha === base &&
        current.status === "completed" &&
        current.conclusion === "success",
      "The requested final run and attempt did not successfully finish on the trusted base.",
    );
  };
  finalRun();
  const target = snapshot();
  const local = await readEvidence();
  const verified = verifyFinalDelivery(client, target);
  assert.ok(
    verified.runId === input.engineeringRunId &&
      verified.runAttempt === input.engineeringRunAttempt,
    "The locally verified engineering attempt changed.",
  );
  if (verified.evidence)
    assert.equal(
      verified.evidence.recordSha256,
      proofHash(local),
      "The signed evidence differs from the current local evidence.",
    );
  const expected = publishedProof(target, verified);
  // filter=latest excludes superseded checks. Another run, an earlier success, or
  // another App with the same name cannot stand in for this dispatch.
  for (const sha of new Set([head, merge])) {
    const path = `commits/${sha}/check-runs?check_name=${encodeURIComponent(finalCheck)}&app_id=${appId}&filter=latest&per_page=100`;
    const response = api(path);
    assert.ok(
      response.total_count === 1 && response.check_runs?.length === 1,
      "Missing or ambiguous current final check.",
    );
    const [check] = response.check_runs;
    assert.ok(
      positiveId(check.id) &&
        check.name === finalCheck &&
        check.app?.id === appId &&
        check.head_sha === sha &&
        check.external_id === attemptUrl &&
        check.status === "completed" &&
        check.conclusion === "success",
      "The latest final check is not this successful publisher attempt.",
    );
    assert.deepEqual(
      JSON.parse(check.output?.summary),
      expected,
      "The published final decision differs from current verification.",
    );
  }

  assert.deepEqual(
    readSettings(),
    settings,
    "Publisher or evidence key changed before merge.",
  );
  const currentTarget = snapshot();
  const currentRun = latestEngineeringRun(api, currentTarget);
  assert.ok(
    currentRun.id === verified.runId &&
      currentRun.run_attempt === verified.runAttempt,
    "The engineering attempt changed before merge.",
  );
  finalRun();
  assert.deepEqual(
    deliveryProof(
      client,
      currentTarget,
      verified.scope,
      currentRun,
      Date.now(),
    ),
    { review: verified.review, evidence: verified.evidence },
    "The review or evidence changed before merge.",
  );

  // GitHub atomically compares head; the remaining inputs were observed just
  // before this request. On a lost response, read the outcome before any retry.
  let mergeError;
  try {
    execute(
      "gh",
      [
        "pr",
        "merge",
        String(number),
        "--repo",
        repo,
        "--merge",
        "--match-head-commit",
        head,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    mergeError = error;
  }
  const merged = api("pulls/" + number);
  assert.ok(
    merged.merged === true &&
      merged.head?.sha === head &&
      /^[0-9a-f]{40}$/.test(merged.merge_commit_sha),
    mergeError
      ? "GitHub did not confirm the merge after the request failed. Check the PR before retrying."
      : "The merge request returned without a confirmed merge. Check the PR before retrying.",
  );
  const commit = api("git/commits/" + merged.merge_commit_sha);
  assert.deepEqual(
    commit.parents.map((parent) => parent.sha),
    [base, head],
    "The merged parents differ from the verified target.",
  );
  assert.equal(
    commit.tree?.sha,
    target.mergeTree,
    "The merged tree differs from the verified preview.",
  );
  return {
    decision: "merged",
    pr: input.prUrl,
    base,
    head,
    preview: merge,
    mergeCommit: merged.merge_commit_sha,
    publisherAppId: appId,
    finalRun: attemptUrl,
    engineeringRunId: verified.runId,
    engineeringRunAttempt: verified.runAttempt,
  };
}
