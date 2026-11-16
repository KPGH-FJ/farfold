import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseTaskReference,
  resolveTaskProgress,
  selectTaskRequirements,
  taskReferencePath,
  taskStatusPath,
} from "./agent-task-reference.mjs";
import {
  agentConditionsPath,
  parseAgentConditions,
} from "./acceptance-agent-conditions.mjs";
export { parseAgentConditions } from "./acceptance-agent-conditions.mjs";
import {
  parseStage2Evidence,
  stage2EvidencePath,
} from "./acceptance-stage2-evidence.mjs";
export { parseStage2Evidence } from "./acceptance-stage2-evidence.mjs";

// An evidence-side index, not an execution queue or a product event store.
// Nothing here establishes the truth of an observation or accepts an Agent.
export const evidenceLevels = ["shared", "protocol", "installed", "real-agent"];
export const acceptanceIndexRole = "acceptance-evidence-index";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directoryPath = "src-tauri/src/acp_client/first_release.rs";
const results = [
  "passed",
  "expectedRejection",
  "failed",
  "incomplete",
  "unstable",
  "invalid",
  "unknown",
  "blocked",
  "not-run",
];

function object(value, name) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${name} must be an object`,
  );
}

function exactKeys(value, required, optional, name) {
  object(value, name);
  for (const key of required)
    assert.ok(Object.hasOwn(value, key), `${name}.${key} missing`);
  for (const key of Object.keys(value))
    assert.ok(
      required.includes(key) || optional.includes(key),
      `unknown ${name} field: ${key}`,
    );
}

function nonempty(value, name) {
  assert.ok(typeof value === "string" && value.trim(), `${name} missing`);
}

function unique(values, name, { allowEmpty = false } = {}) {
  assert.ok(Array.isArray(values), `${name} must be an array`);
  assert.ok(allowEmpty || values.length > 0, `${name} missing`);
  assert.equal(new Set(values).size, values.length, `duplicate ${name}`);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function parseAgentIds(text) {
  const match = /const INCLUDED:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/.exec(text);
  assert.ok(match, "official first-release INCLUDED array missing");
  const array = match[1].replace(/\/\/[^\n]*/g, "");
  assert.ok(
    /^\s*(?:"[a-z0-9]+(?:-[a-z0-9]+)*"\s*,\s*)+$/.test(array),
    "unexpected first-release INCLUDED array syntax",
  );
  const ids = [...array.matchAll(/"([^"]+)"/g)].map((item) => item[1]);
  unique(ids, "first-release identity");
  assert.equal(ids.length, 23, "expected all 23 first-release identities");
  return ids;
}

export function parseStandards(text) {
  const section = /^## 3\. [^\n]+\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(
    text,
  )?.[1];
  assert.ok(section, "PRODUCT section 3 missing");
  const standards = [...section.matchAll(/^(\d+)\. (.+)$/gm)].map(
    ([, number, condition]) => ({ id: `S${number}`, condition }),
  );
  assert.deepEqual(
    standards.map((item) => item.id),
    Array.from({ length: 8 }, (_, i) => `S${i + 1}`),
    "expected the original eight PRODUCT standards in order",
  );
  return standards;
}

export function parseAcceptanceAuthorities({
  productText,
  firstReleaseText,
  requirementsText,
  statusText,
}) {
  const parsed = parseTaskReference(requirementsText);
  const reference =
    statusText === undefined ? parsed : resolveTaskProgress(parsed, statusText);
  assert.equal(reference.tasks.size, 151, "expected all 151 requirements");
  const newIds = [...reference.tasks.keys()].filter((id) =>
    id.startsWith("NEW-"),
  );
  assert.deepEqual(
    newIds,
    Array.from(
      { length: 29 },
      (_, i) => `NEW-${String(i + 1).padStart(2, "0")}`,
    ),
    "expected NEW-01 through NEW-29, in source order",
  );
  const agents = parseAgentIds(firstReleaseText);
  const standards = parseStandards(productText);
  const requirements = [...reference.tasks.values()].map((item) => ({
    ...item,
    // Progress is retained as source prose. It never drives an acceptance state.
    conditionId: `requirement:${item.id}`,
  }));
  const packages = [...reference.packages].map(([id, item]) => ({
    id,
    ...item,
    conditionId: `package:${id}`,
  }));
  const common = reference.common.map((condition, i) => ({
    conditionId: `common:${i + 1}`,
    condition,
  }));
  const conditions = [
    ...standards.map((item) => ({
      conditionId: `standard:${item.id}`,
      condition: item.condition,
    })),
    ...requirements.map((item) => ({
      conditionId: item.conditionId,
      condition: item.completion,
    })),
    ...packages.map((item) => ({
      conditionId: item.conditionId,
      condition: item.completion,
    })),
    ...common,
  ];
  return {
    sources: {
      product: { path: "PRODUCT.md", sha256: sha256(productText) },
      directory: { path: directoryPath, sha256: sha256(firstReleaseText) },
      requirements: {
        path: taskReferencePath,
        sha256: sha256(requirementsText),
      },
      ...(statusText === undefined
        ? {}
        : {
            status: { path: taskStatusPath, sha256: sha256(statusText) },
          }),
    },
    agents,
    standards,
    requirements,
    packages,
    common,
    conditions,
    scope: reference.scope,
  };
}

export function loadAcceptanceAuthorities(rootDir = root) {
  return parseAcceptanceAuthorities({
    productText: readFileSync(resolve(rootDir, "PRODUCT.md"), "utf8"),
    firstReleaseText: readFileSync(resolve(rootDir, directoryPath), "utf8"),
    requirementsText: readFileSync(resolve(rootDir, taskReferencePath), "utf8"),
    statusText: readFileSync(resolve(rootDir, taskStatusPath), "utf8"),
  });
}

export function loadAgentConditions(rootDir = root) {
  return {
    path: agentConditionsPath,
    text: readBoundedJson(resolve(rootDir, agentConditionsPath), true),
  };
}

export function loadStage2Evidence(rootDir = root) {
  return {
    path: stage2EvidencePath,
    text: readBoundedJson(resolve(rootDir, stage2EvidencePath), true),
  };
}

function taskReference(authorities) {
  return {
    tasks: new Map(authorities.requirements.map((item) => [item.id, item])),
    packages: new Map(authorities.packages.map((item) => [item.id, item])),
    common: authorities.common.map((item) => item.condition),
    scope: authorities.scope,
  };
}

export function normalizeMapping(
  mapping = { links: [], newPackages: {} },
  authorities,
) {
  exactKeys(mapping, ["links", "newPackages"], [], "mapping");
  assert.ok(Array.isArray(mapping.links), "mapping.links must be an array");
  object(mapping.newPackages, "mapping.newPackages");
  const tasks = new Set(authorities.requirements.map((item) => item.id));
  const standards = new Set(authorities.standards.map((item) => item.id));
  const packages = new Set(authorities.packages.map((item) => item.id));
  const links = new Map();
  for (const link of mapping.links) {
    exactKeys(link, ["standardId", "requirementIds"], [], "mapping link");
    assert.ok(
      standards.has(link.standardId),
      `unknown standard: ${link.standardId}`,
    );
    assert.ok(
      !links.has(link.standardId),
      `duplicate mapping: ${link.standardId}`,
    );
    unique(link.requirementIds, "mapped requirement ID");
    for (const id of link.requirementIds)
      assert.ok(tasks.has(id), `unknown requirement: ${id}`);
    links.set(link.standardId, link.requirementIds);
  }
  const newPackages = {};
  for (const [id, assigned] of Object.entries(mapping.newPackages)) {
    assert.ok(tasks.has(id) && id.startsWith("NEW-"), `unknown NEW ID: ${id}`);
    unique(assigned, `explicit packages for ${id}`);
    for (const name of assigned)
      assert.ok(packages.has(name), `unknown work package: ${name}`);
    newPackages[id] = authorities.packages
      .filter((item) => assigned.includes(item.id))
      .map((item) => item.id);
  }
  for (const ids of links.values())
    for (const id of ids)
      if (id.startsWith("NEW-"))
        assert.ok(
          Object.hasOwn(newPackages, id),
          `NEW requirement ${id} needs explicit newPackages; no inferred owner`,
        );
  return {
    links: authorities.standards
      .filter((item) => links.has(item.id))
      .map((item) => ({
        standardId: item.id,
        requirementIds: authorities.requirements
          .filter((task) => links.get(item.id).includes(task.id))
          .map((task) => task.id),
      })),
    newPackages,
  };
}

function neededPackageIds(requirementIds, mapping, authorities) {
  if (!requirementIds.length) return [];
  const extraPackages = [
    ...new Set(requirementIds.flatMap((id) => mapping.newPackages[id] ?? [])),
  ];
  return selectTaskRequirements(
    taskReference(authorities),
    requirementIds,
    extraPackages,
  ).packages.map((item) => item.id);
}

// This checks references and exact source text, not observations, authority,
// permissions, test execution, or whether the claimed evidence level is true.
export function validateCoverage(coverage, authorities, mapping) {
  const normalized = normalizeMapping(mapping, authorities);
  exactKeys(
    coverage,
    [
      "caseId",
      "agentId",
      "standardIds",
      "requirementIds",
      "level",
      "coveredConditions",
      "result",
      "acceptanceVerified",
    ],
    [
      "runId",
      "attemptResults",
      "requiresIndependentReview",
      "caseDefinitionSha256",
    ],
    "coverage",
  );
  nonempty(coverage.caseId, "caseId");
  if (coverage.runId !== undefined) nonempty(coverage.runId, "runId");
  if (coverage.caseDefinitionSha256 !== undefined)
    assert.ok(
      typeof coverage.caseDefinitionSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(coverage.caseDefinitionSha256),
      "case definition digest must be a SHA256 string",
    );
  assert.ok(authorities.agents.includes(coverage.agentId), "unknown agentId");
  unique(coverage.standardIds, "coverage standardIds", {
    allowEmpty: true,
  });
  unique(coverage.requirementIds, "coverage requirementIds");
  const standards = new Set(authorities.standards.map((item) => item.id));
  const requirements = new Set(authorities.requirements.map((item) => item.id));
  for (const id of coverage.standardIds)
    assert.ok(standards.has(id), `unknown standard: ${id}`);
  for (const id of coverage.requirementIds) {
    assert.ok(requirements.has(id), `unknown requirement: ${id}`);
    if (id.startsWith("NEW-"))
      assert.ok(
        Object.hasOwn(normalized.newPackages, id),
        `NEW requirement ${id} needs explicit newPackages; no inferred owner`,
      );
    if (coverage.standardIds.length > 0)
      assert.ok(
        normalized.links.some(
          (link) =>
            coverage.standardIds.includes(link.standardId) &&
            link.requirementIds.includes(id),
        ),
        `unmapped coverage requirement: ${id}`,
      );
  }
  for (const id of coverage.standardIds)
    assert.ok(
      coverage.requirementIds.length === 0 ||
        normalized.links.some(
          (link) =>
            link.standardId === id &&
            link.requirementIds.some((task) =>
              coverage.requirementIds.includes(task),
            ),
        ) ||
        coverage.coveredConditions?.some(
          (item) => item.conditionId === `standard:${id}`,
        ),
      `standard has no mapped requirement or direct condition coverage: ${id}`,
    );
  assert.ok(evidenceLevels.includes(coverage.level), "unknown evidence level");
  assert.ok(results.includes(coverage.result), "unknown coverage result");
  assert.equal(
    coverage.acceptanceVerified,
    false,
    "coverage cannot accept an Agent",
  );
  if (coverage.requiresIndependentReview !== undefined)
    assert.equal(
      coverage.requiresIndependentReview,
      true,
      "review cannot be bypassed",
    );
  if (coverage.attemptResults !== undefined) {
    assert.ok(
      Array.isArray(coverage.attemptResults),
      "attemptResults must be an array",
    );
    for (const attempt of coverage.attemptResults) {
      exactKeys(
        attempt,
        ["attemptId", "status", "outcome", "level", "issues"],
        [],
        "attempt result",
      );
      nonempty(attempt.attemptId, "attemptId");
      assert.ok(
        [
          "started",
          "completed",
          "failed",
          "cancelled",
          "timed-out",
          "unknown",
        ].includes(attempt.status),
        "unknown attempt status",
      );
      assert.ok(
        ["success", "rejection", "failure", "unknown"].includes(
          attempt.outcome,
        ),
        "unknown attempt outcome",
      );
      assert.ok(
        evidenceLevels.includes(attempt.level),
        "unknown attempt evidence level",
      );
      assert.ok(
        Array.isArray(attempt.issues),
        "attempt issues must be an array",
      );
      if (["passed", "expectedRejection"].includes(coverage.result))
        assert.ok(
          attempt.status === "completed" &&
            attempt.outcome ===
              (coverage.result === "passed" ? "success" : "rejection") &&
            attempt.level === coverage.level &&
            attempt.issues.length === 0,
          "unsuccessful or invalid attempt cannot be hidden by a successful case result",
        );
    }
    assert.ok(
      !["passed", "expectedRejection"].includes(coverage.result) ||
        coverage.attemptResults.length > 0,
      "successful case cannot have an empty attempt history",
    );
  }
  assert.ok(
    Array.isArray(coverage.coveredConditions),
    "coveredConditions missing",
  );
  assert.ok(
    !["passed", "expectedRejection"].includes(coverage.result) ||
      coverage.coveredConditions.length > 0,
    "successful case needs explicit covered conditions",
  );
  const allowed = new Set([
    ...coverage.standardIds.map((id) => `standard:${id}`),
    ...coverage.requirementIds.map((id) => `requirement:${id}`),
    ...neededPackageIds(coverage.requirementIds, normalized, authorities).map(
      (id) => `package:${id}`,
    ),
    ...authorities.common.map((item) => item.conditionId),
  ]);
  const conditions = new Map(
    authorities.conditions.map((item) => [item.conditionId, item.condition]),
  );
  const seen = new Set();
  for (const covered of coverage.coveredConditions) {
    exactKeys(
      covered,
      ["conditionId", "condition", "excerpt"],
      [],
      "covered condition",
    );
    assert.ok(conditions.has(covered.conditionId), "unknown conditionId");
    assert.ok(
      allowed.has(covered.conditionId),
      "condition outside declared coverage",
    );
    assert.equal(
      covered.condition,
      conditions.get(covered.conditionId),
      "covered condition must preserve the full authoritative condition",
    );
    nonempty(covered.excerpt, "covered condition excerpt");
    assert.ok(
      covered.condition.includes(covered.excerpt),
      "excerpt is not an exact part of its authoritative condition",
    );
    const key = JSON.stringify([covered.conditionId, covered.excerpt]);
    assert.ok(!seen.has(key), "duplicate covered condition excerpt");
    seen.add(key);
  }
  if (
    coverage.standardIds.length === 0 &&
    ["passed", "expectedRejection"].includes(coverage.result)
  )
    assert.ok(
      coverage.requirementIds.every((id) =>
        coverage.coveredConditions.some(
          (item) => item.conditionId === `requirement:${id}`,
        ),
      ),
      "requirement-only success needs each declared requirement condition",
    );
  return {
    mechanicallyValid: true,
    acceptanceVerified: false,
    requiresIndependentReview: true,
  };
}

export function buildAcceptanceIndex({
  authorities,
  mapping,
  coverage = [],
  conditions,
  stage2Evidence,
  rootDir = root,
}) {
  const normalized = normalizeMapping(mapping, authorities);
  const agentEvidence =
    conditions === undefined
      ? undefined
      : parseAgentConditions(conditions, authorities, { rootDir });
  if (stage2Evidence !== undefined) {
    assert.ok(
      agentEvidence,
      "stage-two supplement requires the Agent evidence index",
    );
    agentEvidence.supplements = [
      parseStage2Evidence(stage2Evidence, authorities, { rootDir }),
    ];
  }
  assert.ok(
    Array.isArray(coverage),
    "coverage must be an array of validated cases",
  );
  const caseKeys = new Set();
  for (const item of coverage) {
    validateCoverage(item, authorities, normalized);
    const key = JSON.stringify([item.runId ?? null, item.caseId]);
    assert.ok(!caseKeys.has(key), `duplicate coverage case: ${item.caseId}`);
    caseKeys.add(key);
  }
  const cells = authorities.agents.flatMap((agentId) =>
    authorities.standards.map((standard) => {
      const requirementIds =
        normalized.links.find((item) => item.standardId === standard.id)
          ?.requirementIds ?? [];
      const declaredObservations = [
        ...(agentEvidence?.rows
          .find((row) => row.agentId === agentId)
          .observations.filter((item) =>
            item.standardIds.includes(standard.id),
          ) ?? []),
        ...(agentEvidence?.supplements?.flatMap((supplement) =>
          supplement.observations.filter(
            (item) =>
              item.agentId === agentId &&
              item.standardIds.includes(standard.id),
          ),
        ) ?? []),
      ];
      const hasCoverage = coverage.some(
        (item) =>
          item.agentId === agentId && item.standardIds.includes(standard.id),
      );
      return {
        agentId,
        standardId: standard.id,
        requirementIds,
        packageIds: neededPackageIds(requirementIds, normalized, authorities),
        observationStatus:
          hasCoverage || declaredObservations.length
            ? "indexed-unreviewed"
            : "not-indexed",
        ...(agentEvidence === undefined
          ? {}
          : {
              declaredObservations: declaredObservations.map((item) => ({
                ...(item.source === undefined ? {} : { source: item.source }),
                sourcePointer: item.sourcePointer,
                result: item.result,
              })),
            }),
        // Empty means no indexed observations, not failed or never tested.
        observations: Object.fromEntries(
          evidenceLevels.map((level) => [
            level,
            coverage
              .filter(
                (item) =>
                  item.agentId === agentId &&
                  item.standardIds.includes(standard.id) &&
                  item.level === level,
              )
              .map((item) => ({
                runId: item.runId ?? null,
                caseId: item.caseId,
              })),
          ]),
        ),
        acceptance: "unreviewed",
      };
    }),
  );
  const mapped = new Set(
    normalized.links.flatMap((item) => item.requirementIds),
  );
  return {
    schemaVersion: 1,
    role: acceptanceIndexRole,
    schedulingAuthority: "none",
    acceptanceVerified: false,
    requiresIndependentReview: true,
    limitations: [
      "Mappings and evidence levels are explicit claims, not proof of applicability or real effects.",
      "An empty observation group does not override existing evidence, success, failure, or unknown results.",
      "No case result is promoted to a standard, requirement, Agent, or product acceptance.",
      "Execution order remains exclusively in plans/agent-access.md.",
    ],
    authorities,
    mapping: normalized,
    unmappedRequirementIds: authorities.requirements
      .filter((item) => !mapped.has(item.id))
      .map((item) => item.id),
    coverage: structuredClone(coverage),
    ...(agentEvidence === undefined ? {} : { agentEvidence }),
    cells,
  };
}

export function validateAcceptanceIndex(
  index,
  authorities,
  { conditions, stage2Evidence, rootDir = root } = {},
) {
  object(index, "index");
  const rebuilt = buildAcceptanceIndex({
    authorities,
    mapping: index.mapping,
    coverage: index.coverage,
    ...(index.agentEvidence === undefined
      ? {}
      : {
          conditions: conditions ?? loadAgentConditions(rootDir),
          ...(index.agentEvidence.supplements === undefined
            ? {}
            : {
                stage2Evidence: stage2Evidence ?? loadStage2Evidence(rootDir),
              }),
          rootDir,
        }),
  });
  assert.deepEqual(
    index,
    rebuilt,
    "index schema, authority, mapping or observations changed; regenerate and review",
  );
  return {
    mechanicallyValid: true,
    acceptanceVerified: false,
    requiresIndependentReview: true,
    agents: authorities.agents.length,
    standards: authorities.standards.length,
    requirements: authorities.requirements.length,
    cells: index.cells.length,
  };
}

export function queryAcceptanceIndex(
  index,
  { agentId, standardId, requirementId } = {},
  {
    authorities = loadAcceptanceAuthorities(),
    conditions,
    stage2Evidence,
    rootDir = root,
  } = {},
) {
  validateAcceptanceIndex(index, authorities, {
    conditions,
    stage2Evidence,
    rootDir,
  });
  if (agentId !== undefined)
    assert.ok(
      index.authorities.agents.includes(agentId),
      `unknown agentId: ${agentId}`,
    );
  if (standardId !== undefined)
    assert.ok(
      index.authorities.standards.some((item) => item.id === standardId),
      `unknown standardId: ${standardId}`,
    );
  if (requirementId !== undefined)
    assert.ok(
      index.authorities.requirements.some((item) => item.id === requirementId),
      `unknown requirementId: ${requirementId}`,
    );
  const selectedRequirementIds = standardId
    ? new Set(
        index.mapping.links.find((link) => link.standardId === standardId)
          ?.requirementIds ?? [],
      )
    : null;
  return {
    role: "acceptance-evidence-query",
    schedulingAuthority: "none",
    acceptanceVerified: false,
    requiresIndependentReview: true,
    selection: {
      agentId: agentId ?? null,
      standardId: standardId ?? null,
      requirementId: requirementId ?? null,
    },
    sources: index.authorities.sources,
    standards: index.authorities.standards.filter(
      (item) => !standardId || item.id === standardId,
    ),
    requirements: index.authorities.requirements.filter((item) =>
      requirementId
        ? item.id === requirementId
        : !selectedRequirementIds || selectedRequirementIds.has(item.id),
    ),
    packages: index.authorities.packages,
    common: index.authorities.common,
    scope: index.authorities.scope,
    unmappedRequirementIds: index.unmappedRequirementIds,
    ...(index.agentEvidence === undefined
      ? {}
      : {
          agentEvidence: {
            ...index.agentEvidence,
            ...(index.agentEvidence.supplements === undefined
              ? {}
              : {
                  supplements: index.agentEvidence.supplements.map(
                    (supplement) => ({
                      ...supplement,
                      observations: supplement.observations.filter(
                        (item) =>
                          (!agentId || item.agentId === agentId) &&
                          (!standardId ||
                            item.standardIds.includes(standardId)) &&
                          (!requirementId ||
                            item.requirementIds.includes(requirementId)),
                      ),
                    }),
                  ),
                }),
            rows: index.agentEvidence.rows
              .filter((row) => !agentId || row.agentId === agentId)
              .map((row) => {
                // Unassigned evidence stays visible, but never claims the selected standard.
                const observations = row.observations.filter(
                  (item) =>
                    !standardId ||
                    item.standardIds.length === 0 ||
                    item.standardIds.includes(standardId),
                );
                return {
                  ...row,
                  observations,
                };
              }),
          },
        }),
    cells: index.cells.filter(
      (item) =>
        (!agentId || item.agentId === agentId) &&
        (!standardId || item.standardId === standardId) &&
        (!requirementId || item.requirementIds.includes(requirementId)),
    ),
    coverage: index.coverage.filter(
      (item) =>
        (!agentId || item.agentId === agentId) &&
        (!standardId || item.standardIds.includes(standardId)) &&
        (!requirementId || item.requirementIds.includes(requirementId)),
    ),
  };
}

export function parseAcceptanceIndexArguments(args) {
  const parsed = {};
  const options = {
    "--mapping": "mappingFile",
    "--coverage": "coverageFile",
    "--validate": "indexFile",
    "--agent": "agentId",
    "--standard": "standardId",
    "--requirement": "requirementId",
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help") {
      assert.equal(args.length, 1, "--help must be used alone");
      return { help: true };
    }
    const key = options[args[i]];
    assert.ok(key, `unknown option: ${args[i]}`);
    assert.ok(!Object.hasOwn(parsed, key), `duplicate option: ${args[i]}`);
    const value = args[++i];
    nonempty(value, args[i - 1]);
    assert.ok(!value.startsWith("--"), `missing value for ${args[i - 1]}`);
    parsed[key] = value;
  }
  assert.ok(
    !parsed.indexFile || !(parsed.mappingFile || parsed.coverageFile),
    "--validate checks the saved index against current authorities; do not supply mapping or coverage",
  );
  return parsed;
}

export function runAcceptanceIndex(args, { rootDir = root } = {}) {
  const options = parseAcceptanceIndexArguments(args);
  if (options.help)
    return [
      "node scripts/acceptance-index.mjs [--mapping FILE] [--coverage FILE] [--agent ID] [--standard S1] [--requirement P18]",
      "node scripts/acceptance-index.mjs --validate FILE",
      "Reads only and writes JSON to stdout. No product state or file is changed.",
      'Mapping: {"links":[{"standardId":"S5","requirementIds":["P18"]}],"newPackages":{}}',
      "NEW requirements need explicitly supplied newPackages, never inferred owners.",
      "Coverage FILE is a JSON array of receipt-validator case summaries; exact source conditions and excerpts are checked, raw receipts and effects are not verified here.",
      "Source/fixture checks use shared; claimed layers remain independently reviewable.",
      "Validation establishes index structure and current source identity, never Agent acceptance.",
      "Unmapped requirements remain in the complete 151-item catalog; no pass state is generated.",
      "Default queries also read the dated stage-one Agent ledger; recorded remaining conditions are not current project status.",
      "Default queries include scoped stage-two observations with explicit manual links and source digests; these remain unclassified, separate from receipt coverage and current status.",
      "not-indexed means 未收录, never 未测. Historical ledger observations and remaining-condition prose remain separate from receipt coverage.",
      "Current task conclusions are read from docs/status.md where migrated; no prose is used to infer standards or passed states.",
    ].join("\n");
  const authorities = loadAcceptanceAuthorities(rootDir);
  const readJson = (file) => readBoundedJson(resolve(rootDir, file));
  if (options.indexFile) {
    const index = readJson(options.indexFile);
    const conditions =
      index.agentEvidence === undefined
        ? undefined
        : loadAgentConditions(rootDir);
    const validation = validateAcceptanceIndex(index, authorities, {
      conditions,
      rootDir,
    });
    if (options.agentId || options.standardId || options.requirementId)
      return {
        validation,
        query: queryAcceptanceIndex(index, options, {
          authorities,
          conditions,
          rootDir,
        }),
      };
    return validation;
  }
  const conditions = loadAgentConditions(rootDir);
  const stage2Evidence = loadStage2Evidence(rootDir);
  const index = buildAcceptanceIndex({
    authorities,
    mapping: options.mappingFile ? readJson(options.mappingFile) : undefined,
    coverage: options.coverageFile ? readJson(options.coverageFile) : [],
    conditions,
    stage2Evidence,
    rootDir,
  });
  if (options.agentId || options.standardId || options.requirementId)
    return queryAcceptanceIndex(index, options, {
      authorities,
      conditions,
      stage2Evidence,
      rootDir,
    });
  return index;
}

// Explicit CLI metadata inputs are bounded ordinary files. This is not an
// adversarial ancestor-directory sandbox; the caller owns these quiet paths.
function readBoundedJson(file, asText = false) {
  const message = "expected bounded regular JSON input";
  assert.ok(lstatSync(file).isFile(), message);
  let descriptor;
  try {
    descriptor = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor);
    assert.ok(before.isFile() && before.size <= 4 * 1024 * 1024, message);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    const current = lstatSync(file);
    assert.ok(
      offset === before.size &&
        current.isFile() &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        before.ino === current.ino &&
        before.dev === current.dev,
      message,
    );
    const text = bytes.toString("utf8");
    return asText ? text : JSON.parse(text);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const output = runAcceptanceIndex(process.argv.slice(2));
    process.stdout.write(
      typeof output === "string"
        ? `${output}\n`
        : `${JSON.stringify(output, null, 2)}\n`,
    );
  } catch {
    // JSON parse/assertion errors can contain rejected private input or paths.
    console.error("acceptance-index-invalid-input");
    process.exitCode = 1;
  }
}
