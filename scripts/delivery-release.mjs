import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
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
  const journal = releaseJournal(client, target.base, target.repositoryId);
  if (journal.state === "pending") {
    throw new DeliveryBlocked(
      "release-outcome-unknown",
      `PR #${journal.intent.pr} already has an unresolved release request. Do not submit another merge.`,
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
  const { id, publisherSlug } = client.startRelease(intent, serverUrl, journal);
  assert.ok(
    id === journal.id && publisherSlug === journal.publisherSlug,
    "The written release request does not match the initialized journal.",
  );
  try {
    recheck();
  } catch (error) {
    client.finishRelease(id, intent, "failure");
    throw error;
  }
  const current = releaseJournal(client, target.base, target.repositoryId);
  requireJournal(
    current.id === id &&
      current.publisherSlug === publisherSlug &&
      current.state === "pending" &&
      isDeepStrictEqual(current.intent, intent),
    "The recorded release request changed before dispatch.",
  );
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

const journalFields = ["repositoryId", "schemaVersion", "state"];
const intentFields = [
  "base",
  "head",
  "pr",
  "preview",
  "proofSha256",
  "repositoryId",
  "tree",
];
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;

function requireJournal(condition, description) {
  if (!condition) {
    throw new DeliveryBlocked(
      "release-outcome-unknown",
      `${description} Recover the original release journal before requesting a merge.`,
    );
  }
}

function hasFields(value, fields) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

export function releaseJournal(client, base, repositoryId) {
  assert.ok(sha.test(base), "The current protected base is missing.");
  assert.ok(
    positiveId(repositoryId) && positiveId(client.publisherAppId),
    "The protected repository or publisher identity is missing.",
  );
  const response = client.api(
    `commits/${releaseRequestAnchor}/check-runs?check_name=${encodeURIComponent(releaseCheck)}&app_id=${client.publisherAppId}&filter=all&per_page=100`,
  );
  // A missing slot cannot prove that there has never been a merge request.
  requireJournal(
    response?.total_count === 1 &&
      response.check_runs?.length === 1 &&
      Array.isArray(response.check_runs),
    "The original release journal is missing or ambiguous.",
  );
  const [check] = response.check_runs;
  requireJournal(
    check?.name === releaseCheck &&
      check.app?.id === client.publisherAppId &&
      typeof check.app.slug === "string" &&
      /^[a-z0-9-]+$/.test(check.app.slug) &&
      check.app.slug !== "github-actions" &&
      check.head_sha === releaseRequestAnchor &&
      check.status === "completed" &&
      check.conclusion === "neutral" &&
      positiveId(check.id),
    "The release journal has an unexpected source or status.",
  );
  let payload;
  try {
    payload = JSON.parse(check.output?.summary);
  } catch {
    requireJournal(false, "The release journal is not valid JSON.");
  }
  requireJournal(
    payload?.schemaVersion === 1 && payload.repositoryId === repositoryId,
    "The release journal does not match the expected version or repository.",
  );
  const { state, intent, outcome } = payload;
  const {
    id,
    app: { slug: publisherSlug },
  } = check;
  if (state === "ready") {
    requireJournal(
      hasFields(payload, journalFields),
      "The initialized release journal is invalid.",
    );
    return { id, publisherSlug, state, intent: null };
  }
  const pending =
    state === "pending" && hasFields(payload, [...journalFields, "intent"]);
  const settled =
    state === "settled" &&
    hasFields(payload, [...journalFields, "intent", "outcome"]) &&
    (outcome === "failure" ||
      (outcome === "success" && typeof intent?.uuid === "string"));
  requireJournal(
    (pending || settled) &&
      hasFields(
        intent,
        intent?.uuid === undefined ? intentFields : [...intentFields, "uuid"],
      ) &&
      intent.repositoryId === repositoryId &&
      positiveId(intent.pr) &&
      [intent.base, intent.head, intent.preview, intent.tree].every(
        (hash) => typeof hash === "string" && sha.test(hash),
      ) &&
      typeof intent.proofSha256 === "string" &&
      /^[0-9a-f]{64}$/.test(intent.proofSha256) &&
      (intent.uuid === undefined ||
        (typeof intent.uuid === "string" && uuid.test(intent.uuid))),
    "The release journal contains an invalid request or outcome.",
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
  return { id, publisherSlug, state, intent };
}

export function pendingRelease(client, base, repositoryId) {
  const { id, publisherSlug, state, intent } = releaseJournal(
    client,
    base,
    repositoryId,
  );
  return state === "pending" ? { id, publisherSlug, intent } : null;
}
