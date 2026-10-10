import { expect, it } from "vitest";
import { parseWorktreeReply } from "./worktree_types";
import { removalRecovery as recovery } from "./worktree_remove.test-fixtures";
const base = {
  kind: "operation",
  operationId: "recover-one",
  action: "recover",
  maintenanceActive: false,
  state: "prepared",
  settled: false,
  cancelRequested: false,
  targetPath: "/new/recovered",
  recovery,
};
const location = {
  id: "recovered-one",
  revision: 1,
  path: base.targetPath,
  repositoryRoot: base.targetPath,
  headOid: recovery.headOid,
  branch: "refs/heads/recovery/root-0001",
  ownership: "existing",
  availability: "verified",
};
it("accepts only an explicit new-directory recovery prepared result with its immutable proof", () => {
  expect(parseWorktreeReply(base)).toMatchObject({
    action: "recover",
    targetPath: base.targetPath,
    recovery,
  });
});
it("a successful new-directory recovery is an independently verified ordinary repository, not a created linked deletion target", () => {
  expect(
    parseWorktreeReply({ ...base, state: "ready", settled: true, location }),
  ).toMatchObject({ action: "recover", location });
});
it.each([
  { recovery: undefined },
  { targetPath: undefined },
  { maintenanceActive: true },
  { originalPath: "/old", retainedPath: "/kept" },
  { removalPhase: "awaitingConfirmation" },
  { deleteDispatched: false },
  { removed: {} },
  { archive: {} },
  { recovery: { ...recovery, availability: "unknown" } },
])("rejects unsupported or mixed recovery permissions %j", (patch) => {
  expect(() => parseWorktreeReply({ ...base, ...patch })).toThrow();
});
it.each([
  { ownership: "created" },
  { repositoryRoot: "/old" },
  { path: "/other" },
  { headOid: "b".repeat(40) },
  { availability: "unknown" },
])("rejects an unverified or misdirected ready location %j", (patch) => {
  expect(() =>
    parseWorktreeReply({
      ...base,
      state: "ready",
      settled: true,
      location: { ...location, ...patch },
    }),
  ).toThrow();
});
it("a known preflight recovery refusal may omit paths/proof without inventing an outcome", () => {
  expect(
    parseWorktreeReply({
      ...base,
      state: "failed",
      settled: true,
      recovery: undefined,
      targetPath: undefined,
      code: "targetExists",
    }),
  ).toMatchObject({ state: "failed", code: "targetExists" });
});
