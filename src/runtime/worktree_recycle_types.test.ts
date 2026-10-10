import { expect, it } from "vitest";
import {
  parseWorktreeArchive,
  parseWorktreeList,
  parseWorktreeRecycleInspection,
  parseWorktreeReply,
} from "./worktree_types";
const archive = {
  id: "one",
  revision: 3,
  originalPath: "/repo/a",
  retainedPath: "/kept/a",
  repositoryRoot: "/repo",
  headOid: "a".repeat(40),
  branch: null,
  ownership: "created",
  availability: "verified",
};
const preview = {
  inspectionId: "i",
  action: "archive",
  recordId: "one",
  revision: 2,
  originalPath: "/repo/a",
  retainedPath: "/kept/a",
  repositoryRoot: "/repo",
  headOid: "a".repeat(40),
  branch: null,
  blockers: [],
  impact: { conversations: 0, unsent: false },
  material: { entries: 0, bytes: 0, sha256: "b".repeat(64) },
  draftBaseline: { unsentWork: null, agentSetup: "c".repeat(64) },
};
it("retains archive provenance separately from active locations and deeply freezes preview metadata", () => {
  expect(
    parseWorktreeList({
      locations: [],
      archives: [archive],
      materials: [],
      operation: null,
    }).archives,
  ).toEqual([archive]);
  const parsed = parseWorktreeRecycleInspection(preview);
  expect(parsed).toEqual(preview);
  for (const item of [
    parsed,
    parsed.material,
    parsed.draftBaseline,
    parsed.impact,
    parsed.blockers,
  ])
    expect(Object.isFrozen(item)).toBe(true);
});
it("rejects owned-looking archives made from existing/unknown materials or ambiguous paths", () => {
  for (const bad of [
    { ...archive, ownership: "existing" },
    { ...archive, retainedPath: archive.originalPath },
    { ...archive, revision: -1 },
    { ...archive, path: "/forged-use" },
    { ...archive, availability: { toString: () => "verified" } },
  ])
    expect(() => parseWorktreeArchive(bad)).toThrow();
});
it("rejects sparse/unknown/bad baseline/unsafe count metadata without dropping the unknown parts", () => {
  for (const bad of [
    { ...preview, blockers: Array(1) },
    { ...preview, extra: 1 },
    { ...preview, draftBaseline: { unsentWork: "raw-body", agentSetup: null } },
    {
      ...preview,
      material: { ...preview.material, bytes: Number.MAX_SAFE_INTEGER + 1 },
    },
    { ...preview, impact: { conversations: NaN, unsent: false } },
  ])
    expect(() => parseWorktreeRecycleInspection(bad)).toThrow();
});
it("requires archive and restore success to match the exact original and retained paths", () => {
  const op = {
    kind: "operation",
    operationId: "x",
    action: "archive",
    maintenanceActive: false,
    state: "ready",
    settled: true,
    cancelRequested: false,
    originalPath: archive.originalPath,
    retainedPath: archive.retainedPath,
    archive,
  };
  expect(parseWorktreeReply(op)).toEqual(op);
  for (const bad of [
    { ...op, archive: undefined },
    { ...op, retainedPath: "/other" },
    { ...op, archive: { ...archive, availability: "unknown" } },
    { ...op, action: "create" },
    { ...op, action: "restore" },
  ])
    expect(() => parseWorktreeReply(bad)).toThrow();
  const location = {
    id: archive.id,
    revision: 4,
    path: archive.originalPath,
    repositoryRoot: archive.repositoryRoot,
    headOid: archive.headOid,
    branch: null,
    ownership: "created",
    availability: "verified",
  };
  const restore = { ...op, action: "restore", archive: undefined, location };
  expect(parseWorktreeReply(restore)).toMatchObject({
    action: "restore",
    location,
  });
  expect(() =>
    parseWorktreeReply({
      ...restore,
      location: { ...location, path: archive.retainedPath },
    }),
  ).toThrow();
  expect(() =>
    parseWorktreeList({
      locations: [location],
      archives: [archive],
      materials: [],
      operation: null,
    }),
  ).toThrow();
});
it("distinguishes process-maintenance ownership from terminal or cold unknown states", () => {
  const unknown = {
    kind: "operation",
    operationId: "x",
    action: "archive",
    maintenanceActive: true,
    state: "unknown",
    settled: true,
    cancelRequested: true,
  };
  expect(parseWorktreeReply(unknown)).toEqual(unknown);
  expect(
    parseWorktreeReply({ ...unknown, maintenanceActive: false }),
  ).toMatchObject({ maintenanceActive: false });
  const { maintenanceActive: _, ...legacy } = unknown;
  expect(() => parseWorktreeReply(legacy)).toThrow();
  expect(() => parseWorktreeReply({ ...unknown, action: "adopt" })).toThrow();
  expect(() =>
    parseWorktreeReply({ ...unknown, originalPath: "/a" }),
  ).toThrow();
});
