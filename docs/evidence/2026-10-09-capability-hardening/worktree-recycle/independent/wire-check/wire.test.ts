import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  parseWorktreeList,
  parseWorktreeReply,
  parseWorktreeRecycleInspection,
} from "../../../../../../src/runtime/worktree_types";
const wire = JSON.parse(
  readFileSync(
    "docs/evidence/2026-10-09-capability-hardening/worktree-maintenance/backend/recycle-wire.json",
    "utf8",
  ),
);
const raw = readFileSync(wire.sourceLog, "utf8");
test("11 receipt values are exactly emitted by actual Rust integration stdout", () => {
  expect(createHash("sha256").update(raw).digest("hex")).toBe(
    wire.sourceLogSha256,
  );
  const emitted = raw
    .split("\n")
    .filter((s) => s.includes("RECYCLE_WIRE "))
    .map((s) => JSON.parse(s.slice(s.indexOf("RECYCLE_WIRE ") + 13)));
  expect(emitted).toEqual(wire.receipts);
  expect(wire.receipts).toHaveLength(11);
});
for (const { label, value } of wire.receipts) {
  test(`actual Rust ${label} accepted without loss by strict production TS`, () => {
    const parsed = label.endsWith("List")
      ? parseWorktreeList(value)
      : label.endsWith("Inspection")
        ? parseWorktreeRecycleInspection(value)
        : parseWorktreeReply(value, value.operationId);
    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
}
test("exact known request identity remains required", () => {
  const v = wire.receipts.find((r: any) => r.label === "archivePrepared").value;
  expect(() => parseWorktreeReply(v, "wrong-id")).toThrow();
});
test("prepared maintenance cannot lose its gate and still be accepted", () => {
  const v = wire.receipts.find((r: any) => r.label === "archivePrepared").value;
  expect(() =>
    parseWorktreeReply({ ...v, maintenanceActive: false }),
  ).toThrow();
});
test("archive does not acquire adopted ownership from a malformed wire value", () => {
  const v = structuredClone(
    wire.receipts.find((r: any) => r.label === "archiveReady").value,
  );
  v.archive.ownership = "existing";
  expect(() => parseWorktreeReply(v)).toThrow();
});
test("unknown field cannot silently extend restore result", () => {
  const v = wire.receipts.find((r: any) => r.label === "restoreReady").value;
  expect(() => parseWorktreeReply({ ...v, deleted: true })).toThrow();
});
