import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as index from "./acceptance-index.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = "docs/evidence/2026-11-06-cycle-01/agent-conditions.json";
const bytes = readFileSync(resolve(root, path));
const original = JSON.parse(bytes);
const authorities = index.loadAcceptanceAuthorities(root);
const source = {
  path,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const fixture = () => ({ path, text: bytes.toString("utf8") });
const parse = (conditions) =>
  index.parseAgentConditions(conditions, authorities, { rootDir: root });

describe("existing per-Agent evidence in the normal acceptance entry", () => {
  it("reads all 29 actual rows with provenance, while keeping empty cells unrecorded", () => {
    const result = index.runAcceptanceIndex([]);
    expect(result.agentEvidence.rows.map((row) => row.agentId)).toEqual(
      authorities.agents,
    );
    expect(result.agentEvidence.source).toEqual(source);
    expect(result.agentEvidence.role).toBe(
      "stage1-evidence-not-current-status",
    );
    expect(result.agentEvidence.scope).toBe(original.scope);
    expect(result.agentEvidence.basedOnCommit).toBe(original.basedOnCommit);
    expect(result.agentEvidence.currentStatusSource).toBe("docs/status.md");
    expect(result.cells).toHaveLength(232);
    expect(result.coverage).toEqual([]);
    expect(result.acceptanceVerified).toBe(false);
    expect(result.cells.every((cell) => cell.acceptance === "unreviewed")).toBe(
      true,
    );
    const amp = result.cells.filter((cell) => cell.agentId === "amp-acp");
    expect(amp.every((cell) => cell.observationStatus === "not-indexed")).toBe(
      true,
    );
    expect(
      result.agentEvidence.rows[0].unassignedEvidence.evidencePaths,
    ).toEqual(original.rows[0].evidencePaths);
    expect(result.agentEvidence.rows[0].recordedRemainingCondition).toBe(
      original.rows[0].remainingCondition,
    );
    expect(result.agentEvidence.rows[0].sourcePointer).toBe("/rows/0");
    expect(result.agentEvidence.recordedCounts).toEqual(original.counts);
    expect(result.agentEvidence.recordedCounts.wholeAgentConfirmed).toBe(0);
    expect(result.agentEvidence.recordedCounts.agents).toBe(29);
  });

  it("keeps stage-one remaining conditions and prose separate from current task conclusions", () => {
    const result = index.runAcceptanceIndex([
      "--agent",
      "kilo",
      "--standard",
      "S4",
    ]);
    expect(result.agentEvidence.rows).toHaveLength(1);
    const row = result.agentEvidence.rows[0];
    const input = original.rows.find((item) => item.agentId === "kilo");
    expect(row.stage1RemainingCondition).toBe(
      input.stage1Supplement.remainingCondition,
    );
    expect(row.recordedRemainingCondition).toBe(input.remainingCondition);
    expect(row.observations.length).toBeGreaterThan(0);
    expect(
      row.observations.every((item) => item.standardIds.includes("S4")),
    ).toBe(true);
    expect(
      row.observations.every((item) => item.result === "unclassified"),
    ).toBe(true);
    expect(row.observations.some((item) => item.summary.includes("仍待"))).toBe(
      true,
    );
    expect(
      row.observations.some((item) => item.summary.includes("补记同一B")),
    ).toBe(true);
    expect(result.cells[0].observationStatus).toBe("indexed-unreviewed");
    expect(result.cells[0].acceptance).toBe("unreviewed");
    const task = index.runAcceptanceIndex(["--requirement", "P39"])
      .requirements[0];
    expect(task.currentConclusion).toBe(true);
    expect(task.progressSource).toBe("docs/status.md#p39");
    expect(task.progress).not.toBe("[最新结论](status.md#p39)");
    expect(readFileSync(resolve(root, "docs/status.md"), "utf8")).toContain(
      task.progress,
    );
  });

  it("does not infer standards from unassigned historical prose or hide it in a standard query", () => {
    const result = index.runAcceptanceIndex([
      "--agent",
      "mistral-vibe",
      "--standard",
      "S5",
    ]);
    expect(result.agentEvidence.rows[0].observations).toEqual([]);
    expect(
      result.agentEvidence.rows[0].unassignedEvidence.evidencePaths.length,
    ).toBeGreaterThan(1);
    expect(
      result.agentEvidence.rows[0].unassignedEvidence.scopedHistoryEvidence,
    ).toEqual(
      original.rows.find((row) => row.agentId === "mistral-vibe")
        .scopedHistoryEvidence,
    );
    expect(result.cells[0].observationStatus).toBe("not-indexed");
    expect(result.coverage).toEqual([]);
  });
});

describe("historical input and separate receipt coverage", () => {
  it.each(["failed", "unknown", "blocked", "not-run"])(
    "retains an explicit coverage %s result beside unclassified historical samples",
    (result) => {
      const conditions = fixture();
      const coverage = [
        {
          caseId: "specific-recorded-outcome",
          agentId: "kilo",
          standardIds: ["S5"],
          requirementIds: ["P18"],
          level: "installed",
          result,
          coveredConditions: [],
          acceptanceVerified: false,
        },
      ];
      const mapping = {
        links: [{ standardId: "S5", requirementIds: ["P18"] }],
        newPackages: {},
      };
      const built = index.buildAcceptanceIndex({
        authorities,
        conditions,
        mapping,
        coverage,
      });
      const query = index.queryAcceptanceIndex(
        built,
        { agentId: "kilo", standardId: "S5" },
        { authorities, conditions },
      );
      expect(query.coverage[0].result).toBe(result);
      expect(query.agentEvidence.rows[0].observations.length).toBeGreaterThan(
        0,
      );
      expect(
        query.agentEvidence.rows[0].observations.every(
          (item) => item.result === "unclassified",
        ),
      ).toBe(true);
      expect(query.cells[0].acceptance).toBe("unreviewed");
      expect(query.agentEvidence.recordedCounts.wholeAgentConfirmed).toBe(0);
    },
  );

  it.each([
    [
      "unknown agent",
      (x) => {
        x.rows[0].agentId = "unknown-agent";
      },
    ],
    [
      "duplicate agent",
      (x) => {
        x.rows[0].agentId = x.rows[1].agentId;
      },
    ],
    [
      "missing agent",
      (x) => {
        x.rows.pop();
      },
    ],
    [
      "unknown standard",
      (x) => {
        x.rows.find(
          (r) => r.stage1Supplement,
        ).stage1Supplement.verifiedSamples[0].standards = ["S9"];
      },
    ],
    [
      "missing scope",
      (x) => {
        x.rows.find(
          (r) => r.stage1Supplement,
        ).stage1Supplement.verifiedSamples[0].environment = "";
      },
    ],
    [
      "unknown sample field",
      (x) => {
        x.rows.find(
          (r) => r.stage1Supplement,
        ).stage1Supplement.verifiedSamples[0].acceptance = true;
      },
    ],
    [
      "future observations",
      (x) => {
        x.rows[0].observations = [];
      },
    ],
    [
      "future dependencies",
      (x) => {
        x.rows[0].dependencies = [];
      },
    ],
    [
      "unknown row field",
      (x) => {
        x.rows[0].passed = true;
      },
    ],
    [
      "unknown reference",
      (x) => {
        x.rows[0].evidencePaths = ["docs/nonexistent-acceptance-evidence.json"];
      },
    ],
    [
      "parent traversal",
      (x) => {
        x.rows[0].evidencePaths = ["docs/../PRODUCT.md"];
      },
    ],
    [
      "absolute path",
      (x) => {
        x.rows[0].evidencePaths = ["/tmp/private.json"];
      },
    ],
    [
      "URL",
      (x) => {
        x.rows[0].evidencePaths = ["https://example.org/evidence.json"];
      },
    ],
    [
      "private location",
      (x) => {
        x.rows[0].evidencePaths = [".git/config"];
      },
    ],
    [
      "invalid recorded count",
      (x) => {
        x.counts.wholeAgentConfirmed = -1;
      },
    ],
    [
      "unknown count field",
      (x) => {
        x.counts.accepted = true;
      },
    ],
  ])("rejects %s instead of returning a partial green result", (_, change) => {
    expect(() => parse(fixture())).not.toThrow();
    const conditions = fixture();
    const document = JSON.parse(conditions.text);
    change(document);
    conditions.text = JSON.stringify(document);
    expect(() => parse(conditions)).toThrow();
  });

  it("rejects modified saved evidence and evidence-source drift", () => {
    const conditions = fixture();
    const built = index.buildAcceptanceIndex({ authorities, conditions });
    const tampered = structuredClone(built);
    tampered.agentEvidence.rows.find(
      (row) => row.observations.length,
    ).observations[0].result = "passed";
    expect(() =>
      index.validateAcceptanceIndex(tampered, authorities, { conditions }),
    ).toThrow();
    const drift = structuredClone(conditions);
    drift.text += "\n";
    expect(() =>
      index.validateAcceptanceIndex(built, authorities, { conditions: drift }),
    ).toThrow();
  });

  it("derives source identity from the exact parsed text, never a caller-supplied digest", () => {
    const document = structuredClone(original);
    document.rows[0].remainingCondition =
      "A deliberately changed historical note.";
    const changed = { path, text: JSON.stringify(document) };
    const result = parse(changed);
    expect(result.source.sha256).toBe(
      createHash("sha256").update(changed.text).digest("hex"),
    );
    expect(result.source.sha256).not.toBe(source.sha256);
    expect(result.rows[0].recordedRemainingCondition).toBe(
      document.rows[0].remainingCondition,
    );
    expect(() => parse({ ...changed, sha256: source.sha256 })).toThrow(
      /unknown conditions field/,
    );
  });
});
