import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const stage2EvidencePath =
  "docs/evidence/2026-11-11-mcp-lifecycle/stage2-evidence.json";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function keys(value, fields) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    "expected stage-two object",
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...fields].sort(),
    "unexpected stage-two fields",
  );
}

function text(value) {
  assert.ok(
    typeof value === "string" && value.trim(),
    "missing stage-two text",
  );
}

function list(value) {
  assert.ok(Array.isArray(value) && value.length > 0, "missing stage-two list");
  assert.equal(new Set(value).size, value.length, "duplicate stage-two value");
}

function timestamp(value) {
  assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(Number.isFinite(Date.parse(value)), "invalid stage-two timestamp");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Scoped historical observations, separate from receipt coverage and current
 * status. Public source bytes are checked; local-original checks retain their
 * recorded time and limits and are not silently repeated or assumed today. */
export function parseStage2Evidence(
  input,
  authorities,
  { rootDir = repositoryRoot } = {},
) {
  keys(input, ["path", "text"]);
  assert.equal(input.path, stage2EvidencePath, "unexpected stage-two source");
  text(input.text);
  const data = JSON.parse(input.text);
  keys(data, ["kind", "recordedAt", "scope", "observations"]);
  assert.equal(data.kind, "ScopedStage2AgentEvidence");
  timestamp(data.recordedAt);
  text(data.scope);
  list(data.observations);
  const checked = new Map();
  const references = (values, prefix, checkBytes) => {
    list(values);
    const paths = new Set();
    return values.map((ref) => {
      keys(ref, ["path", "sha256"]);
      text(ref.path);
      assert.ok(
        ref.path.startsWith(prefix),
        "invalid stage-two evidence scope",
      );
      assert.match(ref.path, /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.json$/);
      assert.ok(
        !ref.path.split("/").some((part) => part === "." || part === ".."),
        "invalid stage-two evidence reference",
      );
      assert.ok(!paths.has(ref.path), "duplicate stage-two reference");
      paths.add(ref.path);
      assert.match(ref.sha256, /^[a-f0-9]{64}$/);
      if (checkBytes) {
        if (!checked.has(ref.path)) {
          let current = rootDir;
          for (const part of ref.path.split("/")) {
            current = resolve(current, part);
            assert.ok(
              !lstatSync(current).isSymbolicLink(),
              "symlink stage-two evidence reference",
            );
          }
          const stat = lstatSync(current);
          assert.ok(
            stat.isFile() && stat.size <= 1024 * 1024,
            "expected bounded stage-two evidence file",
          );
          checked.set(ref.path, digest(readFileSync(current)));
        }
        assert.equal(
          checked.get(ref.path),
          ref.sha256,
          "stage-two evidence digest mismatch",
        );
      }
      return { ...ref };
    });
  };
  const ids = new Set();
  const source = { path: input.path, sha256: digest(input.text) };
  const observations = data.observations.map((item, index) => {
    keys(item, [
      "id",
      "agentId",
      "standardIds",
      "requirementIds",
      "scope",
      "sourceCodeCommits",
      "selection",
      "summary",
      "limitations",
      "evidence",
      "originalVerification",
    ]);
    assert.match(item.id, /^[a-z0-9][a-z0-9-]{0,159}$/);
    assert.ok(!ids.has(item.id), "duplicate stage-two observation");
    ids.add(item.id);
    assert.ok(
      authorities.agents.includes(item.agentId),
      "unknown stage-two Agent",
    );
    for (const [field, allowed] of [
      ["standardIds", authorities.standards],
      ["requirementIds", authorities.requirements],
    ]) {
      list(item[field]);
      for (const id of item[field])
        assert.ok(
          allowed.some((entry) => entry.id === id),
          `unknown stage-two ${field}`,
        );
    }
    list(item.sourceCodeCommits);
    for (const commit of item.sourceCodeCommits)
      assert.match(commit, /^[a-f0-9]{40}$/);
    for (const field of ["scope", "selection", "summary"]) text(item[field]);
    list(item.limitations);
    item.limitations.forEach(text);
    const verification = item.originalVerification;
    keys(verification, ["checkedAt", "originals", "observations"]);
    timestamp(verification.checkedAt);
    list(verification.observations);
    verification.observations.forEach(text);
    return {
      ...structuredClone(item),
      evidence: references(item.evidence, "docs/evidence/", true),
      originalVerification: {
        ...verification,
        originals: references(verification.originals, "output/", false),
        observations: [...verification.observations],
      },
      origin: "stage2-scoped-sample",
      standardAssociation: "manual-narrow-link",
      result: "unclassified",
      acceptanceVerified: false,
      source,
      sourcePointer: `/observations/${index}`,
    };
  });
  return {
    role: "stage2-scoped-evidence-not-current-status",
    source,
    recordedAt: data.recordedAt,
    scope: data.scope,
    currentStatusSource: "docs/status.md",
    referenceValidation: {
      repositoryEvidence: "sha256-matched",
      localOriginals: "recorded-check-only",
    },
    observations,
  };
}
