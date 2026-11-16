import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as index from "./acceptance-index.mjs";

const root = resolve(import.meta.dirname, "..");
const path = "docs/evidence/2026-11-11-mcp-lifecycle/stage2-evidence.json";
const text = readFileSync(resolve(root, path), "utf8");
const document = JSON.parse(text);
const authorities = index.loadAcceptanceAuthorities(root);
const fixture = (change = () => {}) => {
  const value = structuredClone(document);
  change(value);
  return { path, text: JSON.stringify(value) };
};
const parse = (input) =>
  index.parseStage2Evidence(input, authorities, { rootDir: root });

describe("existing stage-two evidence in the default entry", () => {
  it("reads the scoped records without creating receipts or changing dated stage-one counts", () => {
    const result = index.runAcceptanceIndex([]);
    const [supplement] = result.agentEvidence.supplements;
    expect(supplement.source).toEqual({
      path,
      sha256: createHash("sha256").update(text).digest("hex"),
    });
    expect(supplement.role).toBe("stage2-scoped-evidence-not-current-status");
    expect(supplement.observations.map((item) => item.agentId)).toEqual([
      "mistral-vibe",
      "goose",
      "goose",
    ]);
    expect(
      supplement.observations.every((item) => item.result === "unclassified"),
    ).toBe(true);
    expect(supplement.observations[0].summary).toBe(
      document.observations[0].summary,
    );
    expect(supplement.observations[1].limitations).toContainEqual(
      expect.stringContaining("无法重新读取副本"),
    );
    expect(result.agentEvidence.recordedCounts.wholeAgentConfirmed).toBe(0);
    expect(result.agentEvidence.recordedCounts.agents).toBe(29);
    expect(result.coverage).toEqual([]);
    expect(result.cells).toHaveLength(184);
    expect(result.cells.every((cell) => cell.acceptance === "unreviewed")).toBe(
      true,
    );
    const cell = result.cells.find(
      (item) => item.agentId === "mistral-vibe" && item.standardId === "S5",
    );
    expect(cell.observationStatus).toBe("indexed-unreviewed");
    expect(cell.declaredObservations).toContainEqual({
      source: supplement.source,
      sourcePointer: "/observations/0",
      result: "unclassified",
    });
  });

  it("filters the supplemental records by actual identity and explicit narrow links", () => {
    const query = (...args) =>
      index
        .runAcceptanceIndex(args)
        .agentEvidence.supplements.flatMap((item) => item.observations);
    expect(query("--agent", "goose").map((item) => item.id)).toEqual([
      document.observations[1].id,
      document.observations[2].id,
    ]);
    expect(query("--requirement", "P18").map((item) => item.agentId)).toEqual([
      "mistral-vibe",
    ]);
    expect(query("--requirement", "P22").map((item) => item.id)).toEqual([
      document.observations[1].id,
    ]);
    expect(query("--standard", "S5")).toHaveLength(3);
    expect(query("--standard", "S4")).toEqual([]);
    expect(query("--agent", "amp-acp")).toEqual([]);
  });

  it("keeps the no-model official MCP sample separate from file journeys and receipt coverage", () => {
    const query = index.runAcceptanceIndex([
      "--agent",
      "goose",
      "--requirement",
      "P41",
    ]);
    const observations = query.agentEvidence.supplements.flatMap(
      (item) => item.observations,
    );
    expect(observations).toHaveLength(1);
    const [sample] = observations;
    expect(sample.id).toBe("goose-p41-official-mcp-lifecycle-20261111");
    expect(sample.standardIds).toEqual(["S5"]);
    expect(sample.requirementIds).toEqual(["P41"]);
    expect(sample.result).toBe("unclassified");
    expect(sample.acceptanceVerified).toBe(false);
    expect(sample).not.toHaveProperty("attemptResults");
    const original = JSON.parse(
      readFileSync(resolve(root, sample.evidence[0].path), "utf8"),
    );
    expect(sample.sourceCodeCommits).toEqual([
      original.agent.reviewedOfficialSourceCommit,
    ]);
    expect(original.protocolRequests.modelPrompts).toBe(0);
    expect(original.protocolRequests.toolsCalls).toBe(0);
    expect(original.finalReadBoundary.originalReceiptPassed).toBe(false);
    expect(query.coverage).toEqual([]);
    expect(query.acceptanceVerified).toBe(false);
  });

  it("binds saved indexes to supplemental bytes without making old pure API callers read new files", () => {
    const result = index.runAcceptanceIndex([]);
    expect(
      index.validateAcceptanceIndex(result, authorities).mechanicallyValid,
    ).toBe(true);
    expect(() =>
      index.validateAcceptanceIndex(result, authorities, {
        stage2Evidence: fixture((value) => {
          value.observations[0].summary += " changed";
        }),
      }),
    ).toThrow(/changed/);
    const prior = index.buildAcceptanceIndex({
      authorities,
      conditions: index.loadAgentConditions(root),
    });
    expect(prior.agentEvidence.supplements).toBeUndefined();
    expect(
      index.validateAcceptanceIndex(prior, authorities).mechanicallyValid,
    ).toBe(true);
  });
});

describe("stage-two provenance and claim boundaries", () => {
  it.each([
    [
      "unknown agent",
      (d) => {
        d.observations[0].agentId = "invented";
      },
    ],
    [
      "unknown standard",
      (d) => {
        d.observations[0].standardIds = ["S9"];
      },
    ],
    [
      "unknown requirement",
      (d) => {
        d.observations[0].requirementIds = ["P999"];
      },
    ],
    [
      "automatic passed",
      (d) => {
        d.observations[0].result = "passed";
      },
    ],
    [
      "manufactured attempt",
      (d) => {
        d.observations[0].attemptResults = [];
      },
    ],
    [
      "missing scope",
      (d) => {
        delete d.observations[0].scope;
      },
    ],
    [
      "duplicate observation",
      (d) => {
        d.observations.push(d.observations[0]);
      },
    ],
    [
      "malformed original digest",
      (d) => {
        d.observations[0].originalVerification.originals[0].sha256 = "bad";
      },
    ],
    [
      "traversal reference",
      (d) => {
        d.observations[0].evidence[0].path = "docs/evidence/../status.md";
      },
    ],
    [
      "missing public reference",
      (d) => {
        d.observations[0].evidence[0].path =
          "docs/evidence/nonexistent-stage2.json";
      },
    ],
    [
      "wrong public bytes",
      (d) => {
        d.observations[0].evidence[0].sha256 = "0".repeat(64);
      },
    ],
  ])("rejects %s", (_label, change) => {
    expect(() => parse(fixture(change))).toThrow();
  });

  it("computes the supplemental digest from parsed bytes and declares the limits of local-original checks", () => {
    const input = fixture();
    const result = parse(input);
    expect(result.source.sha256).toBe(
      createHash("sha256").update(input.text).digest("hex"),
    );
    expect(result.referenceValidation).toEqual({
      repositoryEvidence: "sha256-matched",
      localOriginals: "recorded-check-only",
    });
    expect(() => parse({ ...input, sha256: "0".repeat(64) })).toThrow();
  });
});
