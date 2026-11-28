import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  requiredAffectedCommands,
  requiredWindowsAffectedCommands,
  windowsAffectedTests,
} from "./delivery-check.mjs";
import {
  codexReviewEditCurrent,
  codexReviewEvent,
  codexReviewProof,
  pullRequestComments,
} from "./delivery-codex-review.mjs";
import { canonicalJson } from "./acceptance-receipts.mjs";
import { verifyDeliveryPrivateAttestation } from "./delivery-private-attestation.mjs";
import { verifyDeliveryMainRules } from "./delivery-main-rules.mjs";
import { classifyDeliveryPaths } from "./delivery-scope.mjs";
import { DeliveryBlocked, DeliveryWaiting } from "./delivery-state.mjs";
import {
  pendingRelease,
  reconcileRelease,
  releaseCheck,
  releaseRequestAnchor,
  releaseDelivery,
} from "./delivery-release.mjs";

const sha = /^[0-9a-f]{40}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const workflowPath = ".github/workflows/delivery.yml";
const engineeringCheck = "Farfold delivery check";
const windowsCheck = "Windows affected engineering checks";
const actionsAppId = 15368;
export const finalCheck = "Farfold final delivery";
const privateProofMarker = "<!-- farfold-private-delivery:v1 -->";
const witnessSnapshot = `query($node: ID!) {
  node(id: $node) {
    __typename
    ... on IssueComment {
      id fullDatabaseId body createdAt updatedAt lastEditedAt
      author { __typename ... on User { databaseId } }
      userContentEdits(first: 3) {
        totalCount
        pageInfo { hasNextPage }
        nodes { editedAt deletedAt editor { __typename ... on User { databaseId } } }
      }
    }
  }
}`;

function sameTuple(left, right) {
  return (
    left.base === right.base &&
    left.head === right.head &&
    left.merge === right.merge
  );
}

export function privateEvidenceFor(
  comments,
  target,
  scope,
  run,
  now,
  publicKey,
  graphql,
) {
  if (!scope.product && !scope.governance) return null;
  if (typeof publicKey !== "string" || !publicKey.trim()) {
    throw new DeliveryBlocked(
      "missing-configuration",
      "Applicable private evidence or policy assessment needs a configured trusted custodian key.",
    );
  }
  const witnesses = comments.filter(
    (comment) =>
      comment.author_association === "OWNER" &&
      comment.user?.type === "User" &&
      Number.isSafeInteger(comment.id) &&
      typeof comment.body === "string" &&
      comment.body.startsWith(privateProofMarker + "\n"),
  );
  const [witness] = witnesses;
  assert.ok(
    witnesses.length === 1 && Buffer.byteLength(witness.body) <= 24000,
    "Applicable private evidence or policy assessment needs exactly one authenticated custodian record.",
  );
  const raw = witness.body.slice(privateProofMarker.length).trim();
  const fenced = raw.match(/^```json\s*([\s\S]+?)\s*```$/i);
  let envelope;
  try {
    envelope = JSON.parse(fenced?.[1] ?? raw);
  } catch {
    throw new Error("Private custodian record is not a bounded JSON envelope.");
  }
  const verified = verifyDeliveryPrivateAttestation(envelope, {
    publicKey,
    target,
    scope,
    run,
    now,
    witnessId: witness.id,
  });
  // GitHub records the original body and the new body after the first edit.
  // A signed comment is single-use. Any further edit requires a fresh signed ID.
  assert.ok(
    /^[A-Za-z0-9_+/=-]{3,180}$/.test(witness.node_id ?? ""),
    "Private evidence comment lacks a verifiable node identity.",
  );
  const node = graphql(witnessSnapshot, witness.node_id)?.data?.node;
  const history = node?.userContentEdits;
  const owner = (actor) =>
    actor?.__typename === "User" && actor.databaseId === witness.user.id;
  assert.ok(
    node?.__typename === "IssueComment" &&
      node.id === witness.node_id &&
      node.fullDatabaseId === String(witness.id) &&
      node.body === witness.body &&
      node.createdAt === witness.created_at &&
      node.updatedAt === witness.updated_at &&
      owner(node.author) &&
      history?.totalCount === 2 &&
      history.pageInfo?.hasNextPage === false &&
      history.nodes?.length === 2 &&
      typeof node.lastEditedAt === "string" &&
      history.nodes[0]?.editedAt === node.lastEditedAt &&
      history.nodes[1]?.editedAt === node.createdAt &&
      history.nodes.every(
        (edit) => edit?.deletedAt === null && owner(edit.editor),
      ),
    "Private evidence comment was edited again or its one-time publication could not be verified.",
  );
  return {
    evidenceId: witness.id,
    evidenceDigest: createHash("sha256")
      .update(JSON.stringify(envelope))
      .digest("hex"),
    executionId: verified.executionId,
    recordSha256: proofHash(envelope.claim.evidence),
  };
}

function githubReader(repo, readEnv, execute = execFileSync) {
  function run(args, options = {}) {
    try {
      return execute("gh", args, {
        env: readEnv,
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
    run,
    api(path) {
      try {
        return JSON.parse(
          run(["api", `repos/${repo}/${path}`], { encoding: "utf8" }),
        );
      } catch {
        throw new Error("Could not read verified data from the GitHub API.");
      }
    },
    graphql(query, node) {
      try {
        const response = JSON.parse(
          run(
            ["api", "graphql", "-f", `query=${query}`, "-f", `node=${node}`],
            {
              encoding: "utf8",
            },
          ),
        );
        assert.ok(!response.errors);
        return response;
      } catch {
        throw new Error(
          "Could not authenticate the current comment editor through GitHub GraphQL.",
        );
      }
    },
  };
}

export function githubFinalReader(repo, readEnv, execute = execFileSync) {
  const reader = githubReader(repo, readEnv, execute);
  const { run } = reader;
  const archiveEnv = { ...readEnv };
  delete archiveEnv.GH_TOKEN;
  delete archiveEnv.GITHUB_TOKEN;
  return {
    ...reader,
    report(artifact, entry) {
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
          execute("unzip", [flag, archive, ...rest], {
            env: archiveEnv,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            maxBuffer: 64 * 1024,
            timeout: 5000,
          });
        assert.ok(
          unzip("-Z1").trim() === entry,
          "Unexpected engineering artifact contents.",
        );
        return JSON.parse(unzip("-p", entry));
      } catch {
        throw new Error(
          "Engineering artifact is not a bounded, standalone JSON report.",
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

export function proofHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function publishedProof(target, result) {
  return {
    decision: "verified",
    pr: target.number,
    base: target.base,
    head: target.head,
    merge: target.merge,
    engineeringRunId: result.runId,
    engineeringRunAttempt: result.runAttempt,
    proofSha256: proofHash(result),
  };
}

function configuredPublisherAppId(env) {
  const raw = env.FARFOLD_FINAL_PUBLISHER_APP_ID ?? "";
  const id = Number(raw);
  if (
    !/^[1-9][0-9]*$/.test(raw) ||
    !Number.isSafeInteger(id) ||
    id === actionsAppId
  ) {
    throw new DeliveryBlocked(
      "missing-configuration",
      "A dedicated final-publisher App ID is required.",
    );
  }
  return id;
}

export function githubClient(
  repo,
  env,
  execute = execFileSync,
  request = fetch,
) {
  const readEnv = { ...env };
  const publisherToken = readEnv.FARFOLD_FINAL_PUBLISHER_TOKEN;
  const releaseToken = readEnv.FARFOLD_FINAL_RELEASE_TOKEN;
  delete readEnv.FARFOLD_FINAL_PUBLISHER_TOKEN;
  delete readEnv.FARFOLD_FINAL_RELEASE_TOKEN;
  const publisherAppId = configuredPublisherAppId(env);
  if (!(
    typeof publisherToken === "string" &&
    publisherToken.trim() &&
    publisherToken !== readEnv.GH_TOKEN
  )) {
    throw new DeliveryBlocked(
      "missing-configuration",
      "A dedicated final-publisher App ID and installation token are required.",
    );
  }
  const reader = githubFinalReader(repo, readEnv, execute);
  const { run } = reader;
  const writeEnv = { ...readEnv, GH_TOKEN: publisherToken };
  const publishedHeads = new Map();
  let release;
  let submitted = false;

  function writeCheck(method, path, body) {
    return JSON.parse(
      run(
        [
          "api",
          "--method",
          method,
          `repos/${repo}/check-runs${path}`,
          "--input",
          "-",
        ],
        {
          env: writeEnv,
          input: JSON.stringify(body),
          encoding: "utf8",
        },
      ),
    );
  }
  function assertPublishedCheck(check, head, status, name = finalCheck) {
    assert.ok(
      Number.isSafeInteger(check?.id) &&
        check.id > 0 &&
        check.head_sha === head &&
        check.name === name &&
        check.status === status &&
        check.app?.id === publisherAppId &&
        check.app.slug !== "github-actions",
      "GitHub did not return the exact final check from the configured publisher App.",
    );
  }
  const readerWithApp = { ...reader, publisherAppId };
  function saveRelease(id, intent, outcome, serverUrl) {
    const record = {
      schemaVersion: 1,
      repositoryId: intent.repositoryId,
      state: outcome === null ? "pending" : "settled",
      intent,
      ...(outcome === null ? {} : { outcome }),
    };
    const updated = writeCheck("PATCH", `/${id}`, {
      status: "completed",
      conclusion: "neutral",
      ...(serverUrl ? { details_url: serverUrl, external_id: serverUrl } : {}),
      output: { title: releaseCheck, summary: JSON.stringify(record) },
    });
    assertPublishedCheck(
      updated,
      releaseRequestAnchor,
      "completed",
      releaseCheck,
    );
    assert.equal(updated.id, id);
    assert.equal(updated.conclusion, "neutral");
    assert.deepEqual(JSON.parse(updated.output?.summary), record);
  }
  return {
    publisherAppId,
    ...reader,
    authorizeRelease(plan) {
      assert.ok(
        !release &&
          Number.isSafeInteger(plan.pr) &&
          plan.pr > 0 &&
          ((plan.mode === "release" && plan.uuid === undefined) ||
            (plan.mode === "reconcile" && uuid.test(plan.uuid))),
      );
      assert.ok(
        typeof releaseToken === "string" &&
          releaseToken.trim() &&
          releaseToken !== publisherToken &&
          releaseToken !== readEnv.GH_TOKEN,
        "The protected release needs a distinct, short-lived write credential.",
      );
      release = { ...plan };
    },
    async releaseApi(method, path, body) {
      const endpoint = `pulls/${release?.pr}/merge-async`;
      if (method === "PUT") {
        assert.ok(
          release?.mode === "release" && !submitted && path === endpoint,
          "The prepared release does not authorize this merge request.",
        );
        submitted = true;
      } else {
        assert.ok(
          method === "GET" &&
            release?.uuid &&
            path === `${endpoint}/${release.uuid}`,
          "The prepared release does not authorize this merge readback.",
        );
      }
      let response;
      try {
        response = await request(
          `https://api.github.com/repos/${repo}/${path}`,
          {
            method,
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${releaseToken}`,
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": "2026-03-10",
            },
            redirect: "error",
            signal: AbortSignal.timeout(15000),
            ...(body ? { body: JSON.stringify(body) } : {}),
          },
        );
      } catch {
        throw new DeliveryBlocked(
          "release-outcome-unknown",
          "Could not confirm the response from GitHub.",
        );
      }
      if (
        method === "PUT" &&
        [400, 401, 403, 404, 422].includes(response.status)
      ) {
        return { status: "refused", httpStatus: response.status };
      }
      if (!response.ok) {
        throw new DeliveryBlocked(
          "release-outcome-unknown",
          `GitHub returned HTTP ${response.status} for release.`,
        );
      }
      const result = await response.json();
      if (
        method === "PUT" &&
        result.status === "pending" &&
        uuid.test(result.details?.uuid)
      ) {
        release.uuid = result.details.uuid;
      }
      return result;
    },
    startRelease(intent, serverUrl, journal) {
      saveRelease(journal.id, intent, null, serverUrl);
      const stored = pendingRelease(
        readerWithApp,
        intent.base,
        intent.repositoryId,
      );
      assert.equal(
        stored?.id,
        journal.id,
        "Could not read back the protected release intent.",
      );
      assert.deepEqual(stored.intent, intent);
      return stored;
    },
    updateRelease(id, intent) {
      saveRelease(id, intent, null);
    },
    finishRelease(id, intent, conclusion) {
      saveRelease(id, intent, conclusion);
    },
    startCheck(target, serverUrl) {
      assert.ok(
        sha.test(target),
        "Refusing to publish a check without an exact commit.",
      );
      const created = writeCheck("POST", "", {
        name: finalCheck,
        head_sha: target,
        status: "in_progress",
        details_url: serverUrl,
        external_id: serverUrl,
      });
      assertPublishedCheck(created, target, "in_progress");
      assert.ok(
        !publishedHeads.has(created.id),
        "GitHub returned a duplicate final check ID.",
      );
      publishedHeads.set(created.id, target);
      return created.id;
    },
    finishCheck(checkId, conclusion, summary) {
      const head = publishedHeads.get(checkId);
      assert.ok(head, "Cannot update a check this publisher did not create.");
      const status = conclusion === null ? "in_progress" : "completed";
      const updated = writeCheck("PATCH", `/${checkId}`, {
        status,
        ...(conclusion === null ? {} : { conclusion }),
        output: { title: finalCheck, summary },
      });
      assertPublishedCheck(updated, head, status);
      assert.ok(
        updated.id === checkId && updated.conclusion === conclusion,
        "GitHub did not confirm the requested final check result.",
      );
    },
  };
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
    previewCreatedAt: integration.committer?.date,
    repositoryId,
  };
}

export function latestEngineeringRun(api, target, announcedRun) {
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
  if (
    !run ||
    (announcedRun?.id === run?.id &&
      run.run_attempt < announcedRun.run_attempt) ||
    ["queued", "in_progress", "requested", "waiting", "pending"].includes(
      run.status,
    )
  ) {
    throw new DeliveryWaiting(
      "waiting-engineering",
      "Current PR needs a successful engineering workflow attempt. A matching attempt has not completed.",
    );
  }
  if (
    !Number.isSafeInteger(run.id) ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new DeliveryBlocked(
      "engineering-rejected",
      "Current PR needs a successful engineering workflow attempt. The matching attempt did not succeed.",
    );
  }
  return run;
}

function engineeringProof(client, target, scope) {
  const { api } = client;
  const run = latestEngineeringRun(api, target, client.announcedRun);
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
  const affected = engineeringArtifact(
    client,
    artifactList,
    run,
    target,
    "delivery-checks",
    "affected",
  );
  const commands = new Set(
    affected.results.map(({ command }) => JSON.stringify(command)),
  );
  assert.ok(
    requiredAffectedCommands(scope, target.base, target.merge).every(
      (command) => commands.has(JSON.stringify(command)),
    ),
    "Engineering report omitted a required affected-scope check.",
  );
  if (scope.windowsNative) {
    assert.ok(
      jobList.jobs.some(
        ({ name, head_sha, status, conclusion }) =>
          name === windowsCheck &&
          head_sha === target.head &&
          status === "completed" &&
          conclusion === "success",
      ),
      "Affected Windows engineering job did not pass.",
    );
    const report = engineeringArtifact(
      client,
      artifactList,
      run,
      target,
      "delivery-windows",
      "affected-windows",
    );
    assert.ok(
      report.platform === "win32-x64" &&
        JSON.stringify(report.results.map(({ command }) => command)) ===
          JSON.stringify(
            requiredWindowsAffectedCommands(target.base, target.merge),
          ) &&
        report.results.every(
          ({ signal, error }) => signal === null && error === null,
        ) &&
        Array.isArray(report.tests) &&
        report.tests.length === windowsAffectedTests.length &&
        report.tests.every(
          ({ name, passed, failed, ignored }, i) =>
            name === windowsAffectedTests[i] &&
            passed === 1 &&
            failed === 0 &&
            ignored === 0,
        ),
      "Windows engineering report omitted required native commands or test outcomes.",
    );
  }
  return run;
}

function engineeringArtifact(client, artifactList, run, target, name, mode) {
  const matches = artifactList.artifacts.filter(
    ({ name: label }) => label === `${name}-${run.run_attempt}`,
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
    "Engineering attempt must have one current bounded report artifact for each affected platform.",
  );
  const report = client.report(artifact, `${name}.json`);
  assert.ok(
    report.mode === mode &&
      report.head === target.merge &&
      report.base === target.base &&
      report.inputsStable === true &&
      Array.isArray(report.results) &&
      report.results.length > 0 &&
      report.results.every(({ exitCode }) => exitCode === 0),
    "Engineering report did not pass on this exact merge preview and base.",
  );
  return report;
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

export function deliveryProof(client, target, scope, run, now) {
  const comments = pullRequestComments(client.api, target.number);
  const review = codexReviewProof(
    client.api,
    client.graphql,
    comments,
    target,
    run,
    now,
  );
  try {
    const evidence = privateEvidenceFor(
      comments,
      target,
      scope,
      run,
      now,
      client.publicKey,
      client.graphql,
    );
    return { review, evidence };
  } catch (error) {
    if (error instanceof DeliveryBlocked) throw error;
    throw new DeliveryBlocked("evidence-rejected", deliveryReason(error));
  }
}

export function verifyFinalDelivery(client, target, now = Date.now()) {
  const scope = inspectScope(client.api, target);
  const run = engineeringProof(client, target, scope);
  const proof = deliveryProof(client, target, scope, run, now);
  return { scope, runId: run.id, runAttempt: run.run_attempt, ...proof };
}

function requestedPr(eventName, event, confirmCurrentReview) {
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
  if (eventName === "issue_comment") {
    const privateUpdate =
      Number.isSafeInteger(event.issue?.number) &&
      event.issue?.pull_request != null &&
      ["created", "edited", "deleted"].includes(event.action) &&
      event.comment?.author_association === "OWNER" &&
      [event.comment?.body, event.changes?.body?.from].some(
        (body) =>
          typeof body === "string" &&
          body.startsWith(privateProofMarker + "\n"),
      );
    return codexReviewEvent(event, confirmCurrentReview) || privateUpdate
      ? event.issue.number
      : null;
  }
  const run = event.workflow_run;
  if (run?.event !== "pull_request" || run.path !== workflowPath) return null;
  if (event.action === "in_progress" && !(run.run_attempt > 1)) return null;
  const linked = run.pull_requests ?? [];
  if (linked.length !== 1 || !Number.isSafeInteger(linked[0].number))
    return null;
  return linked[0].number;
}

function deliveryReason(error) {
  return error instanceof SyntaxError || error instanceof TypeError
    ? "Final delivery evidence or GitHub metadata is malformed."
    : error.message;
}

function blockedDecision(error) {
  return {
    decision: error instanceof DeliveryBlocked ? error.state : "rejected",
    reason: deliveryReason(error),
  };
}

export function publishFinalDelivery(client, target, serverUrl, verifyCurrent) {
  // GitHub needs a check on the PR head as well as the reviewed merge preview.
  // Mark the head pending first and complete it last, after verifying both SHAs.
  const checks = [client.startCheck(target.head, serverUrl)];
  try {
    checks.push(client.startCheck(target.merge, serverUrl));
    const result = verifyCurrent();
    for (const check of checks.toReversed()) {
      client.finishCheck(
        check,
        "success",
        JSON.stringify(publishedProof(target, result)),
      );
    }
    return result;
  } catch (error) {
    const { decision, reason } = blockedDecision(error);
    for (const check of checks) {
      try {
        client.finishCheck(
          check,
          error instanceof DeliveryWaiting ? null : "failure",
          `${decision}: ${reason}`,
        );
      } catch {
        console.error("Could not update the final delivery check on GitHub.");
      }
    }
    throw error;
  }
}

export function prepareReleasePlan({
  ownerDispatch,
  number,
  releaseProof,
  pending,
  verifyRelease,
}) {
  if (!ownerDispatch) return null;
  if (pending) {
    return !releaseProof &&
      pending.intent.pr === number &&
      uuid.test(pending.intent.uuid)
      ? { mode: "reconcile", binding: proofHash(pending) }
      : null;
  }
  if (!releaseProof) return null;
  verifyRelease();
  return { mode: "release", binding: releaseProof };
}

function matchesReleasePlan(env, plan) {
  return (
    plan &&
    env.FARFOLD_RELEASE_MODE === plan.mode &&
    env.FARFOLD_RELEASE_BINDING === plan.binding
  );
}

async function main(env, phase) {
  assert.ok(
    env.GITHUB_REF === "refs/heads/main" &&
      sha.test(env.GITHUB_SHA ?? "") &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? "") &&
      ["workflow_dispatch", "workflow_run", "issue_comment"].includes(
        env.GITHUB_EVENT_NAME,
      ) &&
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
  const routeOnly = phase === "--route";
  const prepare = phase === "--prepare-release";
  const confirmCurrentReview = routeOnly
    ? (comment) => codexReviewEditCurrent(githubReader(repo, env), comment)
    : undefined;
  const number = requestedPr(eventName, event, confirmCurrentReview);
  if (!number) {
    let reason = "no-associated-pr";
    if (eventName === "issue_comment")
      reason = "no-effective-review-or-evidence-change";
    if (
      eventName === "workflow_run" &&
      event.action === "in_progress" &&
      event.workflow_run?.run_attempt === 1 &&
      event.workflow_run?.pull_requests?.length === 1
    )
      reason = "initial-engineering-attempt-in-progress";
    console.log(JSON.stringify({ decision: "not-run", reason }));
    return;
  }
  assert.ok(
    Number.isSafeInteger(event.repository?.id),
    "GitHub event lacks the verified repository identity.",
  );
  if (routeOnly) {
    appendFileSync(env.GITHUB_OUTPUT, `pr_number=${number}\n`);
    return;
  }
  assert.ok(
    env.FARFOLD_DELIVERY_PR_NUMBER === String(number),
    "Final delivery did not receive the routed pull request number.",
  );
  const releaseProof =
    eventName === "workflow_dispatch" ? event.inputs?.release_proof : "";
  const ownerDispatch =
    eventName === "workflow_dispatch" &&
    Number.isSafeInteger(event.repository.owner?.id) &&
    event.sender?.id === event.repository.owner.id &&
    env.GITHUB_RUN_ATTEMPT === "1";
  if (releaseProof) {
    assert.ok(
      /^[0-9a-f]{64}$/.test(releaseProof) && ownerDispatch,
      "Release requires an exact proof digest and a repository-owner dispatch.",
    );
  }
  const client = {
    ...(prepare
      ? {
          ...githubFinalReader(repo, env),
          publisherAppId: configuredPublisherAppId(env),
        }
      : githubClient(repo, env)),
    publicKey: env.FARFOLD_PRIVATE_EVIDENCE_PUBLIC_KEY,
    announcedRun: eventName === "workflow_run" ? event.workflow_run : undefined,
  };
  const snapshot = () =>
    targetFor(client.api, number, base, event.repository.id);
  assert.ok(
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? ""),
    "Missing publisher run attempt.",
  );
  const serverUrl = `https://github.com/${repo}/actions/runs/${runId}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
  function verifyCurrent(target) {
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
    const currentRun = latestEngineeringRun(
      client.api,
      target,
      client.announcedRun,
    );
    assert.ok(
      currentRun.id === result.runId &&
        currentRun.run_attempt === result.runAttempt,
      "Engineering workflow changed during final verification.",
    );
    const current = deliveryProof(
      client,
      target,
      result.scope,
      currentRun,
      Date.now(),
    );
    assert.ok(
      current.review.reviewDigest === result.review.reviewDigest &&
        current.evidence?.evidenceId === result.evidence?.evidenceId &&
        current.evidence?.evidenceDigest === result.evidence?.evidenceDigest,
      "Independent review or private evidence changed during final verification.",
    );
    return result;
  }
  let pending;
  let journalError;
  try {
    pending = pendingRelease(client, base, event.repository.id);
  } catch (error) {
    journalError = error;
  }
  if (prepare) {
    if (journalError) {
      console.log(JSON.stringify(blockedDecision(journalError)));
      return;
    }
    try {
      const plan = prepareReleasePlan({
        ownerDispatch,
        number,
        releaseProof,
        pending,
        verifyRelease() {
          const target = snapshot();
          assert.equal(
            proofHash(publishedProof(target, verifyCurrent(target))),
            releaseProof,
            "Current proof differs from the requested release.",
          );
          verifyDeliveryMainRules(client.api, repo, client.publisherAppId);
        },
      });
      if (plan)
        appendFileSync(
          env.GITHUB_OUTPUT,
          `mode=${plan.mode}\nbinding=${plan.binding}\n`,
        );
    } catch (error) {
      console.log(JSON.stringify(blockedDecision(error)));
    }
    return;
  }
  if (pending) {
    const plan = prepareReleasePlan({
      ownerDispatch,
      number,
      releaseProof,
      pending,
    });
    if (matchesReleasePlan(env, plan)) {
      client.authorizeRelease({
        mode: "reconcile",
        pr: number,
        uuid: pending.intent.uuid,
      });
      try {
        const outcome = await reconcileRelease(client, pending);
        console.log(JSON.stringify({ pr: number, ...outcome }));
        if (outcome.decision === "merged") return;
      } catch (error) {
        journalError = error;
      }
    } else {
      journalError = new DeliveryBlocked(
        "release-outcome-unknown",
        `PR #${pending.intent.pr} may still have a release in flight. Refresh that PR from main without sending a new release.`,
      );
    }
  }
  const target = snapshot();
  const binding = {
    base,
    candidate: target.head,
    target: target.merge,
    pr: number,
    publisherAppId: client.publisherAppId,
  };
  try {
    const result = publishFinalDelivery(client, target, serverUrl, () => {
      const verified = verifyCurrent(target);
      if (journalError) throw journalError;
      return verified;
    });
    console.log(
      JSON.stringify({ decision: "verified", ...binding, ...result }),
    );
    if (!releaseProof) return;

    try {
      const proof = publishedProof(target, result);
      assert.equal(
        proofHash(proof),
        releaseProof,
        "Current proof differs from the requested release.",
      );
      assert.ok(
        ownerDispatch &&
          matchesReleasePlan(env, { mode: "release", binding: releaseProof }),
        "This workflow did not prepare an authorized release for the current proof.",
      );
      client.authorizeRelease({ mode: "release", pr: number });
      const outcome = await releaseDelivery(
        client,
        target,
        proof,
        serverUrl,
        () => {
          assert.deepEqual(
            publishedProof(target, verifyCurrent(target)),
            proof,
            "Independent review, evidence, or engineering checks changed before release.",
          );
          verifyDeliveryMainRules(client.api, repo, client.publisherAppId);
        },
      );
      if (outcome.decision !== "merged") {
        throw new DeliveryBlocked(
          "release-rejected",
          "GitHub rejected the recorded merge request.",
        );
      }
      console.log(JSON.stringify({ ...binding, ...outcome }));
    } catch (error) {
      // Retire the earlier check pair even when the journal or rules fail
      // the final read. The journal still governs any in-flight request.
      try {
        publishFinalDelivery(client, target, serverUrl, () => {
          throw error;
        });
      } catch (publicationError) {
        if (publicationError !== error)
          console.error("Could not republish the blocked release.");
      }
      throw error;
    }
  } catch (error) {
    console.log(JSON.stringify({ ...blockedDecision(error), ...binding }));
    if (!(error instanceof DeliveryWaiting)) process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main(process.env, process.argv[2]);
  } catch (error) {
    console.error(JSON.stringify(blockedDecision(error)));
    process.exitCode = 1;
  }
}
