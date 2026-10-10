import { expect, it } from "vitest";
import { parseWorktreeList, parseWorktreeReply } from "./worktree_types";
import {
  preparedRemoval,
  removalArchive,
  removalRecovery,
} from "./worktree_remove.test-fixtures";
it("accepts a verified recovery as a pending separate deletion decision, never as a usable location", () => {
  const result = parseWorktreeReply(preparedRemoval, "remove-one");
  expect(result).toMatchObject({
    action: "remove",
    state: "prepared",
    deleteDispatched: false,
  });
  expect(result).not.toHaveProperty("location");
});
it("keeps cancelled recovery material reachable independently of the current intent", () => {
  const result = parseWorktreeList({
    locations: [],
    archives: [removalArchive],
    materials: [],
    operation: null,
    recoveries: [removalRecovery],
  });
  expect(result).toMatchObject({ recoveries: [removalRecovery] });
});
it("does not accept a deletion result disguised as a created usable directory", () => {
  expect(() =>
    parseWorktreeReply({
      ...preparedRemoval,
      state: "ready",
      settled: true,
      location: { path: "/owned/tree" },
    }),
  ).toThrow();
});
it.each([
  { removalPhase: undefined },
  { deleteDispatched: undefined },
  { recovery: undefined },
  { maintenanceActive: false },
  { cancelRequested: true },
  { settled: true },
  { removalPhase: "deleting", deleteDispatched: false },
  { removalPhase: "awaitingConfirmation", deleteDispatched: true },
  { recovery: { ...removalRecovery, availability: "unknown" } },
  { recovery: { ...removalRecovery, bundleSha256: "not-a-hash" } },
  { recovery: { ...removalRecovery, objectCount: 1 } },
  { recovery: { ...removalRecovery, path: removalArchive.retainedPath } },
  { recovery: { ...removalRecovery, retainedPath: "/another/tree" } },
  { recovery: { ...removalRecovery, objectFormat: "sha256" } },
  { recovery: { ...removalRecovery, extra: true } },
  { archive: removalArchive },
  { unknownFuturePermission: true },
])("rejects malformed or contradictory pending deletion: %j", (patch) => {
  expect(() =>
    parseWorktreeReply({ ...preparedRemoval, ...patch }, "remove-one"),
  ).toThrow();
});
function ready() {
  return {
    ...preparedRemoval,
    state: "ready",
    settled: true,
    maintenanceActive: false,
    removalPhase: "finished",
    deleteDispatched: true,
    removed: {
      recordId: removalArchive.id,
      revision: 5,
      originalPath: removalArchive.originalPath,
      retainedPath: removalArchive.retainedPath,
      recoveryId: removalRecovery.id,
    },
  };
}
it("a successful removal has exact removed identity and an independently retained recovery, never a usable location", () => {
  const result = parseWorktreeReply(ready());
  expect(result).toMatchObject({
    state: "ready",
    removed: { recordId: removalArchive.id },
    recovery: removalRecovery,
  });
  expect(result).not.toHaveProperty("location");
  expect(() =>
    parseWorktreeReply({
      ...ready(),
      removed: { ...ready().removed, recoveryId: "wrong" },
    }),
  ).toThrow();
  expect(() =>
    parseWorktreeReply({ ...ready(), removed: undefined }),
  ).toThrow();
  expect(() =>
    parseWorktreeList({
      locations: [],
      archives: [removalArchive],
      materials: [],
      operation: ready(),
      recoveries: [removalRecovery],
    }),
  ).toThrow();
});
it("unknown after deletion retains its actual phase and proof without implying rollback or completion", () => {
  expect(
    parseWorktreeReply({
      ...preparedRemoval,
      state: "unknown",
      settled: true,
      maintenanceActive: false,
      removalPhase: "checkingOutcome",
      deleteDispatched: true,
      code: "cancelled",
    }),
  ).toMatchObject({ state: "unknown", deleteDispatched: true });
  for (const state of ["cancelled", "failed"])
    expect(() =>
      parseWorktreeReply({
        ...preparedRemoval,
        state,
        settled: true,
        removalPhase: "checkingOutcome",
        deleteDispatched: true,
      }),
    ).toThrow();
});
it("unknown recovery fields, sparse records, duplicated ids and omitted recovery list are refused", () => {
  const list = {
    locations: [],
    archives: [],
    materials: [],
    operation: null,
    recoveries: [removalRecovery],
  };
  expect(() => parseWorktreeList({ ...list, recoveries: Array(1) })).toThrow();
  expect(() =>
    parseWorktreeList({
      ...list,
      recoveries: [removalRecovery, removalRecovery],
    }),
  ).toThrow();
  expect(() => parseWorktreeList({ ...list, recoveries: undefined })).toThrow();
});
