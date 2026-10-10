import { readFileSync } from "node:fs";
import { expect, test, describe } from "vitest";
import {
  parseWorktreeList,
  parseWorktreeReply,
  parseWorktreeRemoveInspection,
} from "../../../../../../src/runtime/worktree_types";
const base =
  "docs/evidence/2026-10-09-capability-hardening/worktree-remove/backend/";
for (const [name, file, log] of [
  ["original", "remove-wire.json", "worktrees-first.txt"],
  ["repaired", "remove-wire-final.json", "worktrees-second.txt"],
  [
    "verified",
    "remove-wire-verified.json",
    "worktrees-identity-cold-green.txt",
  ],
]) {
  const values = JSON.parse(readFileSync(base + file, "utf8"));
  describe(name, () => {
    test("exact emitted Rust stdout values", () => {
      const lines = readFileSync(base + log, "utf8")
        .split("\n")
        .filter((s) => s.includes("REMOVE_WIRE "));
      expect(lines).toHaveLength(1);
      expect(
        JSON.parse(lines[0].slice(lines[0].indexOf("REMOVE_WIRE ") + 12)),
      ).toEqual(values);
      expect(values).toHaveLength(18);
    });
    for (const { name: label, value } of values)
      test(label + " accepted without loss", () => {
        const parsed =
          label === "removeInspection"
            ? parseWorktreeRemoveInspection(value)
            : "locations" in value
              ? parseWorktreeList(value)
              : parseWorktreeReply(value, value.operationId);
        expect(parsed).toEqual(value);
        expect(Object.isFrozen(parsed)).toBe(true);
      });
  });
}
