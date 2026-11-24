import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { requiredAffectedCommands } from "./delivery-check.mjs";
import { classifyDeliveryPaths } from "./delivery-scope.mjs";

const sha = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;
const isDigest = (value) => typeof value === "string" && digest.test(value);
const workflowPath = ".github/workflows/delivery.yml";
const engineeringCheck = "Farfold delivery check";
export const finalCheck = "Farfold final delivery";
const approvedRoles = new Set(["write", "maintain", "admin"]);
const reviewStates = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

function hasKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

const text = (value, min = 12, max = 1600) =>
  typeof value === "string" &&
  value.trim().length >= min &&
  value.length <= max;

function date(value) {
  assert.ok(
    typeof value === "string" &&
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/.test(
        value,
      ) &&
      Number.isFinite(Date.parse(value)),
    "Installed receipt timestamp is invalid.",
  );
  return Date.parse(value);
}

function sameTuple(left, right) {
  return (
    left.base === right.base &&
    left.head === right.head &&
    left.merge === right.merge
  );
}

export function reviewPayload(body) {
  assert.ok(
    typeof body === "string" && Buffer.byteLength(body) <= 12000,
    "Independent approval needs a bounded delivery record.",
  );
  const fenced = body.trim().match(/^```json\s*([\s\S]+?)\s*```$/i);
  try {
    return JSON.parse(fenced?.[1] ?? body);
  } catch {
    throw new Error(
      "Independent approval must contain one JSON delivery record.",
    );
  }
}

export function validateReviewedEvidence(
  record,
  target,
  scope,
  run,
  now,
  reviewedAt = now,
) {
  assert.ok(
    hasKeys(record, [
      "schemaVersion",
      "evidence",
      "engineeringRunId",
      "engineeringRunAttempt",
      "reviewSummary",
      "scopeReasons",
      "policyReview",
      "originalsId",
    ]) &&
      record.schemaVersion === 1 &&
      text(record.reviewSummary) &&
      typeof record.originalsId === "string" &&
      /^[A-Za-z0-9_-]{8,100}$/.test(record.originalsId),
    "Independent approval needs an exact record, substantive review summary, and an opaque originals ID.",
  );
  assert.ok(
    record.engineeringRunId === run.id &&
      record.engineeringRunAttempt === run.run_attempt,
    "Independent approval belongs to a different engineering run or attempt.",
  );
  const { evidence, scopeReasons, policyReview } = record;
  assert.ok(
    hasKeys(evidence, ["base", "head", "merge", "stable", "installed"]) &&
      sameTuple(evidence, target),
    "Independent approval belongs to a different base, head, or merge preview.",
  );
  assert.ok(
    hasKeys(scopeReasons, ["stable", "installed"]) &&
      (scope.product
        ? scopeReasons.stable === null && scopeReasons.installed === null
        : text(scopeReasons.stable) && text(scopeReasons.installed)),
    "Record why stable and installed checks do not apply, or provide both for this product change.",
  );
  assert.ok(
    scope.governance
      ? hasKeys(policyReview, ["preservesRequirements", "assessment"]) &&
          policyReview.preservesRequirements === true &&
          text(policyReview.assessment, 30)
      : policyReview === null,
    "Changes to delivery governance need an independent assessment that existing requirements are preserved.",
  );
  const { stable, installed } = evidence;
  assert.ok(
    hasKeys(stable, ["required", "sha256"]) &&
      stable.required === scope.product &&
      (scope.product ? isDigest(stable.sha256) : stable.sha256 === null),
    "Affected product changes need a reviewed stable-check report.",
  );
  assert.ok(
    hasKeys(installed, ["required", "receipts"]) &&
      installed.required === scope.product &&
      Array.isArray(installed.receipts) &&
      installed.receipts.length <= 20 &&
      (!scope.product || installed.receipts.length > 0),
    "Affected product changes need reviewed installed evidence.",
  );
  for (const receipt of installed.receipts) {
    assert.ok(
      hasKeys(receipt, [
        "mode",
        "receiptSha256",
        "manifestSha256",
        "productCommit",
        "binarySha256",
        "requirementIds",
        "preparedAt",
        "finishedAt",
        "reviewBy",
        "revalidationSha256",
        "revalidatedAt",
        "buildSha256",
        "sourceTree",
      ]) &&
        isDigest(receipt.receiptSha256) &&
        isDigest(receipt.manifestSha256) &&
        isDigest(receipt.binarySha256) &&
        text(receipt.productCommit, 1, 128) &&
        Array.isArray(receipt.requirementIds) &&
        receipt.requirementIds.length > 0 &&
        receipt.requirementIds.length <= 50 &&
        receipt.requirementIds.every(
          (id) => typeof id === "string" && /^[A-Z][A-Z0-9-]{1,30}$/.test(id),
        ) &&
        new Set(receipt.requirementIds).size === receipt.requirementIds.length,
      "Installed evidence summary is incomplete.",
    );
    const preparedAt = date(receipt.preparedAt);
    const finishedAt = date(receipt.finishedAt);
    assert.ok(
      preparedAt <= finishedAt && finishedAt <= now && finishedAt <= reviewedAt,
      "Installed evidence timing is inconsistent or later than the approval.",
    );
    if (receipt.reviewBy !== null) {
      const reviewBy = date(receipt.reviewBy);
      assert.ok(
        reviewBy > finishedAt && now < reviewBy,
        "Installed evidence has expired (review-horizon-reached).",
      );
    }
    assert.ok(
      (receipt.mode === "fresh" &&
        receipt.revalidationSha256 === null &&
        receipt.revalidatedAt === null &&
        preparedAt >= date(target.createdAt)) ||
        (receipt.mode === "reuse" &&
          receipt.reviewBy !== null &&
          isDigest(receipt.revalidationSha256) &&
          receipt.revalidatedAt !== null),
      "Use fresh evidence prepared for this PR, or provide reviewed revalidation and an unexpired horizon for historical evidence.",
    );
    if (receipt.mode === "reuse") {
      const revalidatedAt = date(receipt.revalidatedAt);
      assert.ok(
        revalidatedAt >= Math.max(date(target.createdAt), finishedAt) &&
          revalidatedAt <= Math.min(now, reviewedAt),
        "Historical evidence revalidation was not captured for this PR before the approving review.",
      );
    }
    if (
      scope.product ||
      receipt.buildSha256 !== null ||
      receipt.sourceTree !== null
    ) {
      const sourceTree =
        receipt.productCommit === target.head
          ? target.headTree
          : receipt.productCommit === target.merge
            ? target.mergeTree
            : null;
      assert.ok(
        isDigest(receipt.buildSha256) &&
          typeof receipt.sourceTree === "string" &&
          sha.test(receipt.sourceTree) &&
          receipt.sourceTree === sourceTree &&
          receipt.sourceTree === target.mergeTree,
        "Installed evidence must identify the reviewed build and exact candidate source tree.",
      );
    }
  }
}

function githubClient(repo) {
  function run(args, options = {}) {
    try {
      return execFileSync("gh", args, {
        stdio: [
          options.input === undefined ? "ignore" : "pipe",
          "pipe",
          "ignore",
        ],
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        timeout: 30000,
        ...options,
      });
    } catch {
      throw new Error(
        "GitHub API request failed or exceeded its bounded response.",
      );
    }
  }
  return {
    api(path) {
      try {
        return JSON.parse(
          run(["api", `repos/${repo}/${path}`], { encoding: "utf8" }),
        );
      } catch {
        throw new Error("Could not read verified data from the GitHub API.");
      }
    },
    report(artifact) {
      const bytes = run(
        ["api", `repos/${repo}/actions/artifacts/${artifact.id}/zip`],
        { maxBuffer: 96 * 1024 },
      );
      assert.equal(
        artifact.digest,
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        "Engineering artifact archive digest does not match GitHub metadata.",
      );
      const directory = mkdtempSync(join(tmpdir(), "farfold-final-"));
      try {
        const archive = join(directory, "report.zip");
        writeFileSync(archive, bytes, { mode: 0o600 });
        const unzip = (flag, ...rest) =>
          execFileSync("unzip", [flag, archive, ...rest], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            maxBuffer: 64 * 1024,
            timeout: 5000,
          });
        assert.ok(
          unzip("-Z1").trim() === "delivery-checks.json",
          "Unexpected engineering artifact contents.",
        );
        return JSON.parse(unzip("-p", "delivery-checks.json"));
      } catch {
        throw new Error(
          "Engineering artifact is not a bounded, standalone JSON report.",
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    startCheck(target, serverUrl) {
      assert.ok(
        sha.test(target),
        "Refusing to publish a check without an exact commit.",
      );
      const created = JSON.parse(
        run(
          [
            "api",
            "--method",
            "POST",
            `repos/${repo}/check-runs`,
            "--input",
            "-",
          ],
          {
            input: JSON.stringify({
              name: finalCheck,
              head_sha: target,
              status: "in_progress",
              details_url: serverUrl,
            }),
          },
        ),
      );
      assert.ok(
        Number.isSafeInteger(created.id) &&
          created.head_sha === target &&
          created.name === finalCheck &&
          created.app?.slug === "github-actions",
        "GitHub did not issue the final check for the exact preview from GitHub Actions.",
      );
      return created.id;
    },
    finishCheck(checkId, conclusion, summary) {
      run(
        [
          "api",
          "--method",
          "PATCH",
          `repos/${repo}/check-runs/${checkId}`,
          "--input",
          "-",
        ],
        {
          input: JSON.stringify({
            status: "completed",
            conclusion,
            output: { title: finalCheck, summary },
          }),
        },
      );
    },
  };
}

function pages(api, path, maxPages) {
  const result = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = api(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    assert.ok(
      Array.isArray(batch),
      "GitHub pagination did not return the expected records.",
    );
    result.push(...batch);
    if (batch.length < 100) return result;
  }
  throw new Error(
    "GitHub result exceeds the safely verifiable pagination limit.",
  );
}

export function targetFor(api, pr, trustedBase, repositoryId) {
  const pull = api(`pulls/${pr}`);
  const { base, head, merge_commit_sha: merge } = pull;
  assert.ok(
    pull.number === pr &&
      pull.state === "open" &&
      !pull.draft &&
      base?.ref === "main" &&
      base.repo?.id === repositoryId &&
      base.sha === trustedBase &&
      sha.test(head?.sha ?? "") &&
      sha.test(merge ?? "") &&
      pull.mergeable !== false &&
      Number.isSafeInteger(head.repo?.id) &&
      Number.isSafeInteger(pull.user?.id),
    "Expected an open, ready PR with a current trusted main and GitHub merge preview.",
  );
  const integration = api(`git/commits/${merge}`);
  const headCommit = api(`git/commits/${head.sha}`);
  assert.ok(
    integration.sha === merge &&
      integration.parents?.length === 2 &&
      integration.parents[0].sha === base.sha &&
      integration.parents[1].sha === head.sha &&
      headCommit.sha === head.sha &&
      sha.test(integration.tree?.sha ?? "") &&
      sha.test(headCommit.tree?.sha ?? ""),
    "Current merge preview or candidate tree does not match the base and head.",
  );
  return {
    number: pr,
    base: base.sha,
    head: head.sha,
    merge,
    headRepo: head.repo.id,
    headTree: headCommit.tree.sha,
    mergeTree: integration.tree.sha,
    author: pull.user.id,
    createdAt: pull.created_at,
    commits: pull.commits,
    repositoryId,
  };
}

function latestEngineeringRun(api, target) {
  const currentWorkflow = api("actions/workflows/delivery.yml");
  const runList = api(
    `actions/workflows/delivery.yml/runs?event=pull_request&head_sha=${target.head}&per_page=100`,
  );
  const run = runList.workflow_runs.find(
    (entry) =>
      entry.workflow_id === currentWorkflow.id &&
      entry.path === workflowPath &&
      entry.event === "pull_request" &&
      entry.repository?.id === target.repositoryId &&
      entry.head_repository?.id === target.headRepo &&
      entry.head_sha === target.head &&
      entry.pull_requests?.some(({ number }) => number === target.number),
  );
  assert.ok(
    Number.isSafeInteger(run?.id) &&
      Number.isSafeInteger(run?.run_attempt) &&
      run.status === "completed" &&
      run.conclusion === "success",
    "Current PR needs a successful engineering workflow attempt.",
  );
  return run;
}

function engineeringProof(client, target, scope) {
  const { api } = client;
  const run = latestEngineeringRun(api, target);
  const jobList = api(
    `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
  );
  assert.ok(
    jobList.jobs.some(
      ({ name, head_sha, status, conclusion }) =>
        name === engineeringCheck &&
        head_sha === target.head &&
        status === "completed" &&
        conclusion === "success",
    ),
    "Matching engineering aggregate job did not pass.",
  );
  const artifactList = api(`actions/runs/${run.id}/artifacts?per_page=100`);
  const matches = artifactList.artifacts.filter(
    ({ name }) => name === `delivery-checks-${run.run_attempt}`,
  );
  const [artifact] = matches;
  assert.ok(
    matches.length === 1 &&
      Number.isSafeInteger(artifact.id) &&
      artifact.workflow_run?.id === run.id &&
      artifact.expired === false &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= 64 * 1024 &&
      typeof artifact.digest === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(artifact.digest),
    "Engineering attempt must have one current bounded report artifact.",
  );
  const report = client.report(artifact);
  assert.ok(
    report.mode === "affected" &&
      report.head === target.merge &&
      report.base === target.base &&
      report.inputsStable === true &&
      Array.isArray(report.results) &&
      report.results.length > 0 &&
      report.results.every(({ exitCode }) => exitCode === 0),
    "Engineering report did not pass on this exact merge preview and base.",
  );
  const commands = new Set(
    report.results.map(({ command }) => JSON.stringify(command)),
  );
  assert.ok(
    requiredAffectedCommands(scope, target.base, target.merge).every(
      (command) => commands.has(JSON.stringify(command)),
    ),
    "Engineering report omitted a required affected-scope check.",
  );
  return run;
}

function currentReviews(api, target) {
  // Candidate attribution uses linked GitHub accounts, not names or emails
  // from the commit object. GitHub's own web-flow signer is not a candidate author.
  const commits = pages(api, `pulls/${target.number}/commits`, 3);
  assert.ok(
    commits.length === target.commits && commits.length > 0,
    "GitHub did not provide the complete candidate commit list.",
  );
  const authors = new Set([
    target.author,
    ...commits
      .flatMap(({ author, committer }) => [
        author?.id,
        committer?.login !== "web-flow" ? committer?.id : null,
      ])
      .filter(Number.isSafeInteger),
  ]);
  const latest = new Map();
  for (const review of pages(api, `pulls/${target.number}/reviews`, 11)) {
    const user = review.user;
    if (
      !reviewStates.has(review.state) ||
      user?.type !== "User" ||
      !Number.isSafeInteger(user.id) ||
      !/^[A-Za-z0-9-]{1,39}$/.test(user.login ?? "") ||
      authors.has(user.id) ||
      !["OWNER", "MEMBER", "COLLABORATOR"].includes(review.author_association)
    )
      continue;
    const previous = latest.get(user.id);
    if (!previous || previous.id < review.id) latest.set(user.id, review);
  }
  return [...latest.values()].filter(({ user }) => {
    const permission = api(`collaborators/${user.login}/permission`);
    return (
      permission.user?.id === user.id &&
      (approvedRoles.has(permission.role_name) ||
        approvedRoles.has(permission.permission))
    );
  });
}

function inspectScope(api, target) {
  // Scope the exact tested tree against its current parent, not the PR's
  // displayed merge-base diff. GitHub caps the compare file list at 300 even
  // when commit pagination is available.
  const comparison = api(`compare/${target.base}...${target.merge}`);
  const { files } = comparison;
  assert.ok(
    comparison.base_commit?.sha === target.base &&
      comparison.merge_base_commit?.sha === target.base &&
      Array.isArray(files) &&
      files.length > 0 &&
      files.length < 300,
    "GitHub did not provide a complete exact merge-preview file list.",
  );
  const paths = files.flatMap(({ filename, previous_filename, status }) => {
    assert.ok(
      typeof filename === "string" &&
        filename.length > 0 &&
        (!["renamed", "copied"].includes(status) ||
          (typeof previous_filename === "string" &&
            previous_filename.length > 0)),
      "GitHub change did not include all required file paths.",
    );
    return previous_filename ? [filename, previous_filename] : [filename];
  });
  return classifyDeliveryPaths(paths);
}

function independentReview(api, target, scope, run, now) {
  const reviews = currentReviews(api, target);
  assert.ok(
    !reviews.some(({ state }) => state === "CHANGES_REQUESTED"),
    "An authorized independent reviewer has requested changes.",
  );
  const approvals = reviews.filter(
    ({ state, commit_id }) => state === "APPROVED" && commit_id === target.head,
  );
  assert.ok(
    approvals.length > 0,
    scope.product
      ? "Current product changes need independent approval and reviewed stable and installed evidence."
      : "Current candidate needs an authorized independent GitHub approving review.",
  );
  let reason;
  for (const approval of approvals) {
    try {
      const reviewedAt = date(approval.submitted_at);
      assert.ok(
        reviewedAt <= now,
        "Independent approval timestamp is in the future.",
      );
      validateReviewedEvidence(
        reviewPayload(approval.body),
        target,
        scope,
        run,
        now,
        reviewedAt,
      );
      return approval.id;
    } catch (error) {
      reason = error;
    }
  }
  throw reason;
}

export function verifyFinalDelivery(client, target, now = Date.now()) {
  const scope = inspectScope(client.api, target);
  const run = engineeringProof(client, target, scope);
  const reviewId = independentReview(client.api, target, scope, run, now);
  return { scope, runId: run.id, runAttempt: run.run_attempt, reviewId };
}

function requestedPr(eventName, event) {
  if (eventName === "workflow_dispatch") {
    const raw = event.inputs?.pr_number;
    assert.ok(
      typeof raw === "string" && /^[1-9][0-9]*$/.test(raw),
      "Supply the pull request number.",
    );
    const number = Number(raw);
    assert.ok(
      Number.isSafeInteger(number),
      "Pull request number is outside range.",
    );
    return number;
  }
  const run = event.workflow_run;
  if (run?.event !== "pull_request" || run.path !== workflowPath) return null;
  const linked = run.pull_requests ?? [];
  if (linked.length !== 1 || !Number.isSafeInteger(linked[0].number))
    return null;
  return linked[0].number;
}

function main(env) {
  assert.ok(
    env.GITHUB_REF === "refs/heads/main" &&
      sha.test(env.GITHUB_SHA ?? "") &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? "") &&
      ["workflow_dispatch", "workflow_run"].includes(env.GITHUB_EVENT_NAME) &&
      /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? ""),
    "Final delivery must run from the trusted default branch.",
  );
  const {
    GITHUB_REPOSITORY: repo,
    GITHUB_SHA: base,
    GITHUB_RUN_ID: runId,
    GITHUB_EVENT_NAME: eventName,
  } = env;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const number = requestedPr(eventName, event);
  if (!number) {
    console.log(
      "No uniquely associated PR. Use workflow_dispatch from main for a specific PR.",
    );
    return;
  }
  assert.ok(
    Number.isSafeInteger(event.repository?.id),
    "GitHub event lacks the verified repository identity.",
  );
  const client = githubClient(repo);
  const snapshot = () =>
    targetFor(client.api, number, base, event.repository.id);
  const serverUrl = `https://github.com/${repo}/actions/runs/${runId}`;
  const target = snapshot();
  const check = client.startCheck(target.merge, serverUrl);
  try {
    const result = verifyFinalDelivery(client, target);
    assert.ok(
      sameTuple(target, snapshot()),
      "The PR changed during final verification.",
    );
    const branch = client.api("git/ref/heads/main");
    assert.ok(
      branch.object?.sha === base,
      "main changed during final verification.",
    );
    const currentRun = latestEngineeringRun(client.api, target);
    assert.ok(
      currentRun.id === result.runId &&
        currentRun.run_attempt === result.runAttempt,
      "Engineering workflow changed during final verification.",
    );
    assert.equal(
      independentReview(
        client.api,
        target,
        result.scope,
        currentRun,
        Date.now(),
      ),
      result.reviewId,
      "Independent approval changed during final verification.",
    );
    client.finishCheck(
      check,
      "success",
      "Current engineering result and independent evidence verified.",
    );
    console.log(
      JSON.stringify({
        decision: "verified",
        target: target.merge,
        pr: number,
        ...result,
      }),
    );
  } catch (error) {
    client.finishCheck(
      check,
      "failure",
      "Final delivery requirements are not satisfied. See workflow log.",
    );
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main(process.env);
  } catch (error) {
    console.error(
      error instanceof SyntaxError || error instanceof TypeError
        ? "Final delivery evidence or GitHub metadata is malformed."
        : error.message,
    );
    process.exitCode = 1;
  }
}
