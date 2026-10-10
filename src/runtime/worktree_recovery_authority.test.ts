import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  preparedRemoval,
  removalRecovery,
  removalArchive,
  removalInspection,
} from "./worktree_remove.test-fixtures";
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  list: {} as Record<string, unknown>,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./sessions", () => ({ threads: { pauseQueuesForExit: vi.fn() } }));
vi.mock("./setup_storage", () => ({
  setupStorage: { flush: vi.fn().mockResolvedValue(undefined) },
}));
const cold = {
  ...preparedRemoval,
  state: "unknown",
  settled: true,
  maintenanceActive: false,
};
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  h.list = {
    locations: [],
    archives: [removalArchive],
    materials: [],
    recoveries: [{ ...removalRecovery, availability: "unknown" }],
    operation: cold,
  };
  h.invoke.mockReset().mockImplementation(async (c) => {
    if (c === "worktree_list") return h.list;
    if (c === "settings_get") return null;
    if (c === "worktree_status" || c === "worktree_recheck") return cold;
    throw Error(c);
  });
});
afterEach(() => vi.useRealTimers());
it("keeps canonical cold unknown recovery even when its same-revision operation receipt says verified", async () => {
  const { worktrees: w } = await import("./worktrees");
  await w.load();
  expect(w.snapshot().operation).toMatchObject({
    recovery: { availability: "verified" },
  });
  expect(w.snapshot().recoveries[0].availability).toBe("unknown");
  expect(() =>
    w.recover(w.snapshot().recoveries[0], "/new", "folder", () => true),
  ).toThrow();
  expect(
    h.invoke.mock.calls.some(([c]) => c === "worktree_recover_prepare"),
  ).toBe(false);
});
it("status/recheck cannot promote the list, while a later verified canonical list can", async () => {
  const { worktrees: w } = await import("./worktrees");
  await w.load();
  await w.recheck();
  expect(w.snapshot().recoveries[0].availability).toBe("unknown");
  h.list = { ...h.list, recoveries: [removalRecovery] };
  await w.recheck();
  expect(w.snapshot().recoveries[0].availability).toBe("verified");
});
it("a newly prepared recovery is discovered through the persisted list without dispatching deletion", async () => {
  h.list = { ...h.list, operation: null, recoveries: [] };
  const { worktrees: w } = await import("./worktrees");
  await w.load();
  h.invoke.mockImplementation(async (c, a) => {
    if (c === "settings_get") return null;
    if (c === "worktree_remove_inspect") return removalInspection;
    if (c === "worktree_list") return h.list;
    if (c === "worktree_remove_prepare") {
      const op = { ...preparedRemoval, operationId: a.operationId };
      h.list = { ...h.list, recoveries: [removalRecovery], operation: op };
      return op;
    }
    throw Error(c);
  });
  const ticket = await w.inspectRemoval(w.snapshot().archives[0]),
    owner = {};
  await w.prepareRemoval(ticket, owner, () => true);
  expect(w.snapshot().recoveries).toEqual([removalRecovery]);
  expect(
    h.invoke.mock.calls.filter(([c]) => c === "worktree_list"),
  ).toHaveLength(2);
  expect(w.canConfirmRemoval(owner, w.snapshot().operation!)).toBe(true);
  expect(
    h.invoke.mock.calls.some(([c]) =>
      ["worktree_start", "worktree_remove_confirm"].includes(c),
    ),
  ).toBe(false);
});

it("a failed canonical refresh never upgrades a recovery from its embedded operation", async () => {
  const { worktrees: w } = await import("./worktrees");
  await w.load();
  h.invoke.mockImplementation(async (c) => {
    if (c === "worktree_recheck") return cold;
    throw Error("unavailable");
  });
  await w.recheck();
  expect(w.snapshot().recoveries[0].availability).toBe("unknown");
  expect(w.snapshot().error).toBeTruthy();
  expect(() =>
    w.recover(w.snapshot().recoveries[0], "/new", "folder", () => true),
  ).toThrow();
});
it("a late catalogue read cannot replace a newer explicit recovery check", async () => {
  const { worktrees: w } = await import("./worktrees");
  await w.load();
  let finish!: (v: unknown) => void;
  h.invoke.mockImplementation(async (c) => {
    if (c === "worktree_list")
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (c === "worktree_status") return { ...cold, code: "changed" };
    throw Error(c);
  });
  const read = w.load();
  const status = w.status();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  finish({ ...h.list, recoveries: [removalRecovery], operation: cold });
  await Promise.all([read, status]);
  expect(w.snapshot().operation).toMatchObject({ code: "changed" });
  expect(w.snapshot().recoveries[0].availability).toBe("unknown");
  expect(w.snapshot().error).toBeTruthy();
  h.invoke.mockImplementation(async (c) => {
    if (c === "worktree_list")
      return {
        ...h.list,
        recoveries: [removalRecovery],
        operation: { ...cold, code: "changed" },
      };
    throw Error(c);
  });
  await w.load();
  expect(w.snapshot().recoveries[0].availability).toBe("verified");
  expect(w.snapshot().error).toBeNull();
});

it("canonical recovery refresh preserves the original archive owner for a separate deletion decision", async () => {
  h.list = { ...h.list, operation: null, recoveries: [] };
  const { worktrees: w } = await import("./worktrees");
  await w.load();
  const archive = w.snapshot().archives[0];
  h.invoke.mockImplementation(async (c, a) => {
    if (c === "settings_get") return null;
    if (c === "worktree_remove_inspect") return removalInspection;
    if (c === "worktree_list") return h.list;
    if (c === "worktree_remove_prepare") {
      const op = { ...preparedRemoval, operationId: a.operationId };
      h.list = { ...h.list, operation: op, recoveries: [removalRecovery] };
      return op;
    }
    throw Error(c);
  });
  const ticket = await w.inspectRemoval(archive),
    owner = {};
  await w.prepareRemoval(ticket, owner, () =>
    w.snapshot().archives.includes(archive),
  );
  expect(w.canConfirmRemoval(owner, w.snapshot().operation!)).toBe(true);
  expect(w.snapshot().recoveries[0].availability).toBe("verified");
});
it("an unreturned catalogue has a bounded UI wait without dropping maintenance or issuing a second list read", async () => {
  h.list = { ...h.list, operation: null, recoveries: [] };
  const { worktrees: w } = await import("./worktrees");
  await w.load();
  h.invoke.mockImplementation(async (c, a) => {
    if (c === "settings_get") return null;
    if (c === "worktree_remove_inspect") return removalInspection;
    if (c === "worktree_remove_prepare")
      return { ...preparedRemoval, operationId: a.operationId };
    if (c === "worktree_list") return new Promise(() => {});
    throw Error(c);
  });
  const ticket = await w.inspectRemoval(w.snapshot().archives[0]),
    owner = {};
  let returned = false;
  void w
    .prepareRemoval(ticket, owner, () => true)
    .then(() => {
      returned = true;
    });
  await vi.advanceTimersByTimeAsync(10020);
  expect(returned).toBe(true);
  expect(w.snapshot().loading).toBe(false);
  expect(w.snapshot().maintenanceLocked).toBe(true);
  expect(w.snapshot().recoveries).toEqual([]);
  expect(w.canConfirmRemoval(owner, w.snapshot().operation!)).toBe(true);
  const reads = h.invoke.mock.calls.filter(
    ([c]) => c === "worktree_list",
  ).length;
  void w.load();
  await vi.advanceTimersByTimeAsync(10020);
  expect(
    h.invoke.mock.calls.filter(([c]) => c === "worktree_list"),
  ).toHaveLength(reads);
});
