import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  parseWorktreeList,
  parseWorktreeReply,
  parseWorktreeRemoveInspection,
} from "../../../../../../src/runtime/worktree_types";
const base =
  "docs/evidence/2026-10-09-capability-hardening/worktree-remove/backend/";
const values = JSON.parse(
  readFileSync(base + "remove-wire-publication.json", "utf8"),
);
test("publication capture equals the unique actual Rust stdout emission", () => {
  const lines = readFileSync(base + "worktrees-publication-green.txt", "utf8")
    .split("\n")
    .filter((line) => line.includes("REMOVE_WIRE "));
  expect(lines).toHaveLength(1);
  expect(
    JSON.parse(lines[0].slice(lines[0].indexOf("REMOVE_WIRE ") + 12)),
  ).toEqual(values);
  expect(values).toHaveLength(18);
});
for (const { name, value } of values) {
  test(name + " is strictly accepted without loss", () => {
    const parsed =
      name === "removeInspection"
        ? parseWorktreeRemoveInspection(value)
        : "locations" in value
          ? parseWorktreeList(value)
          : parseWorktreeReply(value, value.operationId);
    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
}
