import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  finalCheck,
  githubClient,
  leasedPublisherCredential,
  privateEvidenceFor,
  publishFinalDelivery,
  targetFor,
  verifyFinalDelivery,
} from "./delivery-final.mjs";
import {
  requiredAffectedCommands,
  requiredWindowsAffectedCommands,
  windowsAffectedTests,
} from "./delivery-check.mjs";
import { classifyDeliveryPaths } from "./delivery-scope.mjs";
import { privateAttestationBytes } from "./delivery-private-attestation.mjs";

const target = {
  number: 7,
  repositoryId: 12,
  headRepo: 12,
  base: "a".repeat(40),
  head: "b".repeat(40),
  merge: "c".repeat(40),
  headTree: "d".repeat(40),
  mergeTree: "d".repeat(40),
  createdAt: "2026-11-24T07:00:00Z",
  previewCreatedAt: "2026-11-24T07:01:00Z",
};
const run = {
  id: 31,
  workflow_id: 32,
  run_attempt: 2,
  event: "pull_request",
  path: ".github/workflows/delivery.yml",
  status: "completed",
  conclusion: "success",
  repository: { id: 12 },
  head_repository: { id: 12 },
  head_sha: target.head,
  pull_requests: [{ number: 7 }],
  run_started_at: "2026-11-24T07:05:00Z",
};
const now = Date.parse("2026-11-24T09:00:00Z");
const artifactDigest = "1".repeat(64);
const verified = {
  runId: run.id,
  runAttempt: run.run_attempt,
  review: { reviewDigest: "1".repeat(64) },
  evidence: { evidenceDigest: "2".repeat(64) },
};

describe("publishing the final GitHub check", () => {
  const publisher = (events) => ({
    startCheck(sha) {
      events.push(["start", sha]);
      return sha === target.head ? 1 : 2;
    },
    finishCheck(id, conclusion) {
      events.push([conclusion, id]);
    },
  });

  it("publishes one decision on both commits and marks the candidate successful last", () => {
    const events = [];
    expect(
      publishFinalDelivery(publisher(events), target, "run-url", () => {
        events.push(["verify"]);
        return verified;
      }),
    ).toBe(verified);
    expect(events).toEqual([
      ["start", target.head],
      ["start", target.merge],
      ["verify"],
      ["success", 2],
      ["success", 1],
    ]);
  });

  it("publishes refusal on both commits when current verification fails", () => {
    const events = [];
    expect(() =>
      publishFinalDelivery(publisher(events), target, "run-url", () => {
        throw new Error("evidence no longer valid");
      }),
    ).toThrow("evidence no longer valid");
    expect(events.slice(-2)).toEqual([
      ["failure", 1],
      ["failure", 2],
    ]);
  });

  it("leaves a failed candidate check if the preview check cannot be started", () => {
    const events = [];
    const client = {
      ...publisher(events),
      startCheck(sha) {
        if (sha === target.merge) throw new Error("preview unavailable");
        return 1;
      },
    };
    expect(() =>
      publishFinalDelivery(client, target, "run-url", () => {
        throw new Error("unexpected verification");
      }),
    ).toThrow("did not confirm failure on both exact checks");
    expect(events).toEqual([["failure", 1]]);
  });
});

describe("dedicated publisher", () => {
  function github({ wrongApp = false, staleReadback = false } = {}) {
    const records = new Map();
    const calls = [];
    let serial = 10;
    const env = {
      GH_TOKEN: "read-token",
      FARFOLD_FINAL_PUBLISHER_TOKEN: "app-token",
      FARFOLD_FINAL_PUBLISHER_APP_ID: "5913751",
    };
    const open = () =>
      githubClient("owner/farfold", env, (_command, args, options) => {
        const body = options.input ? JSON.parse(options.input) : null;
        const route = args.find((arg) => arg.startsWith("repos/"));
        expect(options.env).not.toHaveProperty("FARFOLD_FINAL_PUBLISHER_TOKEN");
        expect(options.env.GH_TOKEN).toBe(body ? "app-token" : "read-token");
        const commit = route.match(/commits\/([a-f]{40})\/check-runs/);
        if (commit) {
          expect(route).toContain("app_id=5913751");
          const check_runs = [...records.values()].filter(
            (item) => item.head_sha === commit[1],
          );
          return JSON.stringify({ total_count: check_runs.length, check_runs });
        }
        const id = Number(route.split("/").at(-1));
        const previous = records.get(id);
        if (!body) {
          const confirmed = staleReadback
            ? { ...previous, conclusion: "success" }
            : previous;
          return JSON.stringify(confirmed);
        }
        calls.push([args[2], body.conclusion, id]);
        if (Number.isNaN(id)) {
          const check = {
            id: serial++,
            app: { id: wrongApp ? 15368 : 5913751, slug: "publisher" },
            ...body,
          };
          records.set(check.id, check);
          return JSON.stringify(check);
        }
        const check = { ...previous, ...body };
        records.set(id, check);
        return JSON.stringify(check);
      });
    return { open, records, calls };
  }

  it("reuses the identical GitHub check IDs and reads both back as failed on revocation", () => {
    const { open, records, calls } = github();
    publishFinalDelivery(open(), target, "verified-run", () => verified);
    expect([...records.values()].map((check) => check.conclusion)).toEqual([
      "success",
      "success",
    ]);
    expect(
      [...records.values()].map((check) => JSON.parse(check.output.summary)),
    ).toEqual(
      [0, 1].map(() =>
        expect.objectContaining({
          head: target.head,
          merge: target.merge,
          runAttempt: 2,
        }),
      ),
    );
    expect(() =>
      publishFinalDelivery(open(), target, "revocation-run", () => {
        expect([...records.values()].map((check) => check.conclusion)).toEqual([
          "failure",
          "failure",
        ]);
        expect(
          [...records.values()].every((check) =>
            check.output.summary.startsWith(
              "Rechecking current delivery evidence",
            ),
          ),
        ).toBe(true);
        throw new Error("signed record was withdrawn");
      }),
    ).toThrow(/signed record was withdrawn/);
    expect([...records.keys()]).toEqual([10, 11]);
    expect([...records.values()].map((check) => check.conclusion)).toEqual([
      "failure",
      "failure",
    ]);
    expect(calls.slice(-2)).toEqual([
      ["PATCH", "failure", 10],
      ["PATCH", "failure", 11],
    ]);
  });

  it("will not approve an unexpected publisher or confirm stale failure readback", () => {
    const wrong = github({ wrongApp: true });
    expect(() =>
      publishFinalDelivery(
        wrong.open(),
        target,
        "verified-run",
        () => verified,
      ),
    ).toThrow(/did not confirm failure on both exact checks/);
    expect(wrong.calls.some(([, conclusion]) => conclusion === "success")).toBe(
      false,
    );

    const stale = github({ staleReadback: true });
    expect(() =>
      publishFinalDelivery(stale.open(), target, "revocation-run", () => {
        throw new Error("signed record was withdrawn");
      }),
    ).toThrow(/did not confirm failure on both exact checks/);
  });
});

function providerComment() {
  return {
    id: 7127685325,
    node_id: "IC_kwDOUF9Z6s8AAAABqNfYzQ",
    created_at: "2026-11-24T07:55:00Z",
    user: { id: 199175422, type: "Bot", login: "chatgpt-codex-connector[bot]" },
    performed_via_github_app: {
      id: 1144995,
      slug: "chatgpt-codex-connector",
      owner: { login: "openai" },
    },
    updated_at: "2026-11-24T08:05:00Z",
    body: [
      "<!-- codex-pull-request-review-summary -->",
      `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: target.head, status: "completed", has_any_findings: false, has_unresolved_findings: false } })} -->`,
      '| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-11-24T08:00:00.307599Z">2026-11-24T08:00:00.307599Z</relative-time> | `bbbbbbb` | PR opened |',
    ].join("\n"),
  };
}

function buildAttestation(scope, overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { base, head, merge, repositoryId } = target;
  const claim = {
    repositoryId,
    witnessId: 40,
    pr: target.number,
    base,
    head,
    merge,
    engineeringRunId: run.id,
    engineeringRunAttempt: run.run_attempt,
    executionId: "private_execution_1234",
    transcriptSha256: "2".repeat(64),
    reviewedAt: "2026-11-24T08:10:00Z",
    originalsId: "private_originals_1234",
    decision: "approved",
    evidence: {
      base,
      head,
      merge,
      stable: { required: false, sha256: null },
      installed: { required: false, receipts: [] },
    },
    policyReview: scope.governance
      ? {
          preservesRequirements: true,
          assessment:
            "Independently reviewed the policy change and preservation of the existing test scope.",
        }
      : null,
    ...overrides,
  };
  const signature = sign(
    null,
    privateAttestationBytes(claim, 2),
    privateKey,
  ).toString("base64url");
  return {
    publicKey: publicKey.export({ format: "pem", type: "spki" }),
    comment: {
      id: 40,
      node_id: "IC_private_delivery",
      created_at: "2026-11-24T07:01:00Z",
      updated_at: "2026-11-24T08:15:00Z",
      user: { id: 77, type: "User" },
      author_association: "OWNER",
      body:
        "<!-- farfold-private-delivery:v1 -->\n" +
        JSON.stringify({ schemaVersion: 2, claim, signature }),
    },
  };
}

function witnessNode(comment) {
  const owner = { __typename: "User", databaseId: comment.user.id };
  return {
    __typename: "IssueComment",
    id: comment.node_id,
    fullDatabaseId: String(comment.id),
    body: comment.body,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    lastEditedAt: comment.updated_at,
    author: owner,
    userContentEdits: {
      totalCount: 2,
      pageInfo: { hasNextPage: false },
      nodes: [comment.updated_at, comment.created_at].map((editedAt) => ({
        editedAt,
        deletedAt: null,
        editor: owner,
      })),
    },
  };
}

function client({
  path = "README.md",
  files = [{ filename: path, status: "modified" }],
  comments = [providerComment()],
  report,
  runList = [run],
  windowsJob = true,
  windowsTests = windowsAffectedTests.map((name) => ({
    name,
    passed: 1,
    failed: 0,
    ignored: 0,
  })),
  publicKey,
} = {}) {
  const scope = classifyDeliveryPaths(
    files.flatMap(({ filename, previous_filename }) =>
      [filename, previous_filename].filter(Boolean),
    ),
  );
  const job = (name) => ({
    name,
    head_sha: target.head,
    status: "completed",
    conclusion: "success",
  });
  const artifact = (name, id) => ({
    id,
    name: `${name}-2`,
    workflow_run: { id: 31 },
    size_in_bytes: 534,
    expired: false,
    digest: `sha256:${artifactDigest}`,
  });
  const routes = {
    [`compare/${target.base}...${target.merge}`]: {
      base_commit: { sha: target.base },
      merge_base_commit: { sha: target.base },
      files,
    },
    [`compare/${target.base}...${target.head}?per_page=1`]: {
      base_commit: { sha: target.base },
      merge_base_commit: { sha: target.base },
      status: "ahead",
      ahead_by: 1,
    },
    "issues/7/comments?per_page=100&page=1": comments,
    "actions/workflows/delivery.yml": { id: 32 },
    [`actions/workflows/delivery.yml/runs?event=pull_request&head_sha=${target.head}&per_page=100`]:
      { workflow_runs: runList },
    "actions/runs/31/attempts/2/jobs?per_page=100": {
      jobs: [
        job("Farfold delivery check"),
        ...(windowsJob ? [job("Windows affected engineering checks")] : []),
      ],
    },
    "actions/runs/31/artifacts?per_page=100": {
      artifacts: [
        artifact("delivery-checks", 35),
        artifact("delivery-windows", 36),
      ],
    },
  };
  const results = (commands) =>
    commands.map((command) => ({
      command,
      exitCode: 0,
      signal: null,
      error: null,
    }));
  return {
    publicKey,
    graphql(_query, id) {
      const comment = comments.find(({ node_id }) => node_id === id);
      if (comment?.user?.type === "User") {
        return { data: { node: witnessNode(comment) } };
      }
      const bot = {
        __typename: "Bot",
        databaseId: 199175422,
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
          },
        },
      };
    },
    api(route) {
      if (!Object.hasOwn(routes, route))
        throw new Error(`Unexpected test route: ${route}`);
      return routes[route];
    },
    report(_artifact, entry) {
      const header = {
        head: target.merge,
        base: target.base,
        inputsStable: true,
      };
      if (entry === "delivery-windows.json") {
        return {
          ...header,
          mode: "affected-windows",
          platform: "win32-x64",
          tests: windowsTests,
          results: results(
            requiredWindowsAffectedCommands(target.base, target.merge),
          ),
        };
      }
      return (
        report ?? {
          ...header,
          mode: "affected",
          results: results(
            requiredAffectedCommands(scope, target.base, target.merge),
          ),
        }
      );
    },
  };
}

describe("hosted final delivery", () => {
  it("can accept an authenticated Codex-reviewed docs change without a second GitHub account or a private signer", () => {
    expect(verifyFinalDelivery(client(), target, now)).toMatchObject({
      runId: 31,
      runAttempt: 2,
      review: { reviewId: 7127685325 },
      scope: { product: false, governance: false },
      evidence: null,
    });
  });

  it("fails green engineering when authenticated code review is missing", () => {
    expect(() =>
      verifyFinalDelivery(client({ comments: [] }), target, now),
    ).toThrow(/authenticated Codex App review summary/i);
  });

  it("fails closed on an incomplete exact-scope compare or rename record", () => {
    const truncated = Array.from({ length: 300 }, (_, i) => ({
      filename: `docs/page-${i}.md`,
    }));
    expect(() =>
      verifyFinalDelivery(client({ files: truncated }), target, now),
    ).toThrow(/complete exact merge-preview file list/i);
    expect(() =>
      verifyFinalDelivery(
        client({ files: [{ filename: "README.md", status: "renamed" }] }),
        target,
        now,
      ),
    ).toThrow(/all required file paths/i);
  });

  it("applies private installed-evidence prerequisites to a resource change or a rename out of public", () => {
    for (const files of [
      [{ filename: "public/brand/wordmark.svg", status: "modified" }],
      [
        {
          filename: "docs/wordmark.svg",
          previous_filename: "public/brand/wordmark.svg",
          status: "renamed",
        },
      ],
    ]) {
      expect(() => verifyFinalDelivery(client({ files }), target, now)).toThrow(
        /missing configuration.*trusted custodian public key/i,
      );
    }
  });

  it("checks signed installed evidence after the current independent code review", () => {
    const path = "public/brand/wordmark.svg";
    const scope = classifyDeliveryPaths([path]);
    const installed = {
      mode: "fresh",
      receiptSha256: "1".repeat(64),
      manifestSha256: "2".repeat(64),
      productCommit: target.head,
      binarySha256: "3".repeat(64),
      platform: "macos-arm64",
      requirementIds: ["P01"],
      preparedAt: "2026-11-24T07:20:00Z",
      finishedAt: "2026-11-24T07:30:00Z",
      reviewBy: null,
      revalidationSha256: null,
      revalidatedAt: null,
      buildSha256: "4".repeat(64),
      sourceTree: target.mergeTree,
    };
    const verify = (receipt) => {
      const { comment, publicKey } = buildAttestation(scope, {
        evidence: {
          base: target.base,
          head: target.head,
          merge: target.merge,
          stable: { required: true, sha256: "5".repeat(64) },
          installed: { required: true, receipts: receipt ? [receipt] : [] },
        },
      });
      return verifyFinalDelivery(
        client({ path, publicKey, comments: [providerComment(), comment] }),
        target,
        now,
      );
    };
    expect(verify(installed)).toMatchObject({ evidence: { evidenceId: 40 } });
    expect(() => verify(null)).toThrow(/macOS arm64 installed evidence/i);
    expect(() =>
      verify({ ...installed, reviewBy: "2026-11-24T08:59:00Z" }),
    ).toThrow(/review-horizon-reached/i);
    expect(() => verify({ ...installed, sourceTree: "e".repeat(40) })).toThrow(
      /exact tested candidate source tree/i,
    );
  });

  it("requires a signed policy assessment for delivery-governance changes", () => {
    const path = ".github/workflows/delivery.yml";
    const scope = classifyDeliveryPaths([path]);
    expect(() => verifyFinalDelivery(client({ path }), target, now)).toThrow(
      /missing configuration.*trusted custodian public key/i,
    );
    const { comment, publicKey } = buildAttestation(scope);
    expect(
      verifyFinalDelivery(
        client({ path, publicKey, comments: [providerComment(), comment] }),
        target,
        now,
      ),
    ).toMatchObject({
      scope: { governance: true },
      evidence: { evidenceId: 40 },
    });
  });

  it("does not treat a plain owner comment as independent private evidence", () => {
    const scope = classifyDeliveryPaths(["scripts/delivery-final.mjs"]);
    const { comment, publicKey } = buildAttestation(scope);
    const forged = comment.body.replace(
      "private_execution_1234",
      "private_execution_9999",
    );
    expect(() =>
      privateEvidenceFor(
        [{ ...comment, body: forged }],
        target,
        scope,
        run,
        now,
        publicKey,
      ),
    ).toThrow(/signature does not match/i);
  });

  it("requires one active evidence record and rejects a withdrawn record", () => {
    const scope = classifyDeliveryPaths(["scripts/delivery-final.mjs"]);
    const { comment, publicKey } = buildAttestation(scope);
    for (const comments of [
      [],
      [comment, { ...comment, id: comment.id + 1 }],
    ]) {
      expect(() =>
        privateEvidenceFor(comments, target, scope, run, now, publicKey),
      ).toThrow(/exactly one authenticated custodian record/i);
    }
  });

  it("rejects a copied signature and an altered witness edit history", () => {
    const scope = classifyDeliveryPaths(["scripts/delivery-final.mjs"]);
    const { comment, publicKey } = buildAttestation(scope);
    const verify = (witness, node) =>
      privateEvidenceFor([witness], target, scope, run, now, publicKey, () => ({
        data: { node },
      }));
    const node = witnessNode(comment);
    expect(verify(comment, node)).toMatchObject({ evidenceId: comment.id });
    expect(() => verify({ ...comment, id: 41 }, node)).toThrow(
      /different witness comment/i,
    );
    expect(() =>
      verify(comment, {
        ...node,
        userContentEdits: { ...node.userContentEdits, totalCount: 3 },
      }),
    ).toThrow(/one-time publication/i);
  });

  it("does not fall back to older successful attempts when the current one failed", () => {
    expect(() =>
      verifyFinalDelivery(
        client({
          runList: [{ ...run, conclusion: "failure", run_attempt: 3 }, run],
        }),
        target,
        now,
      ),
    ).toThrow(/current PR needs a successful engineering workflow attempt/i);
  });

  it("rejects an engineering report from a different merge preview", () => {
    expect(() =>
      verifyFinalDelivery(
        client({
          report: {
            mode: "affected",
            base: target.base,
            head: target.head,
            inputsStable: true,
            results: [{ exitCode: 0 }],
          },
        }),
        target,
        now,
      ),
    ).toThrow(/exact merge preview and base/i);
  });

  it("refuses a green artifact that omits required affected-scope commands", () => {
    expect(() =>
      verifyFinalDelivery(
        client({
          report: {
            mode: "affected",
            base: target.base,
            head: target.merge,
            inputsStable: true,
            results: [
              {
                command: ["git", "diff", "--check", target.base, target.merge],
                exitCode: 0,
              },
            ],
          },
        }),
        target,
        now,
      ),
    ).toThrow(/omitted a required affected-scope check/i);
  });

  it("requires the separate job and all exact Windows test results when applicable", () => {
    const path = "src-tauri/src/worktrees/windows_git.rs";
    expect(() =>
      verifyFinalDelivery(client({ path, windowsJob: false }), target, now),
    ).toThrow(/Windows engineering job did not pass/i);
    expect(() =>
      verifyFinalDelivery(client({ path, windowsTests: [] }), target, now),
    ).toThrow(/Windows engineering report omitted/i);
    expect(() => verifyFinalDelivery(client({ path }), target, now)).toThrow(
      /missing configuration.*trusted custodian public key/i,
    );
  });

  it("rejects a GitHub preview with mismatched parents", () => {
    const api = (path) =>
      ({
        "pulls/7": {
          number: 7,
          state: "open",
          base: { sha: target.base, ref: "main", repo: { id: 12 } },
          head: { sha: target.head, repo: { id: 12 } },
          merge_commit_sha: target.merge,
          user: { id: 21 },
        },
        [`git/commits/${target.merge}`]: {
          sha: target.merge,
          parents: [{ sha: target.head }, { sha: target.base }],
          tree: { sha: target.mergeTree },
        },
        [`git/commits/${target.head}`]: {
          sha: target.head,
          tree: { sha: target.headTree },
        },
      })[path];
    expect(() =>
      targetFor(api, target.number, target.base, target.repositoryId),
    ).toThrow(/preview or candidate tree/i);
  });
});

describe("leased final publisher credentials", () => {
  const lease = {
    pr: target.number,
    base: target.base,
    head: target.head,
    merge: target.merge,
    expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
    token: "ghs_" + "x".repeat(40),
  };

  it("accepts a short lease for the exact PR and main", () => {
    expect(
      leasedPublisherCredential(
        JSON.stringify(lease),
        target.number,
        target.base,
        now,
      ),
    ).toEqual(lease);
  });

  it.each([
    { pr: 8 },
    { base: "f".repeat(40) },
    { merge: target.head },
    { head: "unbound" },
    { expiresAt: new Date(now - 1).toISOString() },
    { expiresAt: new Date(now + 2 * 60 * 60 * 1000).toISOString() },
    { token: "invalid" },
    { privateKey: "unexpected" },
  ])("rejects leases with an invalid field", (fields) => {
    expect(() =>
      leasedPublisherCredential(
        JSON.stringify({ ...lease, ...fields }),
        target.number,
        target.base,
        now,
      ),
    ).toThrow();
  });

  it("stops without a lease", () => {
    expect(() =>
      leasedPublisherCredential("", target.number, target.base, now),
    ).toThrow(/short-lived publisher lease/);
  });
});
