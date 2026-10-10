import fs from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import ts from "typescript";
const base = "docs/evidence/2026-10-09-capability-hardening/worktree-base";
const sourcePath = "src/runtime/worktree_types.ts";
const wirePath = base + "/backend/actual-wire.json";
const logPath = base + "/backend/wire-and-recovery-green.txt";
const sha = (p) =>
  createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const source = fs.readFileSync(sourcePath, "utf8"),
  wire = JSON.parse(fs.readFileSync(wirePath, "utf8"));
const rawLines = fs
  .readFileSync(logPath, "utf8")
  .split("\n")
  .filter((s) => s.includes("WORKTREE_WIRE:"));
assert.equal(rawLines.length, 1);
assert.deepEqual(
  wire,
  JSON.parse(rawLines[0].slice(rawLines[0].indexOf("WORKTREE_WIRE:") + 14)),
);
const js = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  },
}).outputText;
const parser = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);
const methods = {
  inspection: "parseWorktreeInspection",
  refs: "parseWorktreeRefs",
  prepared: "parseWorktreeReply",
  ready: "parseWorktreeReply",
  list: "parseWorktreeList",
  unknown: "parseWorktreeReply",
  linkedInspection: "parseWorktreeInspection",
  beforeAcknowledge: "parseWorktreeList",
  acknowledged: "parseWorktreeReply",
  materialList: "parseWorktreeList",
  failed: "parseWorktreeReply",
};
assert.deepEqual(Object.keys(wire).sort(), Object.keys(methods).sort());
const checks = [];
for (const [name, method] of Object.entries(methods)) {
  const result = parser[method](wire[name]);
  assert.deepEqual(result, wire[name]);
  assert.ok(Object.isFrozen(result));
  checks.push({ name, parser: method, pass: true });
}
assert.notEqual(
  wire.linkedInspection.root,
  wire.linkedInspection.repositoryRoot,
);
assert.equal(
  wire.linkedInspection.repositoryRoot,
  wire.inspection.repositoryRoot,
);
assert.equal(
  wire.materialList.materials[0].repositoryRoot,
  wire.inspection.repositoryRoot,
);
assert.equal(wire.acknowledged.state, "unknown");
assert.equal(wire.acknowledged.reviewed, true);
assert.equal(wire.failed.state, "failed");
assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
const result = {
  scope:
    "Offline execution of exact frontend pure DTO parser against the backend owner's actual Rust serialization. Does not repeat Git, Tauri IPC, installed App or original filesystem operations.",
  source: { path: sourcePath, sha256: sha(sourcePath) },
  wire: { path: wirePath, sha256: sha(wirePath) },
  rawLog: {
    path: logPath,
    sha256: sha(logPath),
    singleWireLineSemanticallyEqual: true,
  },
  checks,
  canonicalLinkedMaterialRoot: true,
  sourceUnchanged: true,
  notCovered: [
    "End-to-end Tauri transport",
    "Actual adopt/check_location/forget/refs-failure/cancel command results outside these 11 serialized objects",
    "Installed App and Agent journey",
  ],
};
fs.writeFileSync(
  base + "/frontend/actual-wire-check.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
