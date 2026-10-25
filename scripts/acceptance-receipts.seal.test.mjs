import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateReceipt } from "./acceptance-receipts.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(
  new URL("./acceptance-receipts.mjs", import.meta.url),
);
const roots = [];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const relative = "output/run/";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "farfold-receipt-seal-"));
  roots.push(root);
  await mkdir(path.join(root, relative), { recursive: true });
  const context = {
    agentId: "owned-sample",
    platform: "test",
    productCommit: "test-source",
  };
  const inputs = { fixture: "original-input" };
  const evidenceBytes = Buffer.from("Controlled fixture evidence only.\n");
  const manifest = {
    schemaVersion: 1,
    runId: "explicit-run",
    preparedAt: "2026-10-25T00:00:00Z",
    reviewBy: "2026-10-26T00:00:00Z",
    context,
    inputs,
    dependencies: [
      { id: "fixture", kind: "fixture", fingerprint: inputs.fixture },
    ],
    expectedCases: [
      {
        caseId: "owned-observation",
        agentId: context.agentId,
        standardIds: [],
        requirementIds: ["P18"],
        level: "shared",
        expectedOutcome: "success",
        safety: "side-effect",
        coveredConditions: [
          {
            conditionId: "requirement:P18",
            condition: "Observed branch remains narrow.",
            excerpt: "Observed branch",
          },
        ],
        requiredObservations: [
          {
            observationId: "actual-value",
            kind: "actual-readback",
            source: "test-runner",
            expectedValue: true,
          },
        ],
        dependencies: ["fixture"],
      },
    ],
  };
  const actuals = {
    attempts: [
      {
        attemptId: "only-attempt",
        caseId: "owned-observation",
        startedAt: "2026-10-25T00:01:00Z",
        finishedAt: "2026-10-25T00:02:00Z",
        status: "completed",
        outcome: "success",
        level: "shared",
        context: structuredClone(context),
        inputsBefore: structuredClone(inputs),
        inputsAfter: structuredClone(inputs),
        observations: [
          {
            observationId: "actual-value",
            kind: "actual-readback",
            source: "test-runner",
            value: true,
            evidenceIndexes: [0],
          },
        ],
        evidence: [
          {
            path: `${relative}evidence.txt`,
            sha256: digest(evidenceBytes),
            visibility: "private",
            level: "shared",
            source: "test-runner",
          },
        ],
      },
    ],
    inputsAfter: structuredClone(inputs),
    finishedAt: "2026-10-25T00:03:00Z",
  };
  // Deliberately noncanonical whitespace: the reference must hash these bytes.
  const manifestBytes = Buffer.from(` \n${JSON.stringify(manifest)}\n\n`);
  await writeFile(path.join(root, `${relative}manifest.json`), manifestBytes);
  await writeFile(path.join(root, `${relative}evidence.txt`), evidenceBytes);
  const save = () =>
    writeFile(
      path.join(root, `${relative}actuals.json`),
      `${JSON.stringify(actuals)}\n`,
    );
  await save();
  const run = async (
    command = "seal",
    args = [
      `${relative}manifest.json`,
      `${relative}actuals.json`,
      `${relative}receipt.json`,
    ],
  ) => {
    try {
      const result = await exec(process.execPath, [cli, command, ...args], {
        cwd: root,
      });
      return { ...result, code: 0 };
    } catch (error) {
      return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
  };
  return {
    root,
    manifest,
    manifestBytes,
    actuals,
    save,
    run,
    output: path.join(root, `${relative}receipt.json`),
  };
}

describe("offline receipt seal", () => {
  it("retains the existing embedded manifest rejection", async () => {
    const f = await fixture();
    const report = await validateReceipt(
      {
        schemaVersion: 1,
        runId: f.manifest.runId,
        manifest: f.manifest,
        ...f.actuals,
      },
      { rootDir: f.root },
    );
    expect(report.mechanicallyValid).toBe(false);
    expect(report.errors).toContainEqual({ code: "unsafe-evidence-reference" });
  });

  it("writes the correct private raw-byte reference without changing explicit actuals", async () => {
    const f = await fixture();
    const before = await readFile(path.join(f.root, `${relative}actuals.json`));
    const result = await f.run();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mechanicallyValid: true,
      allExpectedOutcomesMatched: true,
      acceptanceVerified: false,
    });
    const receipt = JSON.parse(await readFile(f.output, "utf8"));
    expect(receipt).toEqual({
      schemaVersion: 1,
      runId: f.manifest.runId,
      manifest: {
        path: `${relative}manifest.json`,
        sha256: digest(f.manifestBytes),
        visibility: "private",
      },
      ...f.actuals,
    });
    expect((await stat(f.output)).mode & 0o777).toBe(0o600);
    expect(
      await readFile(path.join(f.root, `${relative}manifest.json`)),
    ).toEqual(f.manifestBytes);
    expect(
      await readFile(path.join(f.root, `${relative}actuals.json`)),
    ).toEqual(before);
    expect(result.stdout).not.toContain("owned-sample");
    expect(result.stdout).not.toContain("output/run");
  });

  it("saves an unknown attempt without inventing completion or expected observations", async () => {
    const f = await fixture();
    const attempt = f.actuals.attempts[0];
    attempt.status = "started";
    attempt.outcome = "unknown";
    delete attempt.finishedAt;
    attempt.observations[0].value = false;
    await f.save();
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mechanicallyValid: true,
      counts: { incomplete: 1, passed: 0, failed: 0 },
    });
    const saved = JSON.parse(await readFile(f.output, "utf8"));
    expect(saved.attempts).toEqual(f.actuals.attempts);
    expect(saved.attempts[0]).not.toHaveProperty("finishedAt");
    expect(saved.finishedAt).toBe(f.actuals.finishedAt);
  });

  it("saves a mechanically valid failed case and exits1", async () => {
    const f = await fixture();
    f.actuals.attempts[0].outcome = "failure";
    f.actuals.attempts[0].observations[0].value = false;
    await f.save();
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mechanicallyValid: true,
      counts: { failed: 1 },
    });
    expect(JSON.parse(await readFile(f.output, "utf8")).attempts).toEqual(
      f.actuals.attempts,
    );
  });

  it.each(["attempts", "inputsAfter", "finishedAt"])(
    "does not fill missing explicit %s",
    async (key) => {
      const f = await fixture();
      delete f.actuals[key];
      await f.save();
      const result = await f.run();
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).mechanicallyValid).toBe(false);
      await expect(stat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["schemaVersion", "runId", "manifest"])(
    "does not accept actuals overriding %s",
    async (key) => {
      const f = await fixture();
      f.actuals[key] = key === "manifest" ? f.manifest : "caller-override";
      await f.save();
      const result = await f.run();
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).mechanicallyValid).toBe(false);
      await expect(stat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("does not write mechanically invalid evidence or expose its private values", async () => {
    const f = await fixture();
    f.actuals.attempts[0].evidence[0].sha256 = "0".repeat(64);
    await f.save();
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).errors).toContainEqual({
      code: "evidence-digest-mismatch",
      attemptIndex: 0,
      evidenceIndex: 0,
    });
    await expect(stat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["success-with-wrong-value", "unknown-with-finish"])(
    "does not repair caller state %s",
    async (variant) => {
      const f = await fixture();
      const attempt = f.actuals.attempts[0];
      if (variant === "success-with-wrong-value")
        attempt.observations[0].value = false;
      else {
        attempt.status = "started";
        attempt.outcome = "unknown";
      }
      await f.save();
      const original = await readFile(
        path.join(f.root, `${relative}actuals.json`),
      );
      const result = await f.run();
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).mechanicallyValid).toBe(false);
      await expect(stat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await readFile(path.join(f.root, `${relative}actuals.json`)),
      ).toEqual(original);
    },
  );

  it("refuses an existing output before reading invalid actuals and keeps its bytes", async () => {
    const f = await fixture();
    await writeFile(f.output, "old receipt remains\n");
    await writeFile(path.join(f.root, `${relative}actuals.json`), "not json");
    const result = await f.run();
    expect(result.code).toBe(2);
    expect(await readFile(f.output, "utf8")).toBe("old receipt remains\n");
    expect(result.stderr).not.toContain("old receipt");
  });

  it.each(["manifest.json", "actuals.json"])(
    "refuses a %s input symlink",
    async (name) => {
      const f = await fixture();
      const location = path.join(f.root, relative, name);
      const real = path.join(f.root, relative, `original-${name}`);
      await writeFile(real, await readFile(location));
      await rm(location);
      await symlink(real, location);
      expect((await f.run()).code).toBe(2);
      await expect(stat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("refuses a symlink output without changing its target", async () => {
    const f = await fixture();
    const target = path.join(f.root, relative, "preserved.txt");
    await writeFile(target, "untouched");
    await symlink(target, f.output);
    expect((await f.run()).code).toBe(2);
    expect(await readFile(target, "utf8")).toBe("untouched");
  });

  it("refuses an output parent symlink", async () => {
    const f = await fixture();
    await symlink(
      path.join(f.root, relative),
      path.join(f.root, "output/link"),
    );
    expect(
      (
        await f.run("seal", [
          `${relative}manifest.json`,
          `${relative}actuals.json`,
          "output/link/new.json",
        ])
      ).code,
    ).toBe(2);
    await expect(
      stat(path.join(f.root, relative, "new.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an input parent symlink", async () => {
    const f = await fixture();
    await symlink(
      path.join(f.root, relative),
      path.join(f.root, "output/link"),
    );
    expect(
      (
        await f.run("seal", [
          "output/link/manifest.json",
          `${relative}actuals.json`,
          `${relative}receipt.json`,
        ])
      ).code,
    ).toBe(2);
    await expect(stat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "receipt.json",
    "../outside-receipt.json",
    "output/run/../new.json",
    "output/.git/receipt.json",
  ])("refuses unsafe output %s", async (output) => {
    const f = await fixture();
    expect(
      (
        await f.run("seal", [
          `${relative}manifest.json`,
          `${relative}actuals.json`,
          output,
        ])
      ).code,
    ).toBe(2);
    await expect(stat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create a missing output directory", async () => {
    const f = await fixture();
    expect(
      (
        await f.run("seal", [
          `${relative}manifest.json`,
          `${relative}actuals.json`,
          "output/missing/new.json",
        ])
      ).code,
    ).toBe(2);
    await expect(
      stat(path.join(f.root, "output/missing")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["manifest.json", "actuals.json"])(
    "never overwrites the %s input as output",
    async (name) => {
      const f = await fixture();
      const target = path.join(f.root, relative, name);
      const before = await readFile(target);
      expect(
        (
          await f.run("seal", [
            `${relative}manifest.json`,
            `${relative}actuals.json`,
            `${relative}${name}`,
          ])
        ).code,
      ).toBe(2);
      expect(await readFile(target)).toEqual(before);
    },
  );

  it("keeps existing validate and revalidate CLI entrypoints", async () => {
    const f = await fixture();
    const ref = {
      path: `${relative}manifest.json`,
      sha256: digest(f.manifestBytes),
      visibility: "private",
    };
    await writeFile(
      f.output,
      JSON.stringify({
        schemaVersion: 1,
        runId: f.manifest.runId,
        manifest: ref,
        ...f.actuals,
      }),
    );
    const validated = await f.run("validate", [`${relative}receipt.json`]);
    expect(validated.code).toBe(0);
    expect(JSON.parse(validated.stdout).allExpectedOutcomesMatched).toBe(true);
    await writeFile(
      path.join(f.root, relative, "changes.json"),
      JSON.stringify({
        currentInputs: f.manifest.inputs,
        now: "2026-10-25T12:00:00Z",
      }),
    );
    const revalidated = await f.run("revalidate", [
      `${relative}receipt.json`,
      `${relative}changes.json`,
    ]);
    expect(revalidated.code).toBe(0);
    expect(JSON.parse(revalidated.stdout).acceptanceVerified).toBe(false);
  });
});
