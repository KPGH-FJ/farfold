import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DeliveryWaiting } from "./delivery-state.mjs";

export const codexReviewBotId = 199175422;
const summaryMarker = "<!-- codex-pull-request-review-summary -->";
const stateMarker = /^<!-- codex-review-state:v1 (\{.+\}) -->$/;
const reviewRow = /^\| 📝 \*\*Code Review\*\* \|/;
const commentSnapshot = `query($node: ID!) {
  node(id: $node) {
    __typename
    ... on IssueComment {
      id fullDatabaseId body createdAt updatedAt lastEditedAt
      author { __typename login ... on Bot { databaseId } }
      editor { __typename login ... on Bot { databaseId } }
      userContentEdits(first: 100) {
        totalCount
        pageInfo { hasNextPage }
        nodes { editedAt deletedAt editor { __typename login ... on Bot { databaseId } } }
      }
    }
  }
}`;

export function codexReviewEvent(event) {
  const comment = event.comment;
  if (
    !Number.isSafeInteger(event.issue?.number) ||
    event.issue?.pull_request == null ||
    !["created", "edited", "deleted"].includes(event.action) ||
    comment?.user?.id !== codexReviewBotId ||
    comment.user.type !== "Bot"
  )
    return false;
  if (
    event.action !== "edited" ||
    !restCodexBot(comment.user) ||
    !restCodexBot(event.sender) ||
    !Number.isSafeInteger(comment.id) ||
    (comment.performed_via_github_app != null && !authoredByCodex(comment))
  )
    return true;

  // Code review is authenticated again when the final verifier runs. Ignore
  // only the pinned actor's edits that keep every consumed review field equal.
  const current = reviewSignal(comment.body);
  return (
    current === null || current !== reviewSignal(event.changes?.body?.from)
  );
}

export function pullRequestComments(api, number) {
  const comments = [];
  for (let page = 1; page <= 10; page++) {
    const current = api(`issues/${number}/comments?per_page=100&page=${page}`);
    assert.ok(Array.isArray(current), "GitHub did not return PR comments.");
    comments.push(...current);
    if (current.length < 100) return comments;
  }
  throw new Error("PR comments exceed the safely verifiable pagination limit.");
}

function restCodexBot(actor) {
  return (
    actor?.id === codexReviewBotId &&
    actor.login === "chatgpt-codex-connector[bot]" &&
    actor.type === "Bot"
  );
}

function authoredByCodex(comment) {
  const app = comment.performed_via_github_app;
  return (
    restCodexBot(comment.user) &&
    app?.id === 1144995 &&
    app.slug === "chatgpt-codex-connector" &&
    app.owner?.login === "openai"
  );
}

function reviewBody(body) {
  const lines = body.split("\n");
  const marked = lines.filter((line) =>
    line.startsWith("<!-- codex-review-state:"),
  );
  const rows = lines.filter((line) => reviewRow.test(line));
  assert.ok(
    marked.length === 1 && stateMarker.test(marked[0]) && rows.length === 1,
    "Codex App review summary format is unsupported or ambiguous.",
  );
  try {
    return {
      state: JSON.parse(stateMarker.exec(marked[0])[1]).code_review,
      row: rows[0],
    };
  } catch {
    throw new Error("Codex App review state is malformed.");
  }
}

function codeReviewTime(row) {
  // A change to Security Review must not make an earlier code review newer.
  const times = [...row.matchAll(/<relative-time datetime="([^"]+)">/g)];
  assert.ok(
    times.length === 1,
    "Codex App did not publish the code review completion time.",
  );
  return times[0][1];
}

function reviewSignal(body) {
  if (
    typeof body !== "string" ||
    !body.startsWith(summaryMarker + "\n") ||
    Buffer.byteLength(body) > 24000
  )
    return null;
  try {
    const { state, row } = reviewBody(body);
    const { commit_sha, status, has_any_findings, has_unresolved_findings } =
      state;
    if (
      typeof commit_sha !== "string" ||
      typeof status !== "string" ||
      ![true, false, null].includes(has_any_findings) ||
      ![true, false, null].includes(has_unresolved_findings)
    )
      return null;
    const reviewedAt = codeReviewTime(row);
    time(reviewedAt);
    return JSON.stringify([
      commit_sha,
      status,
      has_any_findings,
      has_unresolved_findings,
      reviewedAt,
    ]);
  } catch {
    return null;
  }
}

function time(value) {
  assert.ok(
    typeof value === "string" &&
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/.test(
        value,
      ) &&
      Number.isFinite(Date.parse(value)),
    "Codex review timing or current engineering-run timing is unavailable.",
  );
  return Date.parse(value);
}

function codexBot(actor) {
  return (
    actor?.__typename === "Bot" &&
    actor.databaseId === codexReviewBotId &&
    actor.login === "chatgpt-codex-connector"
  );
}

function verifyCommentEditor(graphql, summary) {
  assert.ok(
    typeof summary.node_id === "string" &&
      /^[A-Za-z0-9_+/=-]{3,180}$/.test(summary.node_id),
    "Codex review summary has no verifiable GitHub node identity.",
  );
  // REST records the original author and App even when somebody with repo
  // write access edits the comment. A later App update can preserve prior content,
  // so verify the complete bounded edit history as well as the current editor.
  const node = graphql(commentSnapshot, summary.node_id)?.data?.node;
  assert.ok(
    node?.__typename === "IssueComment" &&
      node.id === summary.node_id &&
      node.fullDatabaseId === String(summary.id) &&
      node.body === summary.body &&
      node.createdAt === summary.created_at &&
      node.updatedAt === summary.updated_at &&
      codexBot(node.author),
    "Codex review comment identity or content changed between GitHub observations.",
  );
  const pristine =
    node.lastEditedAt === null &&
    node.editor === null &&
    node.createdAt === node.updatedAt;
  // GitHub can update comment metadata after recording the last content edit.
  // The matching edit-history entry below authenticates the content timestamp.
  const botEdited =
    codexBot(node.editor) &&
    typeof node.lastEditedAt === "string" &&
    time(node.lastEditedAt) >= time(node.createdAt) &&
    time(node.lastEditedAt) <= time(node.updatedAt);
  assert.ok(
    pristine || botEdited,
    "Codex review comment's current content was not written by the pinned Codex bot.",
  );
  const history = node.userContentEdits;
  const edits = history?.nodes;
  assert.ok(
    history?.pageInfo?.hasNextPage === false &&
      Array.isArray(edits) &&
      edits.length === history.totalCount &&
      (pristine
        ? edits.length === 0
        : edits[0]?.editedAt === node.lastEditedAt) &&
      edits.every((edit) => edit?.deletedAt === null && codexBot(edit.editor)),
    "Codex review comment edit history is incomplete or includes a different editor.",
  );
}

export function codexReviewProof(api, graphql, comments, target, run, now) {
  // The provider certifies head only. Require the exact same source tree
  // in the GitHub-tested preview and prove the review starts from current main.
  assert.ok(
    target.headTree === target.mergeTree,
    "Codex reviewed a different source tree. Update the candidate to current main.",
  );
  const branch = api(`compare/${target.base}...${target.head}?per_page=1`);
  assert.ok(
    branch.base_commit?.sha === target.base &&
      branch.merge_base_commit?.sha === target.base &&
      branch.status === "ahead" &&
      Number.isSafeInteger(branch.ahead_by) &&
      branch.ahead_by > 0,
    "Codex review requires a candidate that contains the current trusted main.",
  );

  const summaries = comments.filter(
    (comment) =>
      authoredByCodex(comment) &&
      typeof comment.body === "string" &&
      comment.body.startsWith(summaryMarker + "\n"),
  );
  if (summaries.length === 0)
    throw new DeliveryWaiting(
      "waiting-review",
      "Need one authenticated Codex App review summary on this PR.",
    );
  assert.ok(
    summaries.length === 1,
    "Need one authenticated Codex App review summary on this PR.",
  );
  const [summary] = summaries;
  assert.ok(
    Number.isSafeInteger(summary.id) &&
      Buffer.byteLength(summary.body) <= 24000,
    "Codex review summary is not safely identifiable or bounded.",
  );
  verifyCommentEditor(graphql, summary);
  const { state, row } = reviewBody(summary.body);
  if (
    state?.commit_sha === target.head &&
    ["requested", "running"].includes(state.status)
  )
    throw new DeliveryWaiting(
      "waiting-review",
      "Codex App has not completed code review for this exact candidate head.",
    );
  assert.ok(
    state?.commit_sha === target.head && state.status === "completed",
    "Codex App has not completed code review for this exact candidate head.",
  );
  assert.ok(
    state.has_any_findings === false && state.has_unresolved_findings === false,
    "Codex App code review reports findings or an indeterminate result.",
  );

  const reviewedAt = codeReviewTime(row);
  const instant = time(reviewedAt);
  assert.ok(
    instant >=
      Math.max(
        time(target.createdAt),
        time(target.previewCreatedAt),
        time(run.run_started_at ?? run.created_at),
      ) &&
      instant <= now &&
      Math.floor(instant / 1000) <= Math.floor(time(summary.updated_at) / 1000),
    "Codex code review must be completed after the current preview and engineering attempt begin.",
  );
  const reviewDigest = createHash("sha256")
    .update(
      JSON.stringify([
        summary.id,
        target.head,
        reviewedAt,
        state.status,
        state.has_any_findings,
        state.has_unresolved_findings,
      ]),
    )
    .digest("hex");
  return { reviewId: summary.id, reviewDigest, reviewedAt };
}
