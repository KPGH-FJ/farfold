import { expect, it } from "vitest";
import {
  parseWorktreeList,
  parseWorktreeLocation,
  parseWorktreeInspection,
  parseWorktreeReply,
  parseWorktreeRefs,
} from "./worktree_types";
const loc = {
  id: "id",
  revision: 2,
  path: "/tree",
  repositoryRoot: "/repo",
  branch: null,
  headOid: "a".repeat(40),
  ownership: "existing",
  availability: "unknown",
};
it("preserves literal paths and detached heads without inventing created ownership", () => {
  const parsed = parseWorktreeLocation({ ...loc, path: "/tree with\na line" });
  expect(parsed.path).toBe("/tree with\na line");
  expect(parsed.ownership).toBe("existing");
  expect(Object.isFrozen(parsed)).toBe(true);
});
it("rejects missing fields, unknown schemas, sparse lists and duplicate IDs", () => {
  for (const value of [
    { ...loc, revision: -1 },
    { ...loc, path: {} },
    { ...loc, other: true },
    { ...loc, headOid: "bad" },
  ])
    expect(() => parseWorktreeLocation(value)).toThrow();
  expect(() =>
    parseWorktreeList({ locations: Array(1), materials: [], operation: null }),
  ).toThrow();
  expect(() =>
    parseWorktreeList({
      locations: [loc, loc],
      materials: [],
      operation: null,
    }),
  ).toThrow();
});
it("only accepts ready with verified metadata and exact operation ID", () => {
  const op = {
    kind: "operation",
    operationId: "one",
    state: "ready",
    settled: true,
    cancelRequested: false,
    location: { ...loc, availability: "verified" },
  };
  expect(parseWorktreeReply(op, "one")).toEqual(op);
  expect(() => parseWorktreeReply(op, "two")).toThrow();
  for (const value of [
    { ...op, settled: false },
    { ...op, location: loc },
    { ...op, location: undefined },
    { ...op, kind: "unknownOperation" },
  ])
    expect(() => parseWorktreeReply(value)).toThrow();
});
it("bounds refs and inspections while retaining unknown blocker codes as opaque data", () => {
  const data = {
    inspectionId: "i",
    root: "/repo",
    repositoryRoot: "/repo",
    kind: "main",
    head: { oid: null, branch: null },
    trees: [],
    blockers: ["future"],
  };
  expect(parseWorktreeInspection(data).blockers).toEqual(["future"]);
  expect(() =>
    parseWorktreeInspection({ ...data, trees: Array(257).fill({}) }),
  ).toThrow();
  expect(() =>
    parseWorktreeRefs({ refs: Array(101).fill({}), nextCursor: null }),
  ).toThrow();
  expect(() =>
    parseWorktreeRefs({ refs: [], nextCursor: undefined }),
  ).toThrow();
});
it("retains reviewed unknown target paths without fabricating verified locations", () => {
  const operation = {
    kind: "operation",
    operationId: "lost",
    state: "unknown",
    settled: true,
    cancelRequested: false,
    reviewed: true,
    targetPath: "/repo/possible",
  };
  const materials = [
    { operationId: "lost", path: "/repo/possible", repositoryRoot: "/repo" },
  ];
  expect(parseWorktreeList({ locations: [], operation, materials })).toEqual({
    locations: [],
    operation,
    materials,
  });
  expect(() => parseWorktreeReply({ ...operation, settled: false })).toThrow();
  expect(() =>
    parseWorktreeList({
      locations: [],
      operation: null,
      materials: [{ ...materials[0], availability: "verified" }],
    }),
  ).toThrow();
});
it("distinguishes an inspected linked root from its canonical repository root", () => {
  const value = {
    inspectionId: "linked",
    root: "/trees/target",
    repositoryRoot: "/repo",
    kind: "linked",
    head: { oid: "a".repeat(40), branch: "refs/heads/x" },
    trees: [
      { path: "/repo", branch: "refs/heads/main", locked: false },
      { path: "/trees/target", branch: "refs/heads/x", locked: false },
    ],
    blockers: [],
  };
  expect(parseWorktreeInspection(value)).toEqual(value);
  const { repositoryRoot: _, ...legacy } = value;
  expect(() => parseWorktreeInspection(legacy)).toThrow();
});
