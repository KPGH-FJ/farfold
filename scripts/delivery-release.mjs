import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { DeliveryBlocked } from "./delivery-state.mjs";

export const releaseCheck = "Farfold release request";
const sha = /^[0-9a-f]{40}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function confirmedMerge(api, intent, publisherSlug, expectedCommit) {
  const pr = api(`pulls/${intent.pr}`);
  if (!pr.merged) return null;
  const commitSha = pr.merge_commit_sha;
  assert.ok(
    pr.number === intent.pr &&
      pr.base?.ref === "main" &&
      pr.base.repo?.id === intent.repositoryId &&
      pr.head?.sha === intent.head &&
      pr.merged_by?.login === publisherSlug + "[bot]" &&
      sha.test(commitSha) &&
      (!expectedCommit || commitSha === expectedCommit),
    "GitHub reported a different merge than the authorized request.",
  );
  const commit = api(`git/commits/${commitSha}`);
  assert.equal(
    commit.sha,
    commitSha,
    "GitHub did not return the reported merge commit.",
  );
  assert.deepEqual(
    commit.parents?.map((parent) => parent.sha),
    [intent.base, intent.head],
    "Merged parents differ from the authorized request.",
  );
  assert.equal(
    commit.tree?.sha,
    intent.tree,
    "Merged tree differs from the authorized preview.",
  );
  return commitSha;
}

export async function reconcileRelease(
  client,
  { id, intent, publisherSlug },
  delay = wait,
) {
  let status;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (intent.uuid) {
      try {
        status = await client.releaseApi(
          "GET",
          `pulls/${intent.pr}/merge-async/${intent.uuid}`,
        );
      } catch {
        // GitHub may no longer have the operation. A matching merged PR is
        // positive evidence; an open PR still leaves the outcome unknown.
        status = undefined;
      }
      if (status?.status === "failed") {
        client.finishRelease(id, intent, "failure");
        return { decision: "release-rejected" };
      }
    }
    const commit = confirmedMerge(
      client.api,
      intent,
      publisherSlug,
      status?.details?.sha,
    );
    if (commit) {
      client.finishRelease(id, intent, "success");
      return { decision: "merged", mergeCommit: commit };
    }
    if (attempt < 3 && intent.uuid) await delay(2000);
    else break;
  }
  throw new DeliveryBlocked(
    "release-outcome-unknown",
    "Refresh this PR from main to reconcile the existing request. Do not resubmit the merge.",
  );
}

// All callers run in the same protected, repository-wide publisher queue.
// Anchor the in-flight record to the current base so it also blocks other PRs.
export async function releaseDelivery(
  client,
  target,
  proof,
  serverUrl,
  recheck,
) {
  const intent = {
    repositoryId: target.repositoryId,
    pr: target.number,
    base: target.base,
    head: target.head,
    preview: target.merge,
    tree: target.mergeTree,
    proofSha256: proof.proofSha256,
  };
  const { id, publisherSlug } = client.startRelease(intent, serverUrl);
  try {
    recheck();
  } catch (error) {
    client.finishRelease(id, intent, "failure");
    throw error;
  }
  // Publishing the durable intent precedes the only dispatch. If the runner
  // dies after this point, an open PR alone cannot prove the request failed.
  const response = await client.releaseApi(
    "PUT",
    `pulls/${intent.pr}/merge-async`,
    {
      sha: intent.head,
      merge_method: "merge",
      merge_action: "direct_merge",
      // Only the App's update-only rule grants an exception. The separate PR
      // and required checks rules have no bypass actor.
      bypass_rules: true,
    },
  );
  if (response.status === "refused") {
    client.finishRelease(id, intent, "failure");
    throw new DeliveryBlocked(
      "release-rejected",
      `GitHub rejected this release with HTTP ${response.httpStatus}.`,
    );
  }
  if (
    response.status === "pending" &&
    uuid.test(response.details?.uuid) &&
    response.details.expected_head_sha === intent.head &&
    response.details.merge_method === "merge" &&
    response.details.merge_action === "direct_merge"
  ) {
    intent.uuid = response.details.uuid;
    client.updateRelease(id, intent);
  } else if (response.status !== "merged") {
    throw new Error("GitHub did not confirm the merge request identity.");
  }
  return reconcileRelease(client, { id, intent, publisherSlug });
}

export function pendingRelease(client, base, repositoryId) {
  const response = client.api(
    `commits/${base}/check-runs?check_name=${encodeURIComponent(releaseCheck)}&app_id=${client.publisherAppId}&status=in_progress&filter=all&per_page=100`,
  );
  assert.ok(
    Array.isArray(response.check_runs) &&
      response.total_count === response.check_runs.length &&
      response.total_count <= 1,
    "Release request history is incomplete or ambiguous.",
  );
  const [check] = response.check_runs;
  if (!check) return null;
  const intent = JSON.parse(check.output?.summary);
  assert.ok(
    check.name === releaseCheck &&
      check.app?.id === client.publisherAppId &&
      /^[a-z0-9-]+$/.test(check.app.slug ?? "") &&
      check.app.slug !== "github-actions" &&
      check.head_sha === base &&
      check.status === "in_progress" &&
      Number.isSafeInteger(check.id) &&
      intent.repositoryId === repositoryId &&
      Number.isSafeInteger(intent.pr) &&
      intent.pr > 0 &&
      intent.base === base &&
      [intent.head, intent.preview, intent.tree].every((hash) =>
        sha.test(hash),
      ) &&
      /^[0-9a-f]{64}$/.test(intent.proofSha256) &&
      (intent.uuid === undefined || uuid.test(intent.uuid)),
    "Pending release record does not match the protected base.",
  );
  return { id: check.id, intent, publisherSlug: check.app.slug };
}

// When the merge succeeded but the runner could not close the record, main
// already points elsewhere. The actual merge parents locate the old record.
export function pendingReleaseForMergedPr(client, number, repositoryId) {
  const pr = client.api(`pulls/${number}`);
  if (!pr.merged) return null;
  assert.ok(
    pr.number === number &&
      pr.base?.ref === "main" &&
      pr.base.repo?.id === repositoryId &&
      sha.test(pr.merge_commit_sha) &&
      sha.test(pr.head?.sha),
    "Merged PR does not identify a recoverable release.",
  );
  const commit = client.api(`git/commits/${pr.merge_commit_sha}`);
  assert.ok(
    commit.sha === pr.merge_commit_sha &&
      commit.parents?.length === 2 &&
      sha.test(commit.parents[0].sha) &&
      commit.parents[1].sha === pr.head.sha,
    "Merged PR does not have the expected merge parents.",
  );
  const pending = pendingRelease(client, commit.parents[0].sha, repositoryId);
  if (!pending) return null;
  assert.ok(
    pending.intent.pr === number && pending.intent.head === pr.head.sha,
    "The old base holds a different pending release.",
  );
  return pending;
}
