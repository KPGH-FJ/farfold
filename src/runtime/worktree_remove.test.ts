import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  removalArchive as archive,
  removalInspection as ticket,
  preparedRemoval,
  removalRecovery,
} from "./worktree_remove.test-fixtures";
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  flush: vi.fn(),
  pause: vi.fn(),
  id: "",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./sessions", () => ({ threads: { pauseQueuesForExit: h.pause } }));
vi.mock("./setup_storage", () => ({ setupStorage: { flush: h.flush } }));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { resolve, promise };
}
function prepared() {
  return { ...preparedRemoval, operationId: h.id };
}
function cancelled() {
  return {
    ...prepared(),
    state: "cancelled",
    settled: true,
    maintenanceActive: false,
    cancelRequested: true,
  };
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  h.id = "";
  h.pause.mockReset();
  h.flush.mockReset().mockResolvedValue(undefined);
  h.invoke.mockReset().mockImplementation(async (c, a) => {
    if (c === "settings_get") return null;
    if (c === "worktree_list")
      return {
        locations: [],
        archives: [archive],
        materials: [],
        recoveries: h.id ? [removalRecovery] : [],
        operation: null,
      };
    if (c === "worktree_remove_inspect") return ticket;
    if (c === "worktree_remove_prepare") {
      h.id = a.operationId;
      return prepared();
    }
    if (c === "worktree_cancel") return cancelled();
    if (c === "worktree_status" || c === "worktree_recheck") return prepared();
    if (c === "worktree_remove_confirm")
      return {
        ...prepared(),
        state: "running",
        removalPhase: "deleting",
        deleteDispatched: true,
      };
    throw new Error("Unexpected command: " + c);
  });
});
afterEach(() => vi.useRealTimers());
async function setup() {
  const { worktrees: w } = await import("./worktrees");
  const { draftPersistence: d } = await import("./draft_storage");
  await w.load();
  const view = await w.inspectRemoval(w.snapshot().archives[0]);
  const owner = {};
  return { w, d, view, owner };
}
it("preparing a verified recovery never calls start or delete; only a separate explicit exact confirmation dispatches", async () => {
  const { w, d, view, owner } = await setup();
  await w.prepareRemoval(view, owner, () => true);
  expect(d.snapshot().interactionLocked).toBe(true);
  expect(
    h.invoke.mock.calls.filter(
      ([c]) => c === "worktree_start" || c === "worktree_remove_confirm",
    ),
  ).toHaveLength(0);
  const op = w.snapshot().operation!;
  expect(w.canConfirmRemoval(owner, op)).toBe(true);
  await w.confirmRemoval(owner, op);
  expect(
    h.invoke.mock.calls.filter(([c]) => c === "worktree_remove_confirm"),
  ).toEqual([
    [
      "worktree_remove_confirm",
      {
        operationId: h.id,
        recordId: archive.id,
        expectedRevision: 4,
        recoveryId: removalRecovery.id,
        recoverySha256: removalRecovery.bundleSha256,
        manifestSha256: removalRecovery.manifestSha256,
      },
    ],
  ]);
  await expect(w.confirmRemoval(owner, op)).rejects.toThrow();
  expect(h.invoke.mock.calls.some(([c]) => c === "worktree_start")).toBe(false);
});
it("status may advance the original live owner, but cannot give permission to a new dialog owner", async () => {
  const { w, view, owner } = await setup();
  h.invoke.mockImplementationOnce(async (c) => {
    expect(c).toBe("settings_get");
    return null;
  });
  h.invoke.mockImplementation(async (c, a) => {
    if (c === "settings_get") return null;
    if (c === "worktree_remove_prepare") {
      h.id = a.operationId;
      return {
        ...prepared(),
        state: "running",
        removalPhase: "preparingRecovery",
        recovery: undefined,
      };
    }
    if (c === "worktree_status") return prepared();
    throw Error(c);
  });
  await w.prepareRemoval(view, owner, () => true);
  expect(w.canConfirmRemoval(owner, w.snapshot().operation!)).toBe(false);
  await w.status();
  expect(w.canConfirmRemoval(owner, w.snapshot().operation!)).toBe(true);
  expect(w.canConfirmRemoval({}, w.snapshot().operation!)).toBe(false);
  expect(
    h.invoke.mock.calls.some(([c]) => c === "worktree_remove_confirm"),
  ).toBe(false);
});
it("withdrawal during an unresolved prepare cancels only its UUID, keeps legacy lock, and cannot revive on late receipt", async () => {
  const { w, d, view, owner } = await setup();
  const waiting = deferred<unknown>();
  h.invoke.mockImplementation(async (c, a) => {
    if (c === "settings_get") return null;
    if (c === "worktree_remove_prepare") {
      h.id = a.operationId;
      return waiting.promise;
    }
    if (c === "worktree_cancel") return cancelled();
    throw Error(c);
  });
  const work = w.prepareRemoval(view, owner, () => true);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  d.lockInteraction(true);
  w.withdrawRemoval(owner);
  waiting.resolve(prepared());
  await work;
  expect(w.canConfirmRemoval(owner, w.snapshot().operation!)).toBe(false);
  expect(d.snapshot().interactionLocked).toBe(true);
  d.lockInteraction(false);
  expect(d.snapshot().interactionLocked).toBe(false);
  expect(
    h.invoke.mock.calls.filter(
      ([c]) => c === "worktree_remove_confirm" || c === "worktree_start",
    ),
  ).toHaveLength(0);
  expect(
    h.invoke.mock.calls
      .filter(([c]) => c === "worktree_cancel")
      .every(([, a]) => a.operationId === h.id),
  ).toBe(true);
});
it("prepare observation timeout retires confirmation authority without pretending to release maintenance", async () => {
  const { w, d, view, owner } = await setup();
  const wait = deferred<unknown>();
  h.invoke.mockImplementation(async (c, a) => {
    if (c === "settings_get") return null;
    if (c === "worktree_remove_prepare") {
      h.id = a.operationId;
      return wait.promise;
    }
    if (c === "worktree_status") return prepared();
    if (c === "worktree_cancel") return cancelled();
    throw Error(c);
  });
  const work = w.prepareRemoval(view, owner, () => true);
  await vi.advanceTimersByTimeAsync(10001);
  expect(d.snapshot().interactionLocked).toBe(true);
  expect(w.snapshot().uncertain).toBe(true);
  await w.status();
  expect(w.canConfirmRemoval(owner, w.snapshot().operation!)).toBe(false);
  wait.resolve(prepared());
  await work;
  expect(
    h.invoke.mock.calls.some(([c]) => c === "worktree_remove_confirm"),
  ).toBe(false);
});
it("a reentrant owner callback that withdraws permission cannot dispatch deletion", async () => {
  const { w, view, owner } = await setup();
  let revoke = false;
  await w.prepareRemoval(view, owner, () => {
    if (revoke) w.withdrawRemoval(owner);
    return true;
  });
  const op = w.snapshot().operation!;
  revoke = true;
  await expect(w.confirmRemoval(owner, op)).rejects.toThrow();
  expect(
    h.invoke.mock.calls.some(([c]) => c === "worktree_remove_confirm"),
  ).toBe(false);
});
it("a confirmed pre-dispatch rejection has its real reason and releases only this operation", async () => {
  const { w, d, view, owner } = await setup();
  h.invoke.mockImplementation(async (c, a) => {
    if (c === "settings_get") return null;
    if (c === "worktree_remove_prepare") {
      h.id = a.operationId;
      return {
        ...cancelled(),
        state: "failed",
        code: "dirtyTracked",
        cancelRequested: false,
      };
    }
    throw Error(c);
  });
  await w.prepareRemoval(view, owner, () => true);
  expect(w.snapshot().operation).toMatchObject({
    state: "failed",
    code: "dirtyTracked",
  });
  expect(d.snapshot().interactionLocked).toBe(false);
  expect(w.snapshot().archives).toHaveLength(1);
});
it("a rejected older status cannot revoke the newer exact prepared observation", async () => {
  const { w, view, owner } = await setup();
  await w.prepareRemoval(view, owner, () => true);
  let reject!: (value: unknown) => void;
  const old = new Promise((_resolve, r) => {
    reject = r;
  });
  let count = 0;
  h.invoke.mockImplementation(async (c) => {
    if (c === "worktree_status") return ++count === 1 ? old : prepared();
    throw Error(c);
  });
  const previous = w.status();
  await w.status();
  const current = w.snapshot().operation!;
  expect(w.canConfirmRemoval(owner, current)).toBe(true);
  reject(Error("late old read failure"));
  await previous;
  expect(w.snapshot().operation).toBe(current);
  expect(w.canConfirmRemoval(owner, current)).toBe(true);
});
it("checking a recovery rejects a same-id response that substitutes its immutable repository or proof", async () => {
  const { w, view, owner } = await setup();
  await w.prepareRemoval(view, owner, () => true);
  await w.cancel();
  const current = w.snapshot().recoveries[0];
  h.invoke.mockImplementation(async (c) => {
    if (c === "worktree_recovery_check")
      return {
        locations: [],
        archives: [archive],
        materials: [],
        operation: null,
        recoveries: [
          {
            ...current,
            revision: 2,
            repositoryRoot: "/other/repo",
            rootsSha256: "f".repeat(64),
          },
        ],
      };
    throw Error(c);
  });
  await w.checkRecovery(current);
  expect(w.snapshot().recoveries[0]).toBe(current);
  expect(w.snapshot().error).toBeTruthy();
});
it("departure while flushing prevents even preparation IPC and releases only this lease", async () => {
  const { w, d, view, owner } = await setup();
  const gate = deferred<void>();
  let current = true;
  h.flush.mockImplementation(() => gate.promise);
  const task = w.prepareRemoval(view, owner, () => current);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(d.snapshot().interactionLocked).toBe(true);
  current = false;
  w.withdrawRemoval(owner);
  gate.resolve();
  await task;
  expect(d.snapshot().interactionLocked).toBe(false);
  expect(
    h.invoke.mock.calls.filter(
      ([c]) =>
        c.startsWith("worktree_remove_") && c !== "worktree_remove_inspect",
    ),
  ).toHaveLength(0);
});
it("a malformed prepare never unlocks maintenance; exact later inactive cancellation does", async () => {
  const { w, d, view, owner } = await setup();
  h.invoke.mockImplementation(async (c, a) => {
    if (c === "settings_get") return null;
    if (c === "worktree_remove_prepare") {
      h.id = a.operationId;
      return {
        ...prepared(),
        recovery: { ...removalRecovery, archiveId: "other-archive" },
      };
    }
    if (c === "worktree_status") return null;
    if (c === "worktree_cancel") return cancelled();
    throw Error(c);
  });
  await w.prepareRemoval(view, owner, () => true);
  expect(w.snapshot().uncertain).toBe(true);
  expect(d.snapshot().interactionLocked).toBe(true);
  await w.status();
  expect(d.snapshot().interactionLocked).toBe(true);
  await w.cancel();
  expect(d.snapshot().interactionLocked).toBe(false);
  expect(w.canConfirmRemoval(owner, w.snapshot().operation!)).toBe(false);
});
it("confirmed deletion keeps recovery reachable, removes only that archive, and releases maintenance without applying a location", async () => {
  const { w, d, view, owner } = await setup();
  await w.prepareRemoval(view, owner, () => true);
  h.invoke.mockImplementation(async (c) => {
    if (c === "worktree_remove_confirm")
      return {
        ...prepared(),
        state: "ready",
        settled: true,
        maintenanceActive: false,
        removalPhase: "finished",
        deleteDispatched: true,
        removed: {
          recordId: archive.id,
          revision: 5,
          originalPath: archive.originalPath,
          retainedPath: archive.retainedPath,
          recoveryId: removalRecovery.id,
        },
      };
    throw Error(c);
  });
  await w.confirmRemoval(owner, w.snapshot().operation!);
  expect(w.snapshot().archives).toEqual([]);
  expect(w.snapshot().locations).toEqual([]);
  expect(w.snapshot().recoveries).toEqual([removalRecovery]);
  expect(d.snapshot().interactionLocked).toBe(false);
});
it("a cold awaiting-confirmation history can never create a new deletion permission", async () => {
  const { w, d } = await setup();
  h.id = "cold-remove";
  h.invoke.mockImplementation(async (c) => {
    if (c === "worktree_list")
      return {
        locations: [],
        archives: [archive],
        materials: [],
        recoveries: [removalRecovery],
        operation: {
          ...prepared(),
          state: "unknown",
          settled: true,
          maintenanceActive: false,
        },
      };
    throw Error(c);
  });
  await w.load();
  expect(w.canConfirmRemoval({}, w.snapshot().operation!)).toBe(false);
  expect(d.snapshot().interactionLocked).not.toBe(true);
  await expect(w.confirmRemoval({}, w.snapshot().operation!)).rejects.toThrow();
  expect(
    h.invoke.mock.calls.some(([c]) => c === "worktree_remove_confirm"),
  ).toBe(false);
});
