import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  publicReceiptSummary,
  sealReceipt,
} from "./acceptance-receipts.mjs";
import {
  parseTaskReference,
  taskReferencePath,
} from "./agent-task-reference.mjs";
import { observeInstalledApp } from "./observe-installed-app.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const source = "installed-ui";
const level = "installed";
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
const write = (file, value) =>
  writeFile(file, jsonText(value), { flag: "wx", mode: 0o600 });
const timestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

function inputs(snapshot) {
  const { observedAt, ...identity } = snapshot;
  return { installation: sha256(canonicalJson(identity)) };
}

async function begin(dir, specFile) {
  const spec = await json(specFile);
  const before = await observeInstalledApp(spec.threadSha256);
  assert.equal(
    before.app.binarySha256,
    spec.binarySha256,
    "Observed app differs from declared build.",
  );
  const version = before.rollout?.agentVersion ?? spec.observedAgentVersion;
  assert.ok(
    typeof version === "string" && version,
    "Supply the observed Agent program version when no rollout is used.",
  );
  assert.ok(
    typeof spec.productCommit === "string" && spec.productCommit,
    "Supply actual build provenance, including any unrecorded source identity.",
  );
  if (spec.reviewBy !== undefined)
    assert.ok(
      timestamp(spec.reviewBy) &&
        Date.parse(spec.reviewBy) > Date.parse(before.observedAt),
      "Use a review horizon after the start of the run.",
    );
  assert.ok(
    /^[a-z][a-z0-9-]+$/.test(spec.agentId) &&
      /^[a-z][a-z0-9-]+$/.test(spec.caseId),
    "Invalid case or Agent ID.",
  );
  assert.ok(
    Array.isArray(spec.conditions) && spec.conditions.length > 0,
    "Specify covered requirement excerpts.",
  );
  assert.ok(
    spec.observations &&
      Object.getPrototypeOf(spec.observations) === Object.prototype &&
      Object.keys(spec.observations).length,
    "Specify expected UI observations.",
  );
  const task = parseTaskReference(await readFile(taskReferencePath, "utf8"));
  const coveredConditions = spec.conditions.map(({ id, excerpt }) => {
    const condition = task.tasks.get(id)?.completion;
    assert.ok(
      typeof excerpt === "string" && excerpt && condition?.includes(excerpt),
      `Excerpt missing from requirement ${id}.`,
    );
    return { conditionId: `requirement:${id}`, condition, excerpt };
  });
  const requiredObservations = Object.entries(spec.observations).map(
    ([observationId, expectedValue]) => {
      assert.ok(
        /^[a-z][a-z0-9-]+$/.test(observationId) &&
          typeof expectedValue === "boolean",
        "Expected named Boolean UI observations.",
      );
      return { observationId, kind: "ui-readback", source, expectedValue };
    },
  );
  const manifest = {
    schemaVersion: 1,
    runId: path.basename(dir),
    preparedAt: before.observedAt,
    ...(spec.reviewBy ? { reviewBy: spec.reviewBy } : {}),
    context: {
      agentId: spec.agentId,
      platform: before.platform,
      productCommit: spec.productCommit,
      app: before.app,
      observedAgentVersion: version,
    },
    inputs: inputs(before),
    dependencies: [
      { id: "formal-app", kind: "app", fingerprint: before.app.binarySha256 },
      {
        id: "observed-platform",
        kind: "platform",
        fingerprint: `${before.platform}:${before.kernel}`,
      },
      { id: "observed-agent", kind: "agent-version", fingerprint: version },
      ...(before.rollout
        ? [
            {
              id: "owned-rollout",
              kind: "fixture",
              fingerprint: before.rollout.sha256,
            },
          ]
        : []),
    ],
    expectedCases: [
      {
        caseId: spec.caseId,
        agentId: spec.agentId,
        standardIds: [],
        requirementIds: [...new Set(spec.conditions.map(({ id }) => id))],
        level,
        expectedOutcome: "success",
        safety: "observation",
        coveredConditions,
        requiredObservations,
        dependencies: [
          "formal-app",
          "observed-platform",
          "observed-agent",
          ...(before.rollout ? ["owned-rollout"] : []),
        ],
      },
    ],
  };
  await mkdir(dir, { mode: 0o700 });
  await write(path.join(dir, "manifest.json"), manifest);
  await write(path.join(dir, "before.json"), before);
  return {
    preparedAt: before.observedAt,
    app: before.app,
    cdHash: before.cdHash,
  };
}

async function finish(dir, uiFile) {
  const before = await json(path.join(dir, "before.json"));
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = await json(manifestPath);
  const [expected] = manifest.expectedCases;
  const ui = await json(uiFile);
  assert.deepEqual(
    Object.keys(ui).sort(),
    ["finishedAt", "observations", "startedAt"],
    "Expected timestamps and scoped UI observations.",
  );
  assert.ok(
    timestamp(ui.startedAt) && timestamp(ui.finishedAt),
    "Expected UTC ISO timestamps with milliseconds.",
  );
  assert.deepEqual(
    Object.keys(ui.observations).sort(),
    expected.requiredObservations
      .map(({ observationId }) => observationId)
      .sort(),
    "Observed UI fields differ from selected evidence scope.",
  );
  assert.ok(
    Object.values(ui.observations).every((value) => typeof value === "boolean"),
    "Only Boolean UI observations may be stored.",
  );
  const after = await observeInstalledApp(before.rollout?.threadSha256);
  assert.ok(
    Date.parse(ui.startedAt) >= Date.parse(before.observedAt) &&
      Date.parse(ui.finishedAt) >= Date.parse(ui.startedAt) &&
      Date.parse(ui.finishedAt) <= Date.parse(after.observedAt),
    "UI observation is outside the recorded window.",
  );
  const matched = expected.requiredObservations.every(
    ({ observationId, expectedValue }) =>
      ui.observations[observationId] === expectedValue,
  );
  const stable =
    canonicalJson(inputs(after)) === canonicalJson(manifest.inputs);
  const uiPath = path.join(dir, "ui-observation.json");
  const afterPath = path.join(dir, "after.json");
  await write(uiPath, ui);
  await write(afterPath, after);
  assert.ok(
    stable,
    "App, process, environment, or owned rollout changed. Retain these observations and recapture against stable inputs.",
  );

  const evidence = await Promise.all(
    [uiPath, path.join(dir, "before.json"), afterPath].map(
      async (file, index) => ({
        path: file,
        sha256: sha256(await readFile(file)),
        visibility: "private",
        level,
        source: index === 0 ? source : "os-observation",
      }),
    ),
  );
  const observations = expected.requiredObservations.map(
    ({ expectedValue, ...item }) => ({
      ...item,
      value: ui.observations[item.observationId],
      evidenceIndexes: [0],
    }),
  );
  const actualsPath = path.join(dir, "actuals.json");
  await write(actualsPath, {
    attempts: [
      {
        attemptId: "observed",
        caseId: expected.caseId,
        startedAt: ui.startedAt,
        finishedAt: ui.finishedAt,
        status: "completed",
        outcome: matched ? "success" : "failure",
        level,
        context: manifest.context,
        inputsBefore: inputs(before),
        inputsAfter: inputs(after),
        observations,
        evidence,
      },
    ],
    inputsAfter: inputs(after),
    finishedAt: after.observedAt,
  });
  const report = await sealReceipt(
    manifestPath,
    actualsPath,
    path.join(dir, "receipt.json"),
  );
  if (!report.allExpectedOutcomesMatched) process.exitCode = 1;
  return publicReceiptSummary(report);
}

try {
  const [mode, dir, input, ...extra] = process.argv.slice(2);
  assert.ok(
    ["begin", "finish"].includes(mode) &&
      /^output\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/i.test(dir ?? "") &&
      input &&
      !extra.length,
    "Use record-installed-case.mjs begin|finish output/<new-run> <input.json>.",
  );
  const root = await realpath(".");
  const parent = mode === "begin" ? path.dirname(dir) : dir;
  assert.equal(
    await realpath(parent),
    path.join(root, parent),
    "Use an owned, unlinked output directory.",
  );
  assert.ok((await lstat(parent)).isDirectory());
  const report =
    mode === "begin" ? await begin(dir, input) : await finish(dir, input);
  console.log(jsonText(report).trimEnd());
} catch (error) {
  console.error(
    error instanceof SyntaxError
      ? "Invalid evidence JSON."
      : error.code && error.code !== "ERR_ASSERTION"
        ? "Could not safely record local evidence."
        : error.message,
  );
  process.exitCode = 1;
}
