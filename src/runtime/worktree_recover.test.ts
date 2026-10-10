import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removalRecovery as recovery } from "./worktree_remove.test-fixtures";
const h = vi.hoisted(() => ({ invoke: vi.fn(), id: "" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./sessions", () => ({ threads: { pauseQueuesForExit: vi.fn() } }));
vi.mock("./setup_storage", () => ({ setupStorage: { flush: vi.fn() } }));
const path = "/new/restored";
function op(state = "prepared") {
  return {
    kind: "operation",
    operationId: h.id,
    action: "recover",
    maintenanceActive: false,
    state,
    settled: ["ready", "failed", "cancelled", "unknown"].includes(state),
    cancelRequested: false,
    targetPath: path,
    recovery,
    ...(state === "ready"
      ? {
          location: {
            id: "recovered",
            revision: 1,
            path,
            repositoryRoot: path,
            headOid: recovery.headOid,
            branch: "refs/heads/recovery/root-0001",
            ownership: "existing",
            availability: "verified",
          },
        }
      : {}),
  };
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  h.id = "";
  h.invoke.mockReset().mockImplementation(async (c, a) => {
    if (c === "settings_get") return null;
    if (c === "worktree_list")
      return {
        locations: [],
        archives: [],
        materials: [],
        recoveries: [recovery],
        operation: null,
      };
    if (c === "worktree_recover_prepare") {
      h.id = a.operationId;
      return op();
    }
    if (c === "worktree_start") return op("ready");
    if (c === "worktree_cancel")
      return { ...op("cancelled"), cancelRequested: true };
    if (c === "worktree_status") return op();
    throw Error(c);
  });
});
afterEach(() => vi.useRealTimers());
async function setup() {
  const { worktrees: w } = await import("./worktrees");
  await w.load();
  return { w, r: w.snapshot().recoveries[0] };
}
it("explicit new-directory recovery starts only its own prepared intent, keeps backup and never applies a draft", async () => {
  const { w, r } = await setup();
  await w.recover(r, "/new", "restored", () => true);
  expect(
    h.invoke.mock.calls.filter(([c]) => c === "worktree_recover_prepare"),
  ).toEqual([
    [
      "worktree_recover_prepare",
      {
        operationId: h.id,
        recoveryId: r.id,
        expectedRevision: r.revision,
        parentPath: "/new",
        directoryName: "restored",
      },
    ],
  ]);
  expect(
    h.invoke.mock.calls.filter(([c]) => c === "worktree_start"),
  ).toHaveLength(1);
  expect(w.snapshot().locations[0]).toMatchObject({
    path,
    repositoryRoot: path,
    ownership: "existing",
    headOid: recovery.headOid,
  });
  expect(w.snapshot().recoveries).toEqual([r]);
  expect(w.snapshot().archives).toEqual([]);
});
it("closed/replaced owner gets exact cancellation after late prepared, never a start", async () => {
  const { w, r } = await setup();
  let resolve!: (v: unknown) => void,
    current = true;
  h.invoke.mockImplementation(async (c, a) => {
    if (c === "worktree_recover_prepare") {
      h.id = a.operationId;
      return new Promise((res) => {
        resolve = res;
      });
    }
    if (c === "worktree_cancel") return op("cancelled");
    throw Error(c);
  });
  const task = w.recover(r, "/new", "restored", () => current);
  current = false;
  resolve(op());
  await task;
  expect(
    h.invoke.mock.calls.filter(([c]) => c === "worktree_start"),
  ).toHaveLength(0);
  expect(h.invoke.mock.calls.filter(([c]) => c === "worktree_cancel")).toEqual([
    ["worktree_cancel", { operationId: h.id }],
  ]);
});
it("a same-id prepared response with a different recovery proof cannot start or replace the backup", async () => {
  const { w, r } = await setup();
  h.invoke.mockImplementation(async (c, a) => {
    if (c === "worktree_recover_prepare") {
      h.id = a.operationId;
      return {
        ...op(),
        recovery: { ...recovery, bundleSha256: "f".repeat(64) },
      };
    }
    throw Error(c);
  });
  await w.recover(r, "/new", "restored", () => true);
  expect(w.snapshot().uncertain).toBe(true);
  expect(w.snapshot().recoveries[0]).toBe(r);
  expect(h.invoke.mock.calls.some(([c]) => c === "worktree_start")).toBe(false);
});
it("a subscriber retiring the owner at the final start boundary cannot dispatch checkout", async () => {
  const { w, r } = await setup();
  let current = true,
    preparedObservations = 0;
  const stop = w.subscribe(() => {
    const observed = w.snapshot().operation;
    if (
      w.snapshot().working &&
      observed?.kind === "operation" &&
      observed.state === "prepared"
    )
      if (++preparedObservations === 2) current = false;
  });
  await w.recover(r, "/new", "restored", () => current);
  stop();
  expect(h.invoke.mock.calls.some(([c]) => c === "worktree_start")).toBe(false);
});
it("unknown or copied recovery records cannot open a new destination", async () => {
  const { w, r } = await setup();
  expect(() => w.recover({ ...r }, "/new", "restored", () => true)).toThrow();
  expect(
    h.invoke.mock.calls.some(([c]) => c === "worktree_recover_prepare"),
  ).toBe(false);
});
