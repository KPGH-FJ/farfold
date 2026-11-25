import { describe, expect, it } from "vitest";
import {
  codexReviewBotId,
  codexReviewEditCurrent,
  codexReviewEvent,
  codexReviewProof as verifyProof,
  pullRequestComments,
} from "./delivery-codex-review.mjs";

// Fields and widget structure from Farfold PR #5's public Codex summary.
const head = "92219aced8fe795cede5e3ef5d15cdf4732e8031";
const target = {
  number: 5,
  base: "1".repeat(40),
  head,
  headTree: "2".repeat(40),
  mergeTree: "2".repeat(40),
  createdAt: "2026-11-24T09:37:30Z",
  previewCreatedAt: "2026-11-24T09:37:40Z",
};
const run = { run_started_at: "2026-11-24T09:37:55Z" };
const completion = "2026-11-24T09:39:16.307599Z";
const now = Date.parse("2026-11-24T09:42:00Z");
const compare = () => ({
  base_commit: { sha: target.base },
  merge_base_commit: { sha: target.base },
  status: "ahead",
  ahead_by: 1,
});

function summary({ code = {}, completed = completion, security = {} } = {}) {
  return {
    id: 7127685325,
    node_id: "IC_kwDOUF9Z6s8AAAABqNfYzQ",
    created_at: "2026-11-24T09:38:18Z",
    user: {
      id: codexReviewBotId,
      login: "chatgpt-codex-connector[bot]",
      type: "Bot",
    },
    performed_via_github_app: {
      id: 1144995,
      slug: "chatgpt-codex-connector",
      owner: { login: "openai" },
    },
    updated_at: "2026-11-24T09:41:06Z",
    body: [
      "<!-- codex-pull-request-review-summary -->",
      `<!-- codex-review-state:v1 ${JSON.stringify({
        code_review: {
          commit_sha: head,
          has_any_findings: false,
          has_unresolved_findings: false,
          status: "completed",
          ...code,
        },
        security_review: {
          commit_sha: head,
          has_any_findings: null,
          has_unresolved_findings: null,
          status: "completed",
          ...security,
        },
      })} -->`,
      `| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="${completed}">${completed}</relative-time> | \`92219ac\` | PR opened |`,
      '| 🔒 **Security Review** | ✅ **Completed** <relative-time datetime="2026-11-24T09:41:05Z">2026-11-24T09:41:05Z</relative-time> | `92219ac` | PR opened |',
      "",
    ].join("\n"),
  };
}

function editedReview(previous, current, sender = current.user) {
  return {
    action: "edited",
    issue: { number: target.number, pull_request: {} },
    comment: current,
    changes: { body: { from: previous.body } },
    sender,
  };
}

function commentGraphql(comments, snapshot = {}) {
  return (query, id) => {
    expect(query).toContain("node(id: $node)");
    const comment = comments.find(({ node_id }) => node_id === id);
    const bot = {
      __typename: "Bot",
      databaseId: codexReviewBotId,
      login: "chatgpt-codex-connector",
    };
    return {
      data: {
        node: {
          __typename: "IssueComment",
          id: comment.node_id,
          fullDatabaseId: String(comment.id),
          body: comment.body,
          createdAt: comment.created_at,
          updatedAt: comment.updated_at,
          lastEditedAt: comment.updated_at,
          author: bot,
          editor: bot,
          userContentEdits: {
            totalCount: 1,
            pageInfo: { hasNextPage: false },
            nodes: [
              { editedAt: comment.updated_at, deletedAt: null, editor: bot },
            ],
          },
          ...snapshot,
        },
      },
    };
  };
}

function codexReviewProof(api, comments, target, run, now, snapshot = {}) {
  return verifyProof(
    api,
    commentGraphql(comments, snapshot),
    comments,
    target,
    run,
    now,
  );
}

describe("authenticated Codex App review", () => {
  it("recognizes the actual clean summary shape and provider identity", () => {
    expect(
      codexReviewProof(compare, [summary()], target, run, now),
    ).toMatchObject({
      reviewId: 7127685325,
      reviewedAt: completion,
      reviewDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("accepts app-authored content when comment metadata is newer than the last edit", () => {
    const comment = summary();
    const lastEditedAt = "2026-11-24T09:41:05Z";
    expect(
      codexReviewProof(compare, [comment], target, run, now, {
        lastEditedAt,
        userContentEdits: {
          totalCount: 1,
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              editedAt: lastEditedAt,
              deletedAt: null,
              editor: {
                __typename: "Bot",
                databaseId: codexReviewBotId,
                login: "chatgpt-codex-connector",
              },
            },
          ],
        },
      }),
    ).toMatchObject({ reviewId: comment.id });
  });

  it("does not accept a user-authored marker or a different GitHub App", () => {
    const authentic = summary();
    for (const forged of [
      { ...authentic, user: { ...authentic.user, id: 22 } },
      {
        ...authentic,
        performed_via_github_app: {
          ...authentic.performed_via_github_app,
          id: 15368,
        },
      },
      {
        ...authentic,
        performed_via_github_app: {
          ...authentic.performed_via_github_app,
          owner: { login: "other" },
        },
      },
    ]) {
      expect(() =>
        codexReviewProof(compare, [forged], target, run, now),
      ).toThrow(/one authenticated Codex App review summary/i);
    }
  });

  it("rejects a write-capable owner's edit despite unchanged REST author and App", () => {
    expect(() =>
      codexReviewProof(compare, [summary()], target, run, now, {
        editor: { __typename: "User", databaseId: 22, login: "KPGH-FJ" },
      }),
    ).toThrow(/current content was not written by the pinned Codex bot/i);
  });

  it("rejects an owner edit retained through a later App edit", () => {
    const comment = summary();
    expect(() =>
      codexReviewProof(compare, [comment], target, run, now, {
        userContentEdits: {
          totalCount: 2,
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              editedAt: comment.updated_at,
              deletedAt: null,
              editor: {
                __typename: "Bot",
                databaseId: codexReviewBotId,
                login: "chatgpt-codex-connector",
              },
            },
            {
              editedAt: comment.created_at,
              deletedAt: null,
              editor: { __typename: "User", login: "owner" },
            },
          ],
        },
      }),
    ).toThrow(/edit history is incomplete or includes a different editor/i);
  });

  it("rejects REST/GraphQL races or changes to an exact summary identity", () => {
    for (const snapshot of [
      { body: "new body" },
      { id: "different_node" },
      { fullDatabaseId: "7127685324" },
      { updatedAt: "2026-11-24T09:42:09Z" },
      { author: { __typename: "Bot", databaseId: 17, login: "another" } },
    ]) {
      expect(() =>
        codexReviewProof(compare, [summary()], target, run, now, snapshot),
      ).toThrow(/identity or content changed/i);
    }
  });

  it("verifies new unedited comments and still queries GraphQL for same-second edits", () => {
    const comment = { ...summary(), created_at: "2026-11-24T09:41:06Z" };
    expect(
      codexReviewProof(compare, [comment], target, run, now, {
        editor: null,
        lastEditedAt: null,
        userContentEdits: {
          totalCount: 0,
          pageInfo: { hasNextPage: false },
          nodes: [],
        },
      }),
    ).toMatchObject({ reviewId: comment.id });
    expect(() =>
      codexReviewProof(compare, [comment], target, run, now, {
        editor: { __typename: "User", login: "owner" },
      }),
    ).toThrow(/not written by the pinned Codex bot/i);
  });

  it("rejects ambiguous provider summaries or an unavailable marker format", () => {
    expect(() =>
      codexReviewProof(
        compare,
        [summary(), { ...summary(), id: 73 }],
        target,
        run,
        now,
      ),
    ).toThrow(/one authenticated Codex App review summary/i);
    const broken = {
      ...summary(),
      body: summary().body.replace(
        "codex-review-state:v1 ",
        "codex-review-state:v2 ",
      ),
    };
    expect(() => codexReviewProof(compare, [broken], target, run, now)).toThrow(
      /unsupported or ambiguous/i,
    );
  });

  it("waits for the first authenticated review", () => {
    expect(() => codexReviewProof(compare, [], target, run, now)).toThrow(
      expect.objectContaining({ state: "waiting-review" }),
    );
  });

  it.each(["requested", "running"])(
    "waits for a %s current review",
    (status) => {
      expect(() =>
        codexReviewProof(
          compare,
          [summary({ code: { status } })],
          target,
          run,
          now,
        ),
      ).toThrow(expect.objectContaining({ state: "waiting-review" }));
    },
  );

  it.each([
    { commit_sha: "c".repeat(40) },
    { commit_sha: "c".repeat(40), status: "running" },
    { status: "withdrawn" },
  ])("rejects an invalid current review: %o", (code) => {
    expect(() =>
      codexReviewProof(compare, [summary({ code })], target, run, now),
    ).toThrow(/has not completed code review/i);
    expect(() =>
      codexReviewProof(compare, [summary({ code })], target, run, now),
    ).not.toThrow(expect.objectContaining({ state: "waiting-review" }));
  });

  it.each([
    { has_any_findings: true },
    { has_unresolved_findings: true },
    { has_any_findings: null },
  ])("rejects findings or unknown review outcome: %o", (code) => {
    expect(() =>
      codexReviewProof(compare, [summary({ code })], target, run, now),
    ).toThrow(/findings or an indeterminate result/i);
  });

  it("does not treat a later security-only summary edit as newer code review", () => {
    const stale = summary({ completed: "2026-11-24T09:37:50Z" });
    expect(() => codexReviewProof(compare, [stale], target, run, now)).toThrow(
      /engineering attempt begin/i,
    );
    expect(() =>
      codexReviewProof(
        compare,
        [summary()],
        { ...target, previewCreatedAt: "2026-11-24T09:40:00Z" },
        run,
        now,
      ),
    ).toThrow(/current preview/i);
  });

  it("fails when the provider-reviewed tree or base ancestry differs", () => {
    expect(() =>
      codexReviewProof(
        compare,
        [summary()],
        { ...target, mergeTree: "3".repeat(40) },
        run,
        now,
      ),
    ).toThrow(/different source tree/i);
    const diverged = () => ({ ...compare(), status: "diverged" });
    expect(() =>
      codexReviewProof(diverged, [summary()], target, run, now),
    ).toThrow(/contains the current trusted main/i);
  });

  it("checks authenticated bot change events and restricts rechecks to pull requests", () => {
    for (const action of ["created", "edited", "deleted"]) {
      expect(
        codexReviewEvent({
          action,
          issue: { number: 5, pull_request: {} },
          comment: summary(),
        }),
      ).toBe(true);
    }
    expect(
      codexReviewEvent({
        action: "created",
        issue: { number: 5 },
        comment: summary(),
      }),
    ).toBe(false);
    expect(
      codexReviewEvent({
        action: "edited",
        issue: { number: 5, pull_request: {} },
        comment: { user: { id: 21, type: "User" } },
      }),
    ).toBe(false);
  });

  it("ignores a pinned bot edit that only updates the security review or display text", () => {
    const previous = summary({ security: { status: "running" } });
    previous.body = previous.body.replace(
      'datetime="2026-11-24T09:41:05Z"',
      'datetime="2026-11-24T09:39:15Z"',
    );
    const current = summary();
    current.body += "An updated display footer.";
    const event = editedReview(previous, current);
    expect(codexReviewEvent(event)).toBe(true);
    expect(codexReviewEvent(event, () => false)).toBe(true);
    expect(codexReviewEvent(event, (comment) => comment === current)).toBe(
      false,
    );
  });

  it("confirms an equivalent edit using the current REST identity and full editor history", () => {
    const current = summary();
    const reader = {
      api(path) {
        expect(path).toBe(`issues/comments/${current.id}`);
        return current;
      },
      graphql: commentGraphql([current]),
    };
    const event = editedReview(
      summary({ security: { status: "running" } }),
      current,
    );
    const confirm = (comment) => codexReviewEditCurrent(reader, comment);
    expect(confirm(current)).toBe(true);
    expect(codexReviewEvent(event, confirm)).toBe(false);

    const node = reader.graphql("node(id: $node)", current.node_id).data.node;
    for (const snapshot of [
      { editor: { __typename: "User", login: "owner" } },
      {
        userContentEdits: {
          ...node.userContentEdits,
          totalCount: 101,
          pageInfo: { hasNextPage: true },
        },
      },
      {
        userContentEdits: {
          ...node.userContentEdits,
          totalCount: 101,
          nodes: Array(101).fill(node.userContentEdits.nodes[0]),
        },
      },
    ]) {
      reader.graphql = commentGraphql([current], snapshot);
      expect(confirm(current)).toBe(false);
      expect(codexReviewEvent(event, confirm)).toBe(true);
    }
  });

  it("does not skip an edit whose live source, body, identity or update time changed", () => {
    const eventComment = summary();
    for (const live of [
      null,
      { ...eventComment, id: eventComment.id + 1 },
      { ...eventComment, node_id: "a_different_node" },
      summary({ security: { status: "running" } }),
      { ...eventComment, updated_at: "2026-11-24T09:42:00Z" },
      { ...eventComment, performed_via_github_app: { id: 15368 } },
    ]) {
      expect(
        codexReviewEditCurrent(
          { api: () => live, graphql: commentGraphql([live]) },
          eventComment,
        ),
      ).toBe(false);
    }
    expect(
      codexReviewEditCurrent(
        {
          api() {
            throw new Error("GitHub API unavailable");
          },
        },
        eventComment,
      ),
    ).toBe(false);
  });

  it("rechecks changed findings, status, head, timing and removed review text", () => {
    const previous = summary();
    for (const current of [
      summary({ code: { has_any_findings: true } }),
      summary({ code: { has_unresolved_findings: true } }),
      summary({ code: { status: "running" } }),
      summary({ code: { commit_sha: "c".repeat(40) } }),
      summary({ completed: "2026-11-24T09:40:00Z" }),
      { ...previous, body: "Review withdrawn." },
    ]) {
      expect(
        codexReviewEvent(editedReview(previous, current), () => true),
      ).toBe(true);
    }
  });

  it("does not filter unknown editors or unverifiable prior text", () => {
    const previous = summary();
    const current = summary({ security: { status: "running" } });
    for (const sender of [
      null,
      { id: 22, login: "KPGH-FJ", type: "User" },
      { ...previous.user, id: 223 },
    ]) {
      expect(
        codexReviewEvent(editedReview(previous, current, sender), () => true),
      ).toBe(true);
    }
    expect(
      codexReviewEvent(editedReview({ body: "invalid" }, current), () => true),
    ).toBe(true);
  });

  it("does not use an older truncated comment list as the current state", () => {
    expect(() =>
      pullRequestComments(() => Array(100).fill(summary()), target.number),
    ).toThrow(/pagination limit/i);
    expect(pullRequestComments(() => [summary()], target.number)).toHaveLength(
      1,
    );
  });
});
