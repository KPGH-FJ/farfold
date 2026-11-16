import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateReceipt } from "./acceptance-receipts.mjs";
import {
  buildAcceptanceIndex,
  evidenceLevels,
  loadAgentConditions,
  loadStage2Evidence,
  loadAcceptanceAuthorities,
  normalizeMapping,
  parseAcceptanceAuthorities,
  parseAcceptanceIndexArguments,
  parseAgentIds,
  parseStandards,
  queryAcceptanceIndex,
  runAcceptanceIndex,
  validateAcceptanceIndex,
  validateCoverage,
} from "./acceptance-index.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const authorities = loadAcceptanceAuthorities(root);
const agentId = authorities.agents[0];
const mapping = {
  links: [{ standardId: "S5", requirementIds: ["P18"] }],
  newPackages: {},
};
const p18 = authorities.requirements.find((item) => item.id === "P18");

function observation(changes = {}) {
  const level = changes.level ?? "installed";
  return {
    runId: "index-regression-run",
    caseId: "disk-diff-observation",
    agentId,
    standardIds: ["S5"],
    requirementIds: ["P18"],
    level: "installed",
    coveredConditions: [
      {
        conditionId: "requirement:P18",
        condition: p18.completion,
        excerpt: p18.completion.split("；")[0],
      },
    ],
    result: "passed",
    acceptanceVerified: false,
    requiresIndependentReview: true,
    attemptResults: [
      {
        attemptId: "attempt-1",
        status: "completed",
        outcome:
          changes.result === "expectedRejection" ? "rejection" : "success",
        level,
        issues: [],
      },
    ],
    ...changes,
  };
}

describe("derived acceptance authority and complete scope", () => {
  it("derives all identities, original standards and 151 conditions without a second catalog", () => {
    const index = buildAcceptanceIndex({ authorities });
    expect(index.cells).toHaveLength(208);
    expect(index.authorities.agents).toHaveLength(26);
    expect(index.authorities.standards.map((item) => item.id)).toEqual([
      "S1",
      "S2",
      "S3",
      "S4",
      "S5",
      "S6",
      "S7",
      "S8",
    ]);
    expect(index.authorities.requirements).toHaveLength(151);
    expect(index.authorities.packages).toHaveLength(16);
    expect(index.authorities.conditions).toHaveLength(177);
    expect(index.unmappedRequirementIds).toHaveLength(151);
    expect(index.cells.every((cell) => cell.acceptance === "unreviewed")).toBe(
      true,
    );
    expect(
      index.authorities.requirements.find((item) => item.id === "NEW-17").title,
    ).toContain("此具体缺陷关闭");
    expect(index.coverage).toEqual([]);
    expect(index.acceptanceVerified).toBe(false);
    expect(validateAcceptanceIndex(index, authorities)).toEqual({
      mechanicallyValid: true,
      acceptanceVerified: false,
      requiresIndependentReview: true,
      agents: 26,
      standards: 8,
      requirements: 151,
      cells: 208,
    });
  });

  it("rejects a missing or duplicate identity and an executable Rust catalog expression", () => {
    const source = readFileSync(
      resolve(root, "src-tauri/src/acp_client/first_release.rs"),
      "utf8",
    );
    const ids = parseAgentIds(source);
    expect(() => parseAgentIds(source.replace(`    "${ids[0]}",`, ""))).toThrow(
      /26/,
    );
    expect(() =>
      parseAgentIds(source.replace(`    "${ids[1]}",`, `    "${ids[0]}",`)),
    ).toThrow(/duplicate/);
    expect(() =>
      parseAgentIds(source.replace(`    "${ids[0]}",`, "    get_agent(),")),
    ).toThrow(/syntax/);
  });

  it("keeps complete PRODUCT text and rejects a missing or ninth standard", () => {
    const product = readFileSync(resolve(root, "PRODUCT.md"), "utf8");
    const original = parseStandards(product);
    expect(original[0].condition).toContain(
      "程序、账号、服务、模型以及取消返回可继续",
    );
    expect(() => parseStandards(product.replace(/^4\. .+\r?\n/m, ""))).toThrow(
      /eight/,
    );
    expect(() =>
      parseStandards(
        product.replace(/^8\. (.+)$/m, "8. $1\n9. invented condition"),
      ),
    ).toThrow(/eight/);
  });

  it("rejects a lost original requirement rather than generating a smaller green matrix", () => {
    const requirementsText = readFileSync(
      resolve(root, "docs/agent-access-requirements.md"),
      "utf8",
    ).replace(/^\| P18\s+\|.+\r?\n/m, "");
    expect(() =>
      parseAcceptanceAuthorities({
        productText: readFileSync(resolve(root, "PRODUCT.md"), "utf8"),
        firstReleaseText: readFileSync(
          resolve(root, "src-tauri/src/acp_client/first_release.rs"),
          "utf8",
        ),
        requirementsText,
      }),
    ).toThrow(/151/);
  });

  it("keeps missing-identity, standard and requirement rejection controls active with CRLF", () => {
    const asCrLf = (file) =>
      readFileSync(resolve(root, file), "utf8").replace(/\r?\n/g, "\r\n");
    const firstReleaseText = asCrLf(
      "src-tauri/src/acp_client/first_release.rs",
    );
    const productText = asCrLf("PRODUCT.md");
    const requirementsText = asCrLf("docs/agent-access-requirements.md");
    const ids = parseAgentIds(firstReleaseText);
    expect(() =>
      parseAgentIds(firstReleaseText.replace(`    "${ids[0]}",`, "")),
    ).toThrow(/26/);
    expect(() =>
      parseStandards(productText.replace(/^4\. .+\r?\n/m, "")),
    ).toThrow(/eight/);
    expect(() =>
      parseAcceptanceAuthorities({
        productText,
        firstReleaseText,
        requirementsText: requirementsText.replace(/^\| P18\s+\|.+\r?\n/m, ""),
      }),
    ).toThrow(/151/);
  });
});

describe("explicit mapping and dependency protection", () => {
  it("includes declared package dependencies and universal conditions without promoting scope decisions", () => {
    const index = buildAcceptanceIndex({ authorities, mapping });
    const cell = index.cells.find(
      (item) => item.agentId === agentId && item.standardId === "S5",
    );
    expect(cell.requirementIds).toEqual(["P18"]);
    expect(cell.packageIds).toEqual(
      expect.arrayContaining(["G", "F", "C", "K"]),
    );
    expect(index.unmappedRequirementIds).toHaveLength(150);
    expect(
      index.authorities.requirements.find((item) => item.id === "H20").package,
    ).toBe("Z");
    expect(
      index.authorities.requirements.find((item) => item.id === "P29").package,
    ).toBe("X");
    expect(cell.acceptance).toBe("unreviewed");
  });

  it("requires NEW ownership per ID, never using another NEW assignment or a title guess", () => {
    const linked = {
      links: [{ standardId: "S7", requirementIds: ["NEW-24"] }],
      newPackages: {},
    };
    expect(() => normalizeMapping(linked, authorities)).toThrow(
      /explicit newPackages/,
    );
    expect(() =>
      normalizeMapping(
        { ...linked, newPackages: { "NEW-29": ["C", "K"] } },
        authorities,
      ),
    ).toThrow(/NEW-24/);
    const explicit = normalizeMapping(
      { ...linked, newPackages: { "NEW-24": ["B", "C", "K"] } },
      authorities,
    );
    const index = buildAcceptanceIndex({ authorities, mapping: explicit });
    expect(index.mapping.newPackages["NEW-24"]).toEqual(["B", "C", "K"]);
    expect(index.unmappedRequirementIds).toContain("NEW-29");
    expect(index.cells.every((cell) => cell.acceptance === "unreviewed")).toBe(
      true,
    );
  });

  it("rejects unknown IDs, invented package owners, empty links and duplicate assignments", () => {
    for (const bad of [
      {
        links: [{ standardId: "S9", requirementIds: ["P18"] }],
        newPackages: {},
      },
      {
        links: [{ standardId: "S5", requirementIds: ["P999"] }],
        newPackages: {},
      },
      { links: [{ standardId: "S5", requirementIds: [] }], newPackages: {} },
      { links: [mapping.links[0], mapping.links[0]], newPackages: {} },
      { links: [], newPackages: { P18: ["G"] } },
      { links: [], newPackages: { "NEW-24": [] } },
      { links: [], newPackages: { "NEW-24": ["C", "C"] } },
      { links: [], newPackages: { "NEW-24": ["Q"] } },
      { ...mapping, acceptanceVerified: true },
    ])
      expect(() => normalizeMapping(bad, authorities)).toThrow();
  });
});

describe("evidence observations cannot become acceptance", () => {
  it("keeps unmapped P32 observations by requirement and never projects them into a standard, even if a later relation is added", () => {
    const p32 = authorities.requirements.find((item) => item.id === "P32");
    const only = observation({
      caseId: "p32-requirement-only",
      standardIds: [],
      requirementIds: ["P32"],
      coveredConditions: [
        {
          conditionId: "requirement:P32",
          condition: p32.completion,
          excerpt: "附件内容查找、来源和跳转",
        },
      ],
    });
    for (const chosenMapping of [
      undefined,
      {
        links: [{ standardId: "S8", requirementIds: ["P32"] }],
        newPackages: {},
      },
    ]) {
      const index = buildAcceptanceIndex({
        authorities,
        mapping: chosenMapping,
        coverage: [only],
      });
      expect(index.coverage).toEqual([only]);
      expect(index.cells).toHaveLength(208);
      expect(
        index.cells.every(
          (cell) =>
            cell.acceptance === "unreviewed" &&
            evidenceLevels.every(
              (level) => cell.observations[level].length === 0,
            ),
        ),
      ).toBe(true);
      expect(
        queryAcceptanceIndex(index, { requirementId: "P32" }, { authorities })
          .coverage,
      ).toEqual([only]);
      expect(
        queryAcceptanceIndex(
          index,
          { agentId, requirementId: "P32" },
          { authorities },
        ).coverage,
      ).toEqual([only]);
      expect(
        queryAcceptanceIndex(index, { standardId: "S8" }, { authorities })
          .coverage,
      ).toEqual([]);
      expect(
        validateAcceptanceIndex(index, authorities).acceptanceVerified,
      ).toBe(false);
    }
    const mixed = buildAcceptanceIndex({
      authorities,
      mapping,
      coverage: [observation(), only],
    });
    expect(
      queryAcceptanceIndex(mixed, { standardId: "S5" }, { authorities })
        .coverage,
    ).toEqual([observation()]);
    expect(
      queryAcceptanceIndex(mixed, { requirementId: "P32" }, { authorities })
        .coverage,
    ).toEqual([only]);
    expect(
      mixed.cells.filter((cell) => cell.observations.installed.length > 0),
    ).toHaveLength(1);
  });

  it("requires real requirement conditions for requirement-only successes and never borrows another NEW package assignment", () => {
    const p32 = authorities.requirements.find((item) => item.id === "P32");
    const only = observation({
      standardIds: [],
      requirementIds: ["P32"],
      coveredConditions: [
        {
          conditionId: "requirement:P32",
          condition: p32.completion,
          excerpt: "附件内容查找、来源和跳转",
        },
      ],
    });
    for (const change of [
      { requirementIds: [] },
      { requirementIds: ["P999"] },
      { requirementIds: ["P32", "P18"] },
      {
        coveredConditions: [authorities.common[0]].map((entry) => ({
          ...entry,
          excerpt: entry.condition,
        })),
      },
      {
        coveredConditions: [
          {
            conditionId: "standard:S3",
            condition: authorities.standards[2].condition,
            excerpt: "真实正文",
          },
        ],
      },
      {
        coveredConditions: [
          {
            ...only.coveredConditions[0],
            condition: only.coveredConditions[0].excerpt,
          },
        ],
      },
      {
        coveredConditions: [
          { ...only.coveredConditions[0], excerpt: "invented" },
        ],
      },
      {
        attemptResults: [
          {
            attemptId: "failed-first",
            status: "failed",
            outcome: "failure",
            level: "installed",
            issues: [],
          },
        ],
      },
      { acceptanceVerified: true },
    ])
      expect(() =>
        validateCoverage({ ...only, ...change }, authorities),
      ).toThrow();
    expect(() =>
      validateCoverage(
        observation({
          requirementIds: [],
          coveredConditions: [
            {
              conditionId: "standard:S5",
              condition: authorities.standards[4].condition,
              excerpt: "Agent工作能力完整",
            },
          ],
        }),
        authorities,
      ),
    ).toThrow();
    const new29 = authorities.requirements.find((item) => item.id === "NEW-29");
    const new24 = authorities.requirements.find((item) => item.id === "NEW-24");
    const newOnly = observation({
      standardIds: [],
      requirementIds: ["NEW-24", "NEW-29"],
      coveredConditions: [new24, new29].map((entry) => ({
        conditionId: entry.conditionId,
        condition: entry.completion,
        excerpt: entry.completion,
      })),
    });
    expect(() =>
      validateCoverage(newOnly, authorities, {
        links: [],
        newPackages: { "NEW-24": ["C", "K"] },
      }),
    ).toThrow(/NEW-29/);
    expect(
      validateCoverage(newOnly, authorities, {
        links: [],
        newPackages: { "NEW-24": ["C", "K"], "NEW-29": ["C", "D", "K"] },
      }).mechanicallyValid,
    ).toBe(true);
  });

  it("retains real successes and earlier failures as partial unreviewed observations at their exact level", () => {
    const cases = evidenceLevels.map((level) =>
      observation({ caseId: `case-${level}`, level }),
    );
    const index = buildAcceptanceIndex({
      authorities,
      mapping,
      coverage: cases,
    });
    const cell = index.cells.find(
      (item) => item.agentId === agentId && item.standardId === "S5",
    );
    for (const level of evidenceLevels)
      expect(cell.observations[level]).toEqual([
        { runId: "index-regression-run", caseId: `case-${level}` },
      ]);
    expect(index.coverage.every((item) => item.result === "passed")).toBe(true);
    expect(index.coverage[0].attemptResults[0].status).toBe("completed");
    expect(index.cells.every((item) => item.acceptance === "unreviewed")).toBe(
      true,
    );
    expect(index.acceptanceVerified).toBe(false);
    const other = index.cells.find(
      (item) => item.agentId !== agentId && item.standardId === "S5",
    );
    expect(other.observations["real-agent"]).toEqual([]);
  });

  it("rejects incomplete condition text, out-of-source excerpts and unrelated condition coverage", () => {
    const valid = observation();
    for (const coveredConditions of [
      [],
      [
        {
          ...valid.coveredConditions[0],
          condition: valid.coveredConditions[0].excerpt,
        },
      ],
      [
        {
          ...valid.coveredConditions[0],
          excerpt: "invented filesystem result",
        },
      ],
      [{ ...valid.coveredConditions[0], excerpt: " " }],
      [{ ...valid.coveredConditions[0], conditionId: "requirement:P32" }],
      [{ ...valid.coveredConditions[0], conditionId: "standard:S1" }],
      [{ ...valid.coveredConditions[0], conditionId: "package:N" }],
      [{ ...valid.coveredConditions[0], conditionId: "common:999" }],
      [{ ...valid.coveredConditions[0], complete: true }],
    ])
      expect(() =>
        validateCoverage(
          observation({ coveredConditions }),
          authorities,
          mapping,
        ),
      ).toThrow();
  });

  it("accepts exact applicable package, standard and universal excerpts only as observations", () => {
    const ids = [
      "standard:S5",
      "package:G",
      "package:C",
      "package:K",
      "common:1",
    ];
    const coveredConditions = ids.map((conditionId) => {
      const item = authorities.conditions.find(
        (condition) => condition.conditionId === conditionId,
      );
      return { ...item, excerpt: item.condition };
    });
    expect(
      validateCoverage(
        observation({ coveredConditions }),
        authorities,
        mapping,
      ),
    ).toEqual({
      mechanicallyValid: true,
      acceptanceVerified: false,
      requiresIndependentReview: true,
    });
  });

  it("rejects fake layers, missing IDs, unlinked requirements and self-accepted results", () => {
    for (const changed of [
      { level: "source" },
      { level: "real-agent-installed" },
      { agentId: "unknown-agent" },
      { standardIds: ["S9"] },
      { standardIds: ["S1"] },
      { standardIds: ["S1", "S5"] },
      { requirementIds: ["P999"] },
      { result: "accepted" },
      { acceptanceVerified: true },
      { requiresIndependentReview: false },
      { standardPassed: true },
      { caseDefinitionSha256: "private-not-a-digest" },
      { caseDefinitionSha256: null },
    ])
      expect(() =>
        validateCoverage(observation(changed), authorities, mapping),
      ).toThrow();
    const missing = observation();
    delete missing.coveredConditions;
    expect(() => validateCoverage(missing, authorities, mapping)).toThrow();
  });

  it("distinguishes blocked or unrun cases from an observed success and rejects duplicate case identities", () => {
    const blocked = observation({ result: "blocked", coveredConditions: [] });
    const index = buildAcceptanceIndex({
      authorities,
      mapping,
      coverage: [blocked],
    });
    expect(index.coverage[0].result).toBe("blocked");
    expect(index.cells.every((cell) => cell.acceptance === "unreviewed")).toBe(
      true,
    );
    expect(() =>
      buildAcceptanceIndex({
        authorities,
        mapping,
        coverage: [blocked, blocked],
      }),
    ).toThrow(/duplicate coverage case/);
    expect(() =>
      buildAcceptanceIndex({ authorities, mapping, coverage: [observation()] }),
    ).not.toThrow();
  });

  it("preserves expected rejections, incomplete attempts and unstable runs without calling them passes", () => {
    const coverage = [
      "expectedRejection",
      "incomplete",
      "unstable",
      "invalid",
    ].map((result) => observation({ caseId: result, result }));
    coverage
      .find((item) => item.result === "unstable")
      .attemptResults.unshift({
        attemptId: "earlier-failure",
        status: "failed",
        outcome: "failure",
        level: "installed",
        issues: [],
      });
    const index = buildAcceptanceIndex({ authorities, mapping, coverage });
    expect(index.coverage.map((item) => item.result)).toEqual([
      "expectedRejection",
      "incomplete",
      "unstable",
      "invalid",
    ]);
    expect(index.cells.every((cell) => cell.acceptance === "unreviewed")).toBe(
      true,
    );
    expect(index.coverage.some((item) => item.result === "passed")).toBe(false);
    const unsuccessful = index.coverage.find(
      (item) => item.result === "unstable",
    );
    expect(unsuccessful.attemptResults[0].status).toBe("failed");
    expect(() =>
      validateCoverage(
        { ...unsuccessful, result: "passed" },
        authorities,
        mapping,
      ),
    ).toThrow(/cannot be hidden/);
    expect(() =>
      validateCoverage(
        observation({ attemptResults: [] }),
        authorities,
        mapping,
      ),
    ).toThrow(/empty attempt history/);
    expect(() =>
      validateCoverage(
        observation({ attemptResults: ["failed", "passed"] }),
        authorities,
        mapping,
      ),
    ).toThrow(/object/);
  });

  it("detects authority drift, changed result layers, dropped cells and attempted all-green status", () => {
    const index = buildAcceptanceIndex({
      authorities,
      mapping,
      coverage: [observation()],
    });
    const changes = [
      (copy) => {
        copy.acceptanceVerified = true;
      },
      (copy) => {
        copy.cells[0].acceptance = "passed";
      },
      (copy) => {
        copy.cells.pop();
      },
      (copy) => {
        copy.authorities.sources.product.sha256 = "0".repeat(64);
      },
      (copy) => {
        copy.coverage[0].level = "real-agent";
      },
      (copy) => {
        copy.authorities.requirements.find(
          (item) => item.id === "P18",
        ).completion = "shortened";
      },
      (copy) => {
        copy.unmappedRequirementIds = [];
      },
      (copy) => {
        copy.schedulingAuthority = "active";
      },
    ];
    for (const change of changes) {
      const copy = structuredClone(index);
      change(copy);
      expect(() => validateAcceptanceIndex(copy, authorities)).toThrow();
      expect(() => queryAcceptanceIndex(copy, { agentId })).toThrow();
    }
  });
});

describe("read-only query and command-line contract", () => {
  it("does not echo malformed private CLI input and rejects overlarge JSON before parsing", async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), "farfold-index-cli-"));
    try {
      const malformed = resolve(temporary, "private.json");
      await writeFile(malformed, "PRIVATE_TEST_CLI_CONTENT_SHOULD_NOT_LEAK");
      const run = (file) =>
        spawnSync(
          process.execPath,
          [resolve(root, "scripts/acceptance-index.mjs"), "--mapping", file],
          { encoding: "utf8", timeout: 3000 },
        );
      const failed = run(malformed);
      expect(failed.status).toBe(1);
      expect(failed.stdout + failed.stderr).not.toContain("PRIVATE_TEST");
      expect(failed.stderr.trim()).toBe("acceptance-index-invalid-input");
      const oversized = resolve(temporary, "large.json");
      await writeFile(oversized, " ".repeat(4 * 1024 * 1024 + 1));
      expect(() => runAcceptanceIndex(["--mapping", oversized])).toThrow(
        /bounded regular JSON/,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO CLI input without waiting for a writer",
    async () => {
      const temporary = await mkdtemp(resolve(tmpdir(), "farfold-index-fifo-"));
      try {
        const fifo = resolve(temporary, "input.json");
        expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
        const failed = spawnSync(
          process.execPath,
          [resolve(root, "scripts/acceptance-index.mjs"), "--mapping", fifo],
          { encoding: "utf8", timeout: 2000 },
        );
        expect(failed.error).toBeUndefined();
        expect(failed.status).toBe(1);
        expect(failed.stderr.trim()).toBe("acceptance-index-invalid-input");
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );

  it("queries one Agent and standard while retaining unmapped requirements and current progress", () => {
    const index = buildAcceptanceIndex({
      authorities,
      mapping,
      coverage: [observation()],
    });
    const query = queryAcceptanceIndex(index, {
      agentId,
      standardId: "S5",
      requirementId: "P18",
    });
    expect(query.cells).toHaveLength(1);
    expect(query.coverage).toHaveLength(1);
    expect(query.requirements).toEqual([p18]);
    expect(query.unmappedRequirementIds).toHaveLength(150);
    expect(query.acceptanceVerified).toBe(false);
    expect(query.cells[0].acceptance).toBe("unreviewed");
    expect(
      queryAcceptanceIndex(index, { agentId, standardId: "S5" }).requirements,
    ).toEqual([p18]);
    for (const bad of [
      { agentId: "unknown" },
      { standardId: "S9" },
      { requirementId: "NEW-99" },
    ])
      expect(() => queryAcceptanceIndex(index, bad)).toThrow(/unknown/);
  });

  it("does not return all records as a fallback for invalid CLI input", () => {
    expect(
      parseAcceptanceIndexArguments(["--agent", agentId, "--standard", "S5"]),
    ).toEqual({ agentId, standardId: "S5" });
    for (const args of [
      ["--agent"],
      ["--agent", "--standard", "S5"],
      ["--out", "ignored.json"],
      ["--agent", agentId, "--agent", agentId],
      ["--validate", "index.json", "--mapping", "mapping.json"],
    ])
      expect(() => parseAcceptanceIndexArguments(args)).toThrow();
    expect(() =>
      runAcceptanceIndex(["--agent", "unknown"], { rootDir: root }),
    ).toThrow(/unknown/);
  });

  it("defaults to deterministic in-memory output and provides a read-only usage message", () => {
    expect(runAcceptanceIndex([], { rootDir: root })).toEqual(
      buildAcceptanceIndex({
        authorities,
        conditions: loadAgentConditions(root),
        stage2Evidence: loadStage2Evidence(root),
      }),
    );
    expect(runAcceptanceIndex(["--help"])).toContain("writes JSON to stdout");
    expect(
      runAcceptanceIndex(["--agent", agentId, "--standard", "S5"], {
        rootDir: root,
      }).cells,
    ).toHaveLength(1);
  });
});

describe("receipt validator to acceptance index integration", () => {
  it.each([
    [false, "shared"],
    [true, "shared"],
    [true, "installed"],
  ])(
    "indexes validator summaries without inventing standards or model selection (requirement only: %s, level: %s)",
    async (requirementOnly, level) => {
      const temporaryRoot = await mkdtemp(
        resolve(tmpdir(), "farfold-index-receipt-"),
      );
      const digest = (bytes) =>
        createHash("sha256").update(bytes).digest("hex");
      try {
        await mkdir(resolve(temporaryRoot, "output/run"), { recursive: true });
        const context = {
          agentId,
          platform: "darwin-arm64",
          productCommit: "abcdef12",
          ...(level === "installed"
            ? {
                app: {
                  bundleId: "ai.farfold.desktop",
                  version: "0.1.7",
                  binarySha256: "a".repeat(64),
                  installedPath: "/Applications/Farfold.app",
                },
                observedAgentVersion: "synthetic-observed-version",
              }
            : {}),
        };
        const source = level === "installed" ? "installed-ui" : "test-runner";
        const inputs = { source: "synthetic-source-revision" };
        const manifest = {
          schemaVersion: 1,
          runId: "synthetic-integration-run",
          preparedAt: "2026-10-24T00:00:00Z",
          reviewBy: "2026-10-25T00:00:00Z",
          context,
          inputs,
          dependencies: [
            { id: "source:diff", kind: "source", fingerprint: "test-revision" },
          ],
          expectedCases: [
            {
              caseId: "synthetic-diff-case",
              agentId,
              standardIds: requirementOnly ? [] : ["S5"],
              requirementIds: ["P18"],
              level,
              expectedOutcome: "success",
              safety: "observation",
              coveredConditions: observation().coveredConditions,
              requiredObservations: [
                {
                  observationId: "synthetic-file",
                  kind: "content-confirmed",
                  source,
                  expectedValue: "synthetic-content-only",
                },
              ],
              dependencies: ["source:diff"],
            },
          ],
        };
        const evidenceBytes = Buffer.from(
          "Synthetic integration fixture; no installed or Agent effect.\n",
        );
        await writeFile(
          resolve(temporaryRoot, "output/run/evidence.txt"),
          evidenceBytes,
        );
        const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
        await writeFile(
          resolve(temporaryRoot, "output/run/manifest.json"),
          manifestBytes,
        );
        const receipt = {
          schemaVersion: 1,
          runId: manifest.runId,
          manifest: {
            path: "output/run/manifest.json",
            sha256: digest(manifestBytes),
            visibility: "public",
            privacyReviewed: true,
          },
          attempts: [
            {
              attemptId: "synthetic-attempt-1",
              caseId: "synthetic-diff-case",
              startedAt: "2026-10-24T00:01:00Z",
              finishedAt: "2026-10-24T00:02:00Z",
              status: "completed",
              outcome: "success",
              level,
              context,
              inputsBefore: inputs,
              inputsAfter: inputs,
              observations: [
                {
                  observationId: "synthetic-file",
                  kind: "content-confirmed",
                  source,
                  value: "synthetic-content-only",
                  evidenceIndexes: [0],
                },
              ],
              evidence: [
                {
                  path: "output/run/evidence.txt",
                  sha256: digest(evidenceBytes),
                  visibility: "private",
                  level,
                  source,
                },
              ],
            },
          ],
          inputsAfter: inputs,
          finishedAt: "2026-10-24T00:03:00Z",
        };
        const report = await validateReceipt(receipt, {
          rootDir: temporaryRoot,
        });
        expect(report.errors).toEqual([]);
        expect(report.mechanicallyValid).toBe(true);
        expect(report.cases[0].result).toBe("passed");
        const index = buildAcceptanceIndex({
          authorities,
          mapping,
          coverage: report.cases,
        });
        expect(index.coverage[0].runId).toBe(manifest.runId);
        expect(index.coverage[0].caseDefinitionSha256).toBe(
          report.cases[0].caseDefinitionSha256,
        );
        expect(
          index.cells.every((cell) => cell.acceptance === "unreviewed"),
        ).toBe(true);
        const cell = index.cells.find(
          (item) => item.agentId === agentId && item.standardId === "S5",
        );
        expect(cell.observations.shared).toHaveLength(requirementOnly ? 0 : 1);
        if (requirementOnly) {
          expect(index.coverage[0].standardIds).toEqual([]);
          expect(
            queryAcceptanceIndex(
              index,
              { requirementId: "P18" },
              { authorities },
            ).coverage,
          ).toEqual(report.cases);
          expect(
            queryAcceptanceIndex(index, { standardId: "S5" }, { authorities })
              .coverage,
          ).toEqual([]);
        }
        expect(cell.observations["real-agent"]).toEqual([]);

        await writeFile(
          resolve(temporaryRoot, "output/run/evidence.txt"),
          "Changed fixture bytes\n",
        );
        const invalidReport = await validateReceipt(receipt, {
          rootDir: temporaryRoot,
        });
        expect(invalidReport.mechanicallyValid).toBe(false);
        expect(invalidReport.cases[0].result).toBe("invalid");
        const invalidIndex = buildAcceptanceIndex({
          authorities,
          mapping,
          coverage: invalidReport.cases,
        });
        expect(invalidIndex.coverage[0].result).toBe("invalid");
        expect(
          invalidIndex.coverage[0].attemptResults[0].issues.length,
        ).toBeGreaterThan(0);
        expect(invalidIndex.acceptanceVerified).toBe(false);
      } finally {
        await rm(temporaryRoot, { recursive: true });
      }
    },
  );
});
