import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const agentConditionsPath =
  "docs/evidence/2026-11-06-cycle-01/agent-conditions.json";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function keys(value, required, optional = []) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    "expected conditions object",
  );
  for (const field of required)
    assert.ok(
      Object.hasOwn(value, field),
      `missing conditions field: ${field}`,
    );
  for (const field of Object.keys(value))
    assert.ok(
      required.includes(field) || optional.includes(field),
      `unknown conditions field: ${field}`,
    );
}

function text(value) {
  assert.ok(typeof value === "string" && value.trim(), "empty conditions text");
}

function list(value, { empty = false } = {}) {
  assert.ok(
    Array.isArray(value) && (empty || value.length > 0),
    "missing conditions list",
  );
  assert.equal(new Set(value).size, value.length, "duplicate conditions value");
}

/** A read-only projection of a dated ledger, never a current task queue.
 * References are checked for shape/existence only; their contents are not
 * interpreted, followed recursively, or promoted to an acceptance result. */
export function parseAgentConditions(
  input,
  authorities,
  { rootDir = repositoryRoot } = {},
) {
  keys(input, ["path", "text"]);
  assert.equal(
    input.path,
    agentConditionsPath,
    "unexpected stage-one evidence source",
  );
  text(input.text);
  const data = JSON.parse(input.text);
  keys(data, [
    "kind",
    "basedOnCommit",
    "counts",
    "scope",
    "stage1SupplementScope",
    "stage1SupplementEvidencePaths",
    "installedCapabilityDeclarationCheck",
    "rows",
    "stage1Exit",
  ]);
  assert.equal(
    data.kind,
    "AgentAcceptanceConditionsAtStage1",
    "unknown conditions kind",
  );
  assert.match(data.basedOnCommit, /^[a-f0-9]{40}$/, "invalid recorded commit");
  text(data.scope);
  text(data.stage1SupplementScope);
  // Keep historical ledger identities that later left the release scope.
  const recordedAgentIds = [
    ...new Set([
      ...authorities.agents,
      "kimi",
      "nova",
      "qwen-code",
      "dimcode",
      "factory-droid",
      "poolside",
      "kimchi",
      "sigit",
    ]),
  ];
  const checkedPaths = new Set();
  const evidencePath = (path) => {
    text(path);
    assert.ok(
      path === "PRODUCT.md" ||
        /^docs\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:md|json)$/.test(path),
      "invalid evidence reference",
    );
    assert.ok(
      !path.split("/").some((part) => part === "." || part === ".."),
      "invalid evidence reference",
    );
    if (rootDir && !checkedPaths.has(path)) {
      assert.ok(
        lstatSync(resolve(rootDir, path)).isFile(),
        "evidence reference is not a regular file",
      );
      checkedPaths.add(path);
    }
    return path;
  };
  const paths = (values) => {
    list(values);
    return values.map(evidencePath);
  };
  const standardIds = (values) => {
    list(values);
    for (const id of values)
      assert.ok(
        authorities.standards.some((item) => item.id === id),
        "unknown conditions standard",
      );
    return [...values];
  };
  paths(data.stage1SupplementEvidencePaths);
  keys(data.counts, [
    "agents",
    "standardsPerAgent",
    "scopedHistoryCombinations",
    "wholeAgentConfirmed",
  ]);
  assert.equal(
    data.counts.agents,
    recordedAgentIds.length,
    "conditions identity count mismatch",
  );
  assert.equal(
    data.counts.standardsPerAgent,
    authorities.standards.length,
    "conditions standard count mismatch",
  );
  for (const count of Object.values(data.counts))
    assert.ok(Number.isInteger(count) && count >= 0, "invalid recorded count");
  assert.ok(
    data.counts.wholeAgentConfirmed <= recordedAgentIds.length,
    "invalid recorded Agent count",
  );
  const declaration = data.installedCapabilityDeclarationCheck;
  keys(declaration, [
    "environment",
    "projectionSha256",
    "scope",
    "reportedProgramVersions",
  ]);
  text(declaration.environment);
  text(declaration.scope);
  assert.match(declaration.projectionSha256, /^[a-f0-9]{64}$/);
  keys(declaration.reportedProgramVersions, [], recordedAgentIds);
  for (const version of Object.values(declaration.reportedProgramVersions))
    text(version);
  const exit = data.stage1Exit;
  keys(exit, [
    "decision",
    "sourceCodeCommit",
    "evidencePath",
    "missingConditionsCountedPassed",
    "wholeAgentAcceptanceUnchanged",
    "nextCycle",
    "nextStageNotStarted",
  ]);
  text(exit.decision);
  assert.match(exit.sourceCodeCommit, /^[a-f0-9]{40}$/);
  evidencePath(exit.evidencePath);
  for (const key of [
    "missingConditionsCountedPassed",
    "wholeAgentAcceptanceUnchanged",
    "nextStageNotStarted",
  ])
    assert.equal(typeof exit[key], "boolean");
  assert.ok(Number.isInteger(exit.nextCycle) && exit.nextCycle > 0);
  list(data.rows);
  assert.equal(
    data.rows.length,
    recordedAgentIds.length,
    "missing conditions Agent",
  );
  const seen = new Set();
  const rows = data.rows.map((row, rowIndex) => {
    keys(
      row,
      [
        "agentId",
        "name",
        "remainingCondition",
        "evidencePaths",
        "scopedHistoryEvidence",
      ],
      ["stage1Supplement"],
    );
    assert.ok(
      recordedAgentIds.includes(row.agentId),
      "unknown conditions Agent",
    );
    assert.ok(!seen.has(row.agentId), "duplicate conditions Agent");
    seen.add(row.agentId);
    text(row.name);
    text(row.remainingCondition);
    paths(row.evidencePaths);
    const history = row.scopedHistoryEvidence;
    if (history !== null && typeof history !== "string") {
      keys(history, [
        "agent",
        "platform",
        "service",
        "modelLabel",
        "reasoningLabel",
        "modeLabel",
        "objectScope",
      ]);
      assert.equal(
        history.agent,
        row.agentId,
        "history belongs to another Agent",
      );
      Object.values(history).forEach(text);
    } else if (history !== null) text(history);
    const sourcePointer = `/rows/${rowIndex}`;
    const observations = [];
    const supplement = row.stage1Supplement;
    if (supplement !== undefined) {
      keys(supplement, [
        "authenticationBoundary",
        "remainingCondition",
        "verifiedSamples",
      ]);
      text(supplement.authenticationBoundary);
      text(supplement.remainingCondition);
      list(supplement.verifiedSamples, { empty: true });
      supplement.verifiedSamples.forEach((sample, sampleIndex) => {
        keys(
          sample,
          ["standards", "environment", "result", "evidencePaths"],
          ["sampleKind"],
        );
        text(sample.environment);
        text(sample.result);
        if (sample.sampleKind !== undefined) text(sample.sampleKind);
        observations.push({
          id: `stage1-${sampleIndex}`,
          origin: "stage1-sample",
          standardIds: standardIds(sample.standards),
          scope: sample.environment,
          summary: sample.result,
          result: "unclassified",
          level: null,
          review: "unreviewed-claim",
          evidencePaths: paths(sample.evidencePaths),
          sourcePointer: `${sourcePointer}/stage1Supplement/verifiedSamples/${sampleIndex}`,
        });
      });
    }
    return {
      agentId: row.agentId,
      name: row.name,
      sourcePointer,
      recordedRemainingCondition: row.remainingCondition,
      stage1RemainingCondition: supplement?.remainingCondition ?? null,
      unassignedEvidence: {
        evidencePaths: [...row.evidencePaths],
        scopedHistoryEvidence: structuredClone(history),
        stage1AuthenticationBoundary:
          supplement?.authenticationBoundary ?? null,
      },
      observations,
    };
  });
  assert.equal(
    data.counts.scopedHistoryCombinations,
    rows.filter((row) => row.unassignedEvidence.scopedHistoryEvidence !== null)
      .length,
    "history count mismatch",
  );
  return {
    role: "stage1-evidence-not-current-status",
    source: {
      path: input.path,
      sha256: createHash("sha256").update(input.text).digest("hex"),
    },
    basedOnCommit: data.basedOnCommit,
    recordedCounts: { ...data.counts },
    scope: data.scope,
    stage1SupplementScope: data.stage1SupplementScope,
    currentStatusSource: "docs/status.md",
    limitations: [
      "Recorded remaining conditions and stage-one notes describe their original scope and time, not the latest project status.",
      "Unassigned references do not establish any standard coverage; prose results are not classified automatically.",
      "Recorded counts and remaining conditions retain the ledger's historical scope; current facts are in docs/status.md.",
    ],
    rows,
  };
}
