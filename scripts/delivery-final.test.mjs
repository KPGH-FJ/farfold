import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  githubClient,
  prepareReleasePlan,
  privateEvidenceFor,
  proofHash,
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
import { releaseCheck, releaseRequestAnchor } from "./delivery-release.mjs";
import { DeliveryWaiting } from "./delivery-state.mjs";

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
const requestUuid = "5b266ac4-d4b2-483a-9d39-f3ef264ac3cb";
const otherUuid = "e976b8b4-a0f8-4ce0-a567-1f89b336aad8";

describe("routing final delivery without publisher credentials", () => {
  const workflow = fileURLToPath(
    new URL("./delivery-final.mjs", import.meta.url),
  );

  function runRoute(eventName, event) {
    const directory = mkdtempSync(join(tmpdir(), "farfold-delivery-route-"));
    const eventPath = join(directory, "event.json");
    const outputPath = join(directory, "output");
    try {
      writeFileSync(
        eventPath,
        JSON.stringify({ repository: { id: 12 }, ...event }),
      );
      writeFileSync(outputPath, "");
      const log = execFileSync(process.execPath, [workflow, "--route"], {
        encoding: "utf8",
        env: {
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: target.base,
          GITHUB_REPOSITORY: "KPGH-FJ/farfold",
          GITHUB_RUN_ID: "30",
          GITHUB_EVENT_NAME: eventName,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
        },
      });
      return { log, output: readFileSync(outputPath, "utf8") };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("routes completion of exact engineering and explicit pre-merge refreshes", () => {
    for (const result of [
      runRoute("workflow_run", { workflow_run: run }),
      runRoute("workflow_dispatch", { inputs: { pr_number: "7" } }),
    ]) {
      expect(result).toEqual({ log: "", output: "pr_number=7\n" });
    }
  });

  it("leaves publication unqueued when engineering has no associated PR", () => {
    const { log, output } = runRoute("workflow_run", {
      workflow_run: { ...run, pull_requests: [] },
    });
    expect(output).toBe("");
    expect(JSON.parse(log)).toEqual({
      decision: "not-run",
      reason: "no-associated-pr",
    });
  });

  it("routes a restarted engineering attempt and skips the first attempt starting", () => {
    const started = { ...run, status: "in_progress", conclusion: null };
    expect(
      runRoute("workflow_run", {
        action: "in_progress",
        workflow_run: started,
      }),
    ).toEqual({ log: "", output: "pr_number=7\n" });
    const { log, output } = runRoute("workflow_run", {
      action: "in_progress",
      workflow_run: { ...started, run_attempt: 1 },
    });
    expect(output).toBe("");
    expect(JSON.parse(log)).toEqual({
      decision: "not-run",
      reason: "initial-engineering-attempt-in-progress",
    });
  });
});

describe("dedicated final publisher identity", () => {
  const env = {
    GH_TOKEN: "read-only-fixture",
    FARFOLD_FINAL_PUBLISHER_APP_ID: "123456",
    FARFOLD_FINAL_PUBLISHER_TOKEN: "installation-token-fixture",
  };
  function fixture({ create = {}, update = {}, overrides = {}, request } = {}) {
    const calls = [];
    const archive = Buffer.from("archive fixture");
    const check = {
      id: 31,
      head_sha: target.head,
      name: "Farfold final delivery",
      app: { id: 123456, slug: "farfold-final-publisher" },
    };
    const client = githubClient(
      "KPGH-FJ/farfold",
      { ...env, ...overrides },
      (command, args, options) => {
        calls.push({ command, args, env: options.env, input: options.input });
        if (command === "unzip")
          return args[0] === "-Z1" ? "report.json\n" : "{}";
        if (args.at(-1).endsWith("/zip")) return archive;
        if (args[2] === "POST")
          return JSON.stringify({ ...check, status: "in_progress", ...create });
        if (args[2] === "PATCH")
          return JSON.stringify({
            ...check,
            status: "completed",
            conclusion: "success",
            ...update,
          });
        return "{}";
      },
      request,
    );
    return { client, calls, archive };
  }

  it("isolates the App token to check writes and validates GitHub's publisher response", () => {
    const { client, calls, archive } = fixture();
    expect(client.api("pulls/7")).toEqual({});
    expect(
      client.report(
        {
          id: 123,
          digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
        },
        "report.json",
      ),
    ).toEqual({});
    const id = client.startCheck(target.head, "run-url");
    client.finishCheck(id, "success", "verified");
    expect(client.publisherAppId).toBe(123456);
    expect(calls.map(({ env }) => env.GH_TOKEN)).toEqual([
      "read-only-fixture",
      "read-only-fixture",
      undefined,
      undefined,
      "installation-token-fixture",
      "installation-token-fixture",
    ]);
    expect(
      calls.every(({ env }) => !("FARFOLD_FINAL_PUBLISHER_TOKEN" in env)),
    ).toBe(true);
  });

  it("records and settles intent in the same pre-enrolled App journal", () => {
    const intent = {
      repositoryId: target.repositoryId,
      pr: target.number,
      base: target.base,
      head: target.head,
      preview: target.merge,
      tree: target.mergeTree,
      proofSha256: "0".repeat(64),
    };
    const events = [];
    const journal = {
      id: 31,
      state: "ready",
      publisherSlug: "farfold-final-publisher",
    };
    let marker = {
      id: journal.id,
      head_sha: releaseRequestAnchor,
      name: releaseCheck,
      app: { id: 123456, slug: journal.publisherSlug },
      status: "completed",
      conclusion: "neutral",
      output: {
        title: releaseCheck,
        summary: JSON.stringify({
          schemaVersion: 1,
          repositoryId: target.repositoryId,
          state: "ready",
        }),
      },
    };
    const client = githubClient(
      "KPGH-FJ/farfold",
      env,
      (_command, args, options) => {
        const method = args[2];
        if (method === "PATCH") {
          expect(options.env.GH_TOKEN).toBe(env.FARFOLD_FINAL_PUBLISHER_TOKEN);
          expect(args[3]).toBe("repos/KPGH-FJ/farfold/check-runs/31");
          const body = JSON.parse(options.input);
          events.push([method, body]);
          marker = { ...marker, ...body };
          return JSON.stringify(marker);
        }
        expect(options.env.GH_TOKEN).toBe(env.GH_TOKEN);
        const route = args.at(-1);
        expect(route).toContain(
          `repos/KPGH-FJ/farfold/commits/${releaseRequestAnchor}/check-runs?`,
        );
        expect(route).toMatch(/app_id=123456&filter=all&per_page=100$/);
        events.push(["READ"]);
        return JSON.stringify({ total_count: 1, check_runs: [marker] });
      },
    );
    expect(client.startRelease(intent, "run-url", journal)).toMatchObject({
      id: 31,
      intent,
    });
    const accepted = { ...intent, uuid: requestUuid };
    client.updateRelease(31, accepted);
    client.finishRelease(31, accepted, "success");
    expect(events.map(([method]) => method)).toEqual([
      "PATCH",
      "READ",
      "PATCH",
      "PATCH",
    ]);
    expect(events[0][1]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
    });
    const pending = {
      schemaVersion: 1,
      repositoryId: target.repositoryId,
      state: "pending",
      intent,
    };
    expect(JSON.parse(events[0][1].output.summary)).toEqual(pending);
    expect(JSON.parse(events[2][1].output.summary)).toEqual({
      ...pending,
      intent: accepted,
    });
    expect(events[3][1]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
    });
    expect(JSON.parse(events[3][1].output.summary)).toEqual({
      ...pending,
      state: "settled",
      outcome: "success",
      intent: accepted,
    });
  });

  const releaseToken = "release-token-fixture";
  const mergeRoute = `pulls/${target.number}/merge-async`;
  const requestPath = `${mergeRoute}/${requestUuid}`;

  it("limits the distinct release token to one prepared request and its exact operation", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "pending",
          details: { uuid: requestUuid },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "merged" }),
      });
    const { client, calls } = fixture({
      overrides: { FARFOLD_FINAL_RELEASE_TOKEN: releaseToken },
      request,
    });
    await expect(client.releaseApi("PUT", mergeRoute)).rejects.toThrow(
      /does not authorize/,
    );
    client.authorizeRelease({ mode: "release", pr: target.number });
    client.api("pulls/7");
    const checkId = client.startCheck(target.head, "run-url");
    client.finishCheck(checkId, "success", "verified");
    expect(calls.map(({ env }) => env.GH_TOKEN)).toEqual([
      env.GH_TOKEN,
      env.FARFOLD_FINAL_PUBLISHER_TOKEN,
      env.FARFOLD_FINAL_PUBLISHER_TOKEN,
    ]);
    for (const { env: childEnv } of calls) {
      expect(childEnv).not.toHaveProperty("FARFOLD_FINAL_RELEASE_TOKEN");
      expect(childEnv).not.toHaveProperty("FARFOLD_FINAL_PUBLISHER_TOKEN");
    }
    await expect(client.releaseApi("GET", requestPath)).rejects.toThrow(
      /does not authorize/,
    );
    await expect(
      client.releaseApi("PUT", "pulls/8/merge-async"),
    ).rejects.toThrow(/does not authorize/);
    await expect(
      client.releaseApi("PUT", mergeRoute, { sha: target.head }),
    ).resolves.toMatchObject({ status: "pending" });
    await expect(client.releaseApi("PUT", mergeRoute)).rejects.toThrow(
      /does not authorize/,
    );
    await expect(
      client.releaseApi("GET", `${mergeRoute}/${otherUuid}`),
    ).rejects.toThrow(/does not authorize/);
    await expect(client.releaseApi("GET", requestPath)).resolves.toMatchObject({
      status: "merged",
    });
    expect(
      request.mock.calls.map(([url, opts]) => [
        url,
        opts.method,
        opts.headers.Authorization,
      ]),
    ).toEqual([
      [
        `https://api.github.com/repos/KPGH-FJ/farfold/${mergeRoute}`,
        "PUT",
        `Bearer ${releaseToken}`,
      ],
      [
        `https://api.github.com/repos/KPGH-FJ/farfold/${requestPath}`,
        "GET",
        `Bearer ${releaseToken}`,
      ],
    ]);
  });

  it("only reads back the bound UUID during recovery and never sends another request", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "failed" }),
    });
    const { client } = fixture({
      overrides: { FARFOLD_FINAL_RELEASE_TOKEN: releaseToken },
      request,
    });
    client.authorizeRelease({
      mode: "reconcile",
      pr: target.number,
      uuid: requestUuid,
    });
    await expect(client.releaseApi("PUT", mergeRoute)).rejects.toThrow(
      /does not authorize/,
    );
    await expect(
      client.releaseApi("GET", `${mergeRoute}/${otherUuid}`),
    ).rejects.toThrow(/does not authorize/);
    await expect(
      client.releaseApi("GET", `pulls/8/merge-async/${requestUuid}`),
    ).rejects.toThrow(/does not authorize/);
    await expect(client.releaseApi("GET", requestPath)).resolves.toEqual({
      status: "failed",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toMatchObject({
      method: "GET",
      headers: { Authorization: `Bearer ${releaseToken}` },
    });
  });

  it("refuses to use a missing or shared credential for release", () => {
    for (const invalid of [
      undefined,
      env.GH_TOKEN,
      env.FARFOLD_FINAL_PUBLISHER_TOKEN,
    ]) {
      const { client } = fixture({
        overrides: { FARFOLD_FINAL_RELEASE_TOKEN: invalid },
      });
      expect(() =>
        client.authorizeRelease({ mode: "release", pr: target.number }),
      ).toThrow(/distinct/);
    }
  });

  it("refuses a missing App or the generic Actions identity and credential", () => {
    for (const overrides of [
      { FARFOLD_FINAL_PUBLISHER_APP_ID: "" },
      { FARFOLD_FINAL_PUBLISHER_APP_ID: "15368" },
      { FARFOLD_FINAL_PUBLISHER_TOKEN: "" },
      { FARFOLD_FINAL_PUBLISHER_TOKEN: env.GH_TOKEN },
    ]) {
      expect(() =>
        githubClient("KPGH-FJ/farfold", { ...env, ...overrides }),
      ).toThrow(/dedicated final-publisher/);
    }
  });

  it("rejects source or candidate mismatches on creation and completion", () => {
    for (const mismatch of [
      { app: { id: 222222, slug: "some-other-app" } },
      { app: { id: 123456, slug: "github-actions" } },
      { head_sha: target.merge },
    ]) {
      expect(() =>
        fixture({ create: mismatch }).client.startCheck(target.head, "run-url"),
      ).toThrow(/exact final check/);
      const { client } = fixture({ update: mismatch });
      const id = client.startCheck(target.head, "run-url");
      expect(() => client.finishCheck(id, "success", "verified")).toThrow(
        /exact final check/,
      );
    }
    const { client } = fixture({ update: { conclusion: "failure" } });
    const id = client.startCheck(target.head, "run-url");
    expect(() => client.finishCheck(id, "success", "verified")).toThrow(
      /did not confirm/,
    );
  });

  it("keeps a waiting check in progress without any conclusion", () => {
    const { client, calls } = fixture({
      update: { status: "in_progress", conclusion: null },
    });
    const id = client.startCheck(target.head, "run-url");
    client.finishCheck(id, null, "waiting-review");
    expect(JSON.parse(calls.at(-1).input)).toEqual({
      status: "in_progress",
      output: { title: "Farfold final delivery", summary: "waiting-review" },
    });
  });
});

describe("preparing least-privilege release credentials", () => {
  const releaseProof = "5".repeat(64);
  const pending = {
    id: 31,
    intent: { pr: target.number, uuid: requestUuid },
    publisherSlug: "farfold-final-publisher",
  };
  const owner = { ownerDispatch: true, number: target.number };

  it("only prepares a fresh release after current proof and rules verification", () => {
    const verifyRelease = vi.fn();
    expect(
      prepareReleasePlan({
        ...owner,
        ownerDispatch: false,
        releaseProof,
        verifyRelease,
      }),
    ).toBeNull();
    expect(prepareReleasePlan({ ...owner, verifyRelease })).toBeNull();
    expect(
      prepareReleasePlan({ ...owner, releaseProof, pending, verifyRelease }),
    ).toBeNull();
    expect(verifyRelease).not.toHaveBeenCalled();
    expect(
      prepareReleasePlan({ ...owner, releaseProof, verifyRelease }),
    ).toEqual({ mode: "release", binding: releaseProof });
    expect(verifyRelease).toHaveBeenCalledTimes(1);
    verifyRelease.mockImplementationOnce(() => {
      throw new Error("Current release proof changed");
    });
    expect(() =>
      prepareReleasePlan({ ...owner, releaseProof, verifyRelease }),
    ).toThrow(/proof changed/);
  });

  it("prepares recovery only for the owner refreshing the matching stored UUID", () => {
    const verifyRelease = vi.fn();
    expect(prepareReleasePlan({ ...owner, pending, verifyRelease })).toEqual({
      mode: "reconcile",
      binding: proofHash(pending),
    });
    const replacement = {
      ...pending,
      intent: { ...pending.intent, uuid: otherUuid },
    };
    expect(
      prepareReleasePlan({ ...owner, pending: replacement, verifyRelease })
        .binding,
    ).not.toBe(proofHash(pending));
    expect(
      prepareReleasePlan({ ...owner, number: 8, pending, verifyRelease }),
    ).toBeNull();
    expect(
      prepareReleasePlan({
        ...owner,
        ownerDispatch: false,
        pending,
        verifyRelease,
      }),
    ).toBeNull();
    expect(
      prepareReleasePlan({
        ...owner,
        pending: { ...pending, intent: { pr: target.number } },
        verifyRelease,
      }),
    ).toBeNull();
    expect(verifyRelease).not.toHaveBeenCalled();
  });
});

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
        return "verified";
      }),
    ).toBe("verified");
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

  it.each(["waiting-engineering", "waiting-review"])(
    "keeps both required-check records in progress for %s",
    (state) => {
      const events = [];
      const waiting = new DeliveryWaiting(state, "still pending");
      expect(() =>
        publishFinalDelivery(publisher(events), target, "run-url", () => {
          throw waiting;
        }),
      ).toThrow(waiting);
      expect(events.slice(-2)).toEqual([
        [null, 1],
        [null, 2],
      ]);
    },
  );

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
    ).toThrow("preview unavailable");
    expect(events).toEqual([["failure", 1]]);
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
    pr: target.number,
    witnessId: 40,
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
      node_id: "IC_owner_witness_40",
      created_at: "2026-11-24T08:00:00Z",
      updated_at: "2026-11-24T08:11:00Z",
      user: { id: 77, type: "User" },
      author_association: "OWNER",
      body:
        "<!-- farfold-private-delivery:v1 -->\n" +
        JSON.stringify({ schemaVersion: 2, claim, signature }),
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
  witnessEdits,
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
      const bot = {
        __typename: "Bot",
        databaseId: 199175422,
        login: "chatgpt-codex-connector",
      };
      const userWitness = comment.user.type === "User";
      const actor = userWitness
        ? { __typename: "User", databaseId: comment.user.id }
        : bot;
      const edits = [
        { editedAt: comment.updated_at, deletedAt: null, editor: actor },
        ...(userWitness
          ? [{ editedAt: comment.created_at, deletedAt: null, editor: actor }]
          : []),
      ];
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
            author: actor,
            editor: actor,
            userContentEdits: {
              totalCount: userWitness
                ? (witnessEdits ?? edits.length)
                : edits.length,
              pageInfo: { hasNextPage: false },
              nodes: edits,
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
    ).toThrow(expect.objectContaining({ state: "waiting-review" }));
  });

  it("distinguishes queued engineering from a completed attempt that failed", () => {
    for (const [attempt, state] of [
      [{ ...run, status: "queued", conclusion: null }, "waiting-engineering"],
      [{ ...run, conclusion: "failure" }, "engineering-rejected"],
    ]) {
      expect(() =>
        verifyFinalDelivery(client({ runList: [attempt] }), target, now),
      ).toThrow(expect.objectContaining({ state }));
    }
  });

  it("does not reuse the previous engineering success after a restart event", () => {
    const restarted = { ...run, run_attempt: run.run_attempt + 1 };
    expect(() =>
      verifyFinalDelivery(
        { ...client(), announcedRun: restarted },
        target,
        now,
      ),
    ).toThrow(expect.objectContaining({ state: "waiting-engineering" }));
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
        expect.objectContaining({ state: "missing-configuration" }),
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
    ).toThrow(
      expect.objectContaining({
        state: "evidence-rejected",
        message: expect.stringMatching(/review-horizon-reached/i),
      }),
    );
    expect(() => verify({ ...installed, sourceTree: "e".repeat(40) })).toThrow(
      /exact tested candidate source tree/i,
    );
  });

  it("requires a signed policy assessment for delivery-governance changes", () => {
    const path = ".github/workflows/delivery.yml";
    const scope = classifyDeliveryPaths([path]);
    expect(() => verifyFinalDelivery(client({ path }), target, now)).toThrow(
      /policy assessment needs a configured trusted custodian key/i,
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

  it("rejects copying a withdrawn witness into a new comment or restoring it after another edit", () => {
    const path = "scripts/delivery-final.mjs";
    const scope = classifyDeliveryPaths([path]);
    const { comment, publicKey } = buildAttestation(scope);
    expect(() =>
      verifyFinalDelivery(
        client({
          path,
          publicKey,
          comments: [providerComment(), { ...comment, id: 41 }],
        }),
        target,
        now,
      ),
    ).toThrow(/different witness comment/);
    expect(() =>
      verifyFinalDelivery(
        client({
          path,
          publicKey,
          comments: [providerComment(), comment],
          witnessEdits: 3,
        }),
        target,
        now,
      ),
    ).toThrow(/edited again/);
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
      /needs a configured trusted custodian key/i,
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
