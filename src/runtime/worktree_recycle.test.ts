import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorktreeReply } from "./worktree_types";
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  pause: vi.fn(),
  setup: vi.fn(),
  id: "",
  action: "archive",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./sessions", () => ({ threads: { pauseQueuesForExit: h.pause } }));
vi.mock("./setup_storage", () => ({ setupStorage: { flush: h.setup } }));
const location = {
  id: "tree",
  revision: 2,
  path: "/tree",
  repositoryRoot: "/repo",
  branch: "refs/heads/test",
  headOid: "a".repeat(40),
  ownership: "created",
  availability: "verified",
} as const;
const archive = {
  id: "tree",
  revision: 3,
  originalPath: "/tree",
  retainedPath: "/kept/tree",
  repositoryRoot: "/repo",
  branch: location.branch,
  headOid: location.headOid,
  ownership: "created",
  availability: "verified",
} as const;
const inspection = {
  inspectionId: "ticket",
  action: "archive",
  recordId: "tree",
  revision: 2,
  originalPath: "/tree",
  retainedPath: "/kept/tree",
  repositoryRoot: "/repo",
  headOid: location.headOid,
  branch: location.branch,
  blockers: [],
  impact: { conversations: 2, unsent: false },
  material: { entries: 5, bytes: 42, sha256: "b".repeat(64) },
  draftBaseline: { unsentWork: null, agentSetup: null },
} as const;
function op(state = "running", active = true): unknown {
  return {
    kind: "operation",
    operationId: h.id,
    action: h.action,
    maintenanceActive: active,
    state,
    settled: ["ready", "failed", "cancelled", "unknown"].includes(state),
    cancelRequested: false,
    originalPath: "/tree",
    retainedPath: "/kept/tree",
    ...(state === "ready"
      ? h.action === "archive"
        ? { archive }
        : { location: { ...location, revision: 4 } }
      : {}),
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (v: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  h.id = "";
  h.action = "archive";
  h.pause.mockReset();
  h.setup.mockReset().mockResolvedValue(undefined);
  h.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "settings_get") return null;
    if (command === "worktree_list")
      return {
        locations: [location],
        archives: [],
        materials: [],
        operation: null,
      };
    if (command === "worktree_recycle_inspect") return inspection;
    if (command === "worktree_recycle_prepare") {
      h.id = args.operationId;
      return op("prepared");
    }
    if (command === "worktree_start") return op();
    if (command === "worktree_status" || command === "worktree_recheck")
      return op("ready", false);
    if (command === "worktree_cancel")
      return { ...(op("cancelled", false) as object), cancelRequested: true };
    throw new Error("Unexpected command");
  });
});
afterEach(() => vi.useRealTimers());
async function setup() {
  const { worktrees: w } = await import("./worktrees");
  const { draftPersistence: d } = await import("./draft_storage");
  await w.load();
  const preview = await w.inspectRecycle("archive", w.snapshot().locations[0]);
  return { w, d, preview };
}
it("seals editing and flushes before one prepare/start; confirmed archive never becomes a usable location", async () => {
  const { w, d, preview } = await setup();
  h.setup.mockImplementation(async () => {
    expect(d.snapshot().interactionLocked).toBe(true);
    expect(
      h.invoke.mock.calls.some(([c]) => c === "worktree_recycle_prepare"),
    ).toBe(false);
  });
  await w.recycle(preview, () => true);
  expect(h.pause).toHaveBeenCalledOnce();
  expect(d.snapshot().interactionLocked).toBe(true);
  await vi.advanceTimersByTimeAsync(750);
  expect(w.snapshot().archives).toEqual([archive]);
  expect(w.snapshot().locations).toEqual([]);
  expect(d.snapshot().interactionLocked).toBe(false);
  expect(
    h.invoke.mock.calls.filter(([c]) => c === "worktree_start"),
  ).toHaveLength(1);
  await expect(w.check(location)).rejects.toThrow();
  await expect(w.forget(location)).rejects.toThrow();
});
it("a changed preview baseline is a confirmed refusal and releases only maintenance", async () => {
  const { w, d, preview } = await setup();
  h.invoke.mockReset().mockImplementation(async (c, args) => {
    if (c === "settings_get") return null;
    if (c === "worktree_recycle_prepare") {
      h.id = args.operationId;
      d.lockInteraction(true);
      return { ...(op("failed", false) as object), code: "draftChanged" };
    }
    throw new Error("No start permitted");
  });
  await w.recycle(preview, () => true);
  expect(w.snapshot().operation).toMatchObject({
    state: "failed",
    code: "draftChanged",
  });
  expect(w.snapshot().locations).toHaveLength(1);
  expect(d.snapshot().interactionLocked).toBe(true);
  d.lockInteraction(false);
  expect(d.snapshot().interactionLocked).toBe(false);
  expect(h.invoke.mock.calls.some(([c]) => c === "worktree_start")).toBe(false);
});
it("unknown prepare survives UI departure; null/wrong-ID/status failure cannot release the lease", async () => {
  const { w, d, preview } = await setup();
  let current = true;
  const pending = deferred<unknown>();
  h.invoke.mockImplementation(async (c, args) => {
    if (c === "settings_get") return null;
    if (c === "worktree_recycle_prepare") {
      h.id = args.operationId;
      return pending.promise;
    }
    if (c === "worktree_cancel") return op("cancelled", false);
    if (c === "worktree_recheck")
      return { kind: "unknownOperation", operationId: h.id };
    throw new Error("No start");
  });
  const result = w.recycle(preview, () => current);
  await vi.advanceTimersByTimeAsync(10_001);
  current = false;
  expect(w.snapshot().uncertain).toBe(true);
  expect(d.snapshot().interactionLocked).toBe(true);
  await w.recheck();
  expect(d.snapshot().interactionLocked).toBe(true);
  pending.resolve(op("prepared"));
  await result;
  expect(d.snapshot().interactionLocked).toBe(false);
  expect(h.invoke.mock.calls.filter(([c]) => c === "worktree_cancel")).toEqual([
    ["worktree_cancel", { operationId: h.id }],
  ]);
  expect(h.invoke.mock.calls.some(([c]) => c === "worktree_start")).toBe(false);
});
it("cold unknown with no current maintenance does not lock editing or confer archive success", async () => {
  h.id = "cold";
  h.invoke.mockResolvedValue({
    locations: [location],
    archives: [],
    materials: [],
    operation: op("unknown", false),
  });
  const { worktrees: w } = await import("./worktrees");
  const { draftPersistence: d } = await import("./draft_storage");
  await w.load();
  expect(d.snapshot().interactionLocked).toBeFalsy();
  expect(w.snapshot().uncertain).toBe(true);
  expect(w.snapshot().archives).toEqual([]);
});
it("flush failure and synchronous owner withdrawal both stop before prepare", async () => {
  const { w, d, preview } = await setup();
  h.setup.mockRejectedValueOnce(new Error("write failed"));
  await w.recycle(preview, () => true);
  expect(d.snapshot().interactionLocked).toBe(false);
  let current = true;
  const off = w.subscribe(() => {
    if (w.snapshot().maintenanceLocked) current = false;
  });
  await w.recycle(preview, () => current);
  off();
  expect(d.snapshot().interactionLocked).toBe(false);
  expect(
    h.invoke.mock.calls.some(([c]) => c === "worktree_recycle_prepare"),
  ).toBe(false);
});
it("restore removes the archived record only after exact confirmed original-location completion", async () => {
  h.action = "restore";
  h.invoke.mockImplementation(async (c, args) => {
    if (c === "settings_get") return null;
    if (c === "worktree_list")
      return {
        locations: [],
        archives: [archive],
        materials: [],
        operation: null,
      };
    if (c === "worktree_recycle_inspect")
      return { ...inspection, action: "restore", revision: 3 };
    if (c === "worktree_recycle_prepare") {
      h.id = args.operationId;
      return op("prepared");
    }
    if (c === "worktree_start") return op("ready", false);
    throw new Error("Unexpected");
  });
  const { worktrees: w } = await import("./worktrees");
  await w.load();
  const preview = await w.inspectRecycle("restore", w.snapshot().archives[0]);
  await w.recycle(preview, () => true);
  expect(w.snapshot().archives).toEqual([]);
  expect(w.snapshot().locations).toEqual([{ ...location, revision: 4 }]);
});
it("existing locations and replacement objects cannot even request an archive preview", async () => {
  const { w } = await setup();
  h.invoke.mockClear();
  await expect(
    w.inspectRecycle("archive", { ...location, ownership: "existing" }),
  ).rejects.toThrow();
  await expect(w.inspectRecycle("archive", { ...location })).rejects.toThrow();
  expect(h.invoke).not.toHaveBeenCalled();
});
it("a late prepared response cannot start after status already confirmed cancellation", async () => {
  const { w, preview } = await setup();
  const pending = deferred<unknown>();
  const original = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation(async (c, args) => {
    if (c === "worktree_recycle_prepare") {
      h.id = args.operationId;
      return pending.promise;
    }
    if (c === "worktree_status") return op("cancelled", false);
    return original(c, args);
  });
  const result = w.recycle(preview, () => true);
  await vi.advanceTimersByTimeAsync(0);
  await w.status();
  pending.resolve(op("prepared"));
  await result;
  expect(h.invoke.mock.calls.some(([c]) => c === "worktree_start")).toBe(false);
  expect(w.snapshot().operation).toMatchObject({
    state: "cancelled",
    maintenanceActive: false,
  });
});
it("a mismatched action receipt cannot release current maintenance or publish success", async () => {
  const { w, d, preview } = await setup();
  await w.recycle(preview, () => true);
  h.invoke.mockResolvedValue({
    kind: "operation",
    operationId: h.id,
    action: "create",
    maintenanceActive: false,
    state: "failed",
    settled: true,
    cancelRequested: false,
  });
  await w.status();
  expect(d.snapshot().interactionLocked).toBe(true);
  expect(w.snapshot().uncertain).toBe(true);
  expect(
    (w.snapshot().operation as WorktreeReply & { action: string }).action,
  ).toBe("archive");
});

it("does not start a recycle prepared receipt that lacks this instance's maintenance gate", async () => {
  const { w, d, preview } = await setup();
  const original = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation(async (c, args) => {
    if (c === "worktree_recycle_prepare") {
      h.id = args.operationId;
      return op("prepared", false);
    }
    return original(c, args);
  });
  await w.recycle(preview, () => true);
  expect(h.invoke.mock.calls.some(([c]) => c === "worktree_start")).toBe(false);
  expect(w.snapshot().uncertain).toBe(true);
  expect(d.snapshot().interactionLocked).toBe(true);
});
it("checks an unknown archive independently of a superseded intent, without moving or applying", async () => {
  const unknown = { ...archive, availability: "unknown" };
  h.invoke.mockImplementation(async (c) => {
    if (c === "worktree_list")
      return {
        locations: [],
        archives: [unknown],
        materials: [],
        operation: null,
      };
    if (c === "worktree_recycle_check")
      return {
        locations: [],
        archives: [archive],
        materials: [],
        operation: null,
      };
    throw new Error("Read-only check only");
  });
  const { worktrees: w } = await import("./worktrees");
  await w.load();
  await w.checkArchive(w.snapshot().archives[0]);
  expect(w.snapshot().archives).toEqual([archive]);
  expect(w.snapshot().locations).toEqual([]);
  expect(h.invoke.mock.calls).toEqual([
    ["worktree_list"],
    ["worktree_recycle_check", { recordId: "tree", expectedRevision: 3 }],
  ]);
});
it("unknown archive check rejects a changed directory and preserves the original record", async () => {
  const unknown = { ...archive, availability: "unknown" };
  h.invoke.mockImplementation(async (c) => {
    if (c === "worktree_list")
      return {
        locations: [],
        archives: [unknown],
        materials: [],
        operation: null,
      };
    return {
      locations: [{ ...location, path: "/other", revision: 4 }],
      archives: [],
      materials: [],
      operation: null,
    };
  });
  const { worktrees: w } = await import("./worktrees");
  await w.load();
  const original = w.snapshot().archives[0];
  await expect(w.checkArchive(original)).rejects.toThrow();
  expect(w.snapshot().archives[0]).toBe(original);
  expect(w.snapshot().locations).toEqual([]);
});

it("read-only archive checks can recover the original active record, but old responses cannot replace new list state", async () => {
  const unknown = { ...archive, availability: "unknown" };
  const check = deferred<unknown>();
  let listCalls = 0;
  h.id = "historical";
  h.invoke.mockImplementation(async (c) => {
    if (c === "worktree_list") {
      listCalls++;
      return {
        locations: [],
        archives: [unknown],
        materials: [],
        operation: op("unknown", false),
      };
    }
    if (c === "worktree_recycle_check") return check.promise;
    if (c === "worktree_status") return op("unknown", false);
    throw new Error("Unexpected");
  });
  const { worktrees: w } = await import("./worktrees");
  await w.load();
  const original = w.snapshot().archives[0];
  const waiting = w.checkArchive(original);
  await w.status();
  check.resolve({
    locations: [{ ...location, revision: 4 }],
    archives: [],
    materials: [],
    operation: op("unknown", false),
  });
  await waiting;
  expect(w.snapshot().archives[0]).toBe(original);
  expect(w.snapshot().locations).toEqual([]);
  await w.checkArchive(original);
  expect(w.snapshot().archives).toEqual([]);
  expect(w.snapshot().locations).toEqual([{ ...location, revision: 4 }]);
  expect(listCalls).toBe(1);
  await expect(w.checkArchive(original)).rejects.toThrow();
});
