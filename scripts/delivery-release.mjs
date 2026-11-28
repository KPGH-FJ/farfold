import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { DeliveryBlocked } from "./delivery-state.mjs";

export const releaseCheck = "Farfold release request";
export const releaseRequestAnchor = "33305b8a0d66f0bb841acb3dfdd659449c52e96a";
const sha = /^[0-9a-f]{40}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function pendingOperation(response, head) {
  return (
    response?.status === "pending" &&
    uuid.test(response.details?.uuid) &&
    response.details.expected_head_sha === head &&
    response.details.merge_method === "merge" &&
    response.details.merge_action === "direct_merge" &&
    (response.details.bypass_rules === undefined ||
      response.details.bypass_rules === true)
  );
}

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
      commitSha === expectedCommit,
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
  for (let attempt = 0; intent.uuid && attempt < 4; attempt++) {
    let status;
    try {
      status = await client.releaseApi(
        "GET",
        `pulls/${intent.pr}/merge-async/${intent.uuid}`,
      );
    } catch {
      // An unavailable operation cannot establish this request's outcome.
    }
    if (status?.status === "failed") {
      client.finishRelease(id, intent, "failure");
      return { decision: "release-rejected" };
    }
    if (status?.status === "merged") {
      assert.ok(
        sha.test(status.details?.sha),
        "GitHub did not identify the original operation's merge commit.",
      );
      const commit = confirmedMerge(
        client.api,
        intent,
        publisherSlug,
        status.details.sha,
      );
      if (commit) {
        client.finishRelease(id, intent, "success");
        return { decision: "merged", mergeCommit: commit };
      }
    } else if (status?.status === "pending") {
      assert.ok(
        pendingOperation(status, intent.head) &&
          status.details.uuid === intent.uuid,
        "GitHub returned a different pending release request.",
      );
    }
    if (attempt < 3) await delay(2000);
  }
  throw new DeliveryBlocked(
    "release-outcome-unknown",
    "Refresh this PR from main to reconcile the existing request. Do not resubmit the merge.",
  );
}

// All callers run in the same protected, repository-wide publisher queue.
export async function releaseDelivery(
  client,
  target,
  proof,
  serverUrl,
  recheck,
) {
  const pending = pendingRelease(client, target.base, target.repositoryId);
  if (pending) {
    throw new DeliveryBlocked(
      "release-outcome-unknown",
      `PR #${pending.intent.pr} already has an unresolved release request. Do not submit another merge.`,
    );
  }
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
  if (pendingOperation(response, intent.head)) {
    intent.uuid = response.details.uuid;
    client.updateRelease(id, intent);
  } else {
    throw new DeliveryBlocked(
      "release-outcome-unknown",
      "GitHub did not confirm the merge request identity. Do not resubmit the merge.",
    );
  }
  return reconcileRelease(client, { id, intent, publisherSlug });
}

export function pendingRelease(client, base, repositoryId) {
  assert.ok(sha.test(base), "The current protected base is missing.");
  const lookup = (status, filter) => {
    const response = client.api(
      `commits/${releaseRequestAnchor}/check-runs?check_name=${encodeURIComponent(releaseCheck)}&app_id=${client.publisherAppId}&status=${status}&filter=${filter}&per_page=100`,
    );
    const checks = response.check_runs;
    assert.ok(
      Array.isArray(checks) &&
        response.total_count === checks.length &&
        checks.length <= 1 &&
        checks.every((check) => check.status === status),
      "Release request history is incomplete or ambiguous.",
    );
    return checks[0];
  };
  // GitHub's latest filter uses completion time. An older completed check must
  // not hide an in-flight request, and GitHub can complete one as stale.
  const active = lookup("in_progress", "all");
  const check = active ?? lookup("completed", "latest");
  if (!check) return null;
  const intent = JSON.parse(check.output?.summary);
  assert.ok(
    check.name === releaseCheck &&
      check.app?.id === client.publisherAppId &&
      /^[a-z0-9-]+$/.test(check.app.slug ?? "") &&
      check.app.slug !== "github-actions" &&
      check.head_sha === releaseRequestAnchor &&
      Number.isSafeInteger(check.id) &&
      check.id > 0 &&
      intent.repositoryId === repositoryId &&
      Number.isSafeInteger(intent.pr) &&
      intent.pr > 0 &&
      [intent.base, intent.head, intent.preview, intent.tree].every((hash) =>
        sha.test(hash),
      ) &&
      /^[0-9a-f]{64}$/.test(intent.proofSha256) &&
      (intent.uuid === undefined || uuid.test(intent.uuid)),
    "Pending release record does not match the protected check or intent.",
  );
  if (intent.base !== base) {
    const ancestry = client.api(`compare/${intent.base}...${base}?per_page=1`);
    assert.ok(
      ancestry.base_commit?.sha === intent.base &&
        ancestry.merge_base_commit?.sha === intent.base &&
        ancestry.status === "ahead" &&
        Number.isSafeInteger(ancestry.ahead_by) &&
        ancestry.ahead_by > 0 &&
        ancestry.behind_by === 0,
      "The pending release base is not in the protected main history.",
    );
  }
  if (!active) {
    if (
      check.conclusion === "failure" ||
      (check.conclusion === "success" && intent.uuid)
    ) {
      return null;
    }
    throw new DeliveryBlocked(
      "release-outcome-unknown",
      `The last release check for PR #${intent.pr} does not confirm a terminal request outcome. Do not submit another merge.`,
    );
  }
  assert.equal(
    check.conclusion,
    null,
    "An in-flight release check already has a conclusion.",
  );
  return { id: check.id, intent, publisherSlug: check.app.slug };
}
