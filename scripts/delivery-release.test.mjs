import { describe, expect, it, vi } from "vitest";
import {
  pendingRelease,
  pendingReleaseForMergedPr,
  reconcileRelease,
  releaseCheck,
  releaseDelivery,
} from "./delivery-release.mjs";

const target = {
  repositoryId: 10,
  number: 15,
  base: "1".repeat(40),
  head: "2".repeat(40),
  merge: "3".repeat(40),
  mergeTree: "4".repeat(40),
};
const proof = { proofSha256: "5".repeat(64) };
const mergeCommit = "6".repeat(40);
const requestUuid = "5b266ac4-d4b2-483a-9d39-f3ef264ac3cb";
const publisherAppId = 5913751;
const publisherSlug = "farfold-final-delivery-publisher";
const serverUrl =
  "https://github.com/example/farfold/actions/runs/7/attempts/1";
const markerId = 12;
const pendingIntent = {
  repositoryId: target.repositoryId,
  pr: target.number,
  base: target.base,
  head: target.head,
  preview: target.merge,
  tree: target.mergeTree,
  ...proof,
};

function fixture({
  commit = {
    sha: mergeCommit,
    parents: [{ sha: target.base }, { sha: target.head }],
    tree: { sha: target.mergeTree },
  },
  marker = {},
  visibleMerge = true,
} = {}) {
  const calls = [];
  const created = [];
  let savedIntent;
  const client = {
    publisherAppId,
    startRelease: vi.fn((intent, url) => {
      calls.push("record");
      savedIntent = { ...intent };
      created.push({ intent: savedIntent, url });
      return { id: markerId, publisherSlug };
    }),
    updateRelease: vi.fn((_id, intent) => {
      calls.push("save-uuid");
      savedIntent = { ...intent };
    }),
    finishRelease: vi.fn(),
    releaseApi: vi.fn((method, path) => {
      calls.push(method);
      if (method === "PUT" && path === "pulls/15/merge-async") {
        return {
          status: "pending",
          details: {
            uuid: requestUuid,
            expected_head_sha: target.head,
            merge_method: "merge",
            merge_action: "direct_merge",
          },
        };
      }
      if (method === "GET" && path === `pulls/15/merge-async/${requestUuid}`) {
        return { status: "merged", details: { sha: mergeCommit } };
      }
      throw new Error(`Unexpected release call: ${method} ${path}`);
    }),
    api: vi.fn((path) => {
      if (path === "pulls/15") {
        return {
          merged: visibleMerge,
          merged_by: { login: publisherSlug + "[bot]" },
          number: 15,
          base: { ref: "main", repo: { id: target.repositoryId } },
          head: { sha: target.head },
          merge_commit_sha: mergeCommit,
        };
      }
      if (path === `git/commits/${mergeCommit}`) return commit;
      if (path.startsWith(`commits/${target.base}/check-runs?`)) {
        return {
          total_count: 1,
          check_runs: [
            {
              id: markerId,
              publisherSlug,
              name: releaseCheck,
              app: { id: publisherAppId, slug: publisherSlug },
              head_sha: target.base,
              status: "in_progress",
              output: { summary: JSON.stringify(savedIntent ?? pendingIntent) },
              ...marker,
            },
          ],
        };
      }
      throw new Error(`Unexpected read: ${path}`);
    }),
  };
  return { client, calls, created };
}

describe("release recovery after main advances", () => {
  it("finds the old marker through the actual merge parents", async () => {
    const { client, calls } = fixture();
    const pending = pendingReleaseForMergedPr(
      client,
      target.number,
      target.repositoryId,
    );
    expect(pending).toEqual({
      id: markerId,
      intent: pendingIntent,
      publisherSlug,
    });
    await expect(reconcileRelease(client, pending)).resolves.toEqual({
      decision: "merged",
      mergeCommit,
    });
    expect(calls).not.toContain("PUT");
  });

  it("does not recover a marker belonging to a different PR", () => {
    const { client } = fixture({
      marker: {
        output: { summary: JSON.stringify({ ...pendingIntent, pr: 22 }) },
      },
    });
    expect(() =>
      pendingReleaseForMergedPr(client, target.number, target.repositoryId),
    ).toThrow(/different pending release/);
  });
});

describe("verified release request", () => {
  it("confirms an exact merged PR when the original operation is no longer available", async () => {
    const { client } = fixture();
    client.releaseApi.mockImplementation(() => {
      throw new Error("GitHub operation unavailable");
    });
    await expect(
      reconcileRelease(client, {
        id: markerId,
        publisherSlug,
        intent: { ...pendingIntent, uuid: requestUuid },
      }),
    ).resolves.toEqual({ decision: "merged", mergeCommit });
    expect(
      client.releaseApi.mock.calls.every(([method]) => method === "GET"),
    ).toBe(true);
  });

  it("closes a durable intent when GitHub explicitly refuses dispatch", async () => {
    const { client } = fixture();
    client.releaseApi.mockReturnValue({ status: "refused", httpStatus: 403 });
    await expect(
      releaseDelivery(client, target, proof, serverUrl, () => {}),
    ).rejects.toThrow(/HTTP 403/);
    expect(client.finishRelease).toHaveBeenCalledWith(
      markerId,
      pendingIntent,
      "failure",
    );
  });

  it("records intent before dispatch and verifies the actual merged commit", async () => {
    const { client, calls, created } = fixture();
    const recheck = () => calls.push("fresh-proof");
    await expect(
      releaseDelivery(client, target, proof, serverUrl, recheck),
    ).resolves.toEqual({ decision: "merged", mergeCommit });
    expect(calls).toEqual(["record", "fresh-proof", "PUT", "save-uuid", "GET"]);
    expect(created).toEqual([{ intent: pendingIntent, url: serverUrl }]);
    expect(client.releaseApi).toHaveBeenNthCalledWith(
      1,
      "PUT",
      "pulls/15/merge-async",
      expect.objectContaining({ sha: target.head, merge_method: "merge" }),
    );
    expect(client.finishRelease).toHaveBeenCalledWith(
      markerId,
      { ...pendingIntent, uuid: requestUuid },
      "success",
    );
  });

  it.each([
    [
      "parents",
      {
        sha: mergeCommit,
        parents: [{ sha: target.head }, { sha: target.base }],
      },
    ],
    ["tree", { sha: mergeCommit, tree: { sha: "7".repeat(40) } }],
  ])("rejects a claimed merge with the wrong %s", async (part, mismatch) => {
    const { client } = fixture({
      commit: {
        parents: [{ sha: target.base }, { sha: target.head }],
        tree: { sha: target.mergeTree },
        ...mismatch,
      },
    });
    await expect(
      releaseDelivery(client, target, proof, serverUrl, () => {}),
    ).rejects.toThrow(new RegExp(`Merged ${part} differs?`));
    expect(client.finishRelease).not.toHaveBeenCalled();
  });

  it("retains the refusal and never sends an already withdrawn release", async () => {
    const { client } = fixture();
    await expect(
      releaseDelivery(client, target, proof, serverUrl, () => {
        throw new Error("Evidence withdrawn");
      }),
    ).rejects.toThrow("Evidence withdrawn");
    expect(client.releaseApi).not.toHaveBeenCalled();
    expect(client.finishRelease).toHaveBeenCalledWith(
      markerId,
      pendingIntent,
      "failure",
    );
  });

  it("keeps an unknown request without a UUID blocked and does not dispatch again", async () => {
    const { client } = fixture({ visibleMerge: false });
    client.releaseApi.mockImplementationOnce(() => {
      throw new Error("Response lost");
    });
    await expect(
      releaseDelivery(client, target, proof, serverUrl, () => {}),
    ).rejects.toThrow("Response lost");
    const pending = pendingRelease(client, target.base, target.repositoryId);
    expect(pending).toEqual({
      id: markerId,
      publisherSlug,
      intent: pendingIntent,
    });
    await expect(reconcileRelease(client, pending)).rejects.toThrow(
      "Do not resubmit the merge",
    );
    expect(client.releaseApi).toHaveBeenCalledTimes(1);
    expect(client.finishRelease).not.toHaveBeenCalled();
  });

  it("reads the original UUID after a restart without dispatching a new merge", async () => {
    const { client } = fixture();
    const intent = { ...pendingIntent, uuid: requestUuid };
    await expect(
      reconcileRelease(client, { id: markerId, intent, publisherSlug }),
    ).resolves.toEqual({
      decision: "merged",
      mergeCommit,
    });
    expect(client.releaseApi.mock.calls).toEqual([
      ["GET", `pulls/15/merge-async/${requestUuid}`],
    ]);
  });

  it.each([
    ["wrong App", { app: { id: 15368 } }],
    ["wrong commit", { head_sha: target.head }],
    [
      "wrong base in the intent",
      {
        output: {
          summary: JSON.stringify({ ...pendingIntent, base: target.head }),
        },
      },
    ],
  ])("rejects an in-flight record with the %s", (_reason, marker) => {
    const { client } = fixture({ marker });
    expect(() =>
      pendingRelease(client, target.base, target.repositoryId),
    ).toThrow("Pending release record does not match the protected base");
  });
});
