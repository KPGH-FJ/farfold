import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorktreeOperation } from "./worktree_types";
const h = vi.hoisted(() => ({ invoke: vi.fn(), id: "" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
const location = {
  id: "tree",
  revision: 1,
  path: "/trees/new",
  repositoryRoot: "/source",
  branch: "refs/heads/new",
  headOid: "a".repeat(40),
  ownership: "created",
  availability: "verified",
} as const;
const input = {
  inspectionId: "inspect",
  parentPath: "/trees",
  directoryName: "new",
  branch: { kind: "new", name: "new", startOid: "a".repeat(40) },
} as const;
const reply = (
  state: WorktreeOperation["state"],
  settled = ["ready", "cancelled", "failed"].includes(state),
) => ({
  kind: "operation",
  operationId: h.id,
  state,
  settled,
  cancelRequested: false,
  ...(state === "ready" ? { location } : {}),
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  h.id = "";
  h.invoke
    .mockReset()
    .mockImplementation(
      async (command: string, args?: { operationId?: string }) => {
        if (command === "worktree_list")
          return { locations: [], materials: [], operation: null };
        if (command === "worktree_prepare_create") {
          h.id = args!.operationId!;
          return reply("prepared");
        }
        if (command === "worktree_start") return reply("running");
        if (command === "worktree_status") return reply("ready");
        if (command === "worktree_cancel") return reply("cancelled");
        throw new Error("unexpected");
      },
    );
});
afterEach(() => vi.useRealTimers());
async function store() {
  const { worktrees } = await import("./worktrees");
  await worktrees.load();
  return worktrees;
}
it("knows one ID before prepare, starts it once, and reaches a rechecked result", async () => {
  const s = await store();
  await s.create(input, () => true);
  expect(s.snapshot().operationId).toBe(h.id);
  expect(h.invoke.mock.calls.filter(([c]) => c === "worktree_start")).toEqual([
    ["worktree_start", { operationId: h.id }],
  ]);
  await expect(s.create(input, () => true)).rejects.toThrow();
  await s.status();
  expect(s.snapshot().operation).toEqual(reply("ready"));
});
it("lost prepare receipt preserves the exact ID and only rechecks", async () => {
  const s = await store();
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "worktree_prepare_create") {
      h.id = args.operationId;
      throw new Error("lost");
    }
    if (command === "worktree_recheck")
      return { kind: "unknownOperation", operationId: h.id };
    throw new Error("unexpected");
  });
  await s.create(input, () => true);
  expect(s.snapshot().uncertain).toBe(true);
  await s.recheck();
  expect(s.snapshot().operation?.kind).toBe("unknownOperation");
  await expect(s.create(input, () => true)).rejects.toThrow();
  expect(
    h.invoke.mock.calls.filter(([c]) => c === "worktree_start"),
  ).toHaveLength(0);
});
it("a prepared reply after the dialog departed is cancelled without starting", async () => {
  const p = deferred<unknown>(),
    s = await store();
  let current = true;
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "worktree_prepare_create") {
      h.id = args.operationId;
      return p.promise;
    }
    if (command === "worktree_cancel") return reply("cancelled");
    throw new Error("unexpected");
  });
  const pending = s.create(input, () => current);
  current = false;
  p.resolve(reply("prepared"));
  await pending;
  expect(s.snapshot().operation).toEqual(reply("cancelled"));
  expect(
    h.invoke.mock.calls.filter(([c]) => c === "worktree_start"),
  ).toHaveLength(0);
});
it("prepare observation timeout withdraws start even if its late reply succeeds", async () => {
  const p = deferred<unknown>(),
    s = await store();
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "worktree_prepare_create") {
      h.id = args.operationId;
      return p.promise;
    }
    if (command === "worktree_cancel") return reply("cancelled");
    throw new Error("unexpected");
  });
  const pending = s.create(input, () => true);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(s.snapshot()).toMatchObject({ uncertain: true, working: false });
  p.resolve(reply("prepared"));
  await pending;
  expect(s.snapshot().operation).toEqual(reply("cancelled"));
  expect(
    h.invoke.mock.calls.filter(([c]) => c === "worktree_start"),
  ).toHaveLength(0);
});
it("rejects successful-looking prepare replies instead of claiming a checkout", async () => {
  const s = await store();
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "worktree_prepare_create") {
      h.id = args.operationId;
      return reply("ready");
    }
    throw new Error("unexpected");
  });
  await s.create(input, () => true);
  expect(s.snapshot()).toMatchObject({
    operation: null,
    uncertain: true,
    locations: [],
  });
});
it("keeps a confirmed prepare rejection and permits a new explicit attempt", async () => {
  const s = await store();
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "worktree_prepare_create") {
      h.id = args.operationId;
      return { ...reply("failed"), code: "unsafePath" };
    }
    throw new Error("unexpected");
  });
  await s.create(input, () => true);
  const first = h.id;
  expect(s.snapshot()).toMatchObject({
    uncertain: false,
    operation: { state: "failed", settled: true, code: "unsafePath" },
  });
  await s.create(input, () => true);
  expect(h.id).not.toBe(first);
  expect(
    h.invoke.mock.calls.filter(([c]) => c === "worktree_start"),
  ).toHaveLength(0);
});
it("does not let an older rejected observation invalidate a newer success", async () => {
  const s = await store();
  await s.create(input, () => true);
  const old = deferred<unknown>();
  h.invoke.mockReturnValueOnce(old.promise);
  const pending = s.status();
  await vi.advanceTimersByTimeAsync(10_001);
  h.invoke.mockResolvedValueOnce(reply("ready"));
  await s.recheck();
  old.reject(new Error("late transport error"));
  await pending;
  expect(s.snapshot()).toMatchObject({
    uncertain: false,
    error: null,
    operation: { state: "ready" },
  });
});
it("unknown start is queried by the same ID and is never replayed", async () => {
  const s = await store();
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "worktree_prepare_create") {
      h.id = args.operationId;
      return reply("prepared");
    }
    if (command === "worktree_start") throw new Error("lost");
    if (command === "worktree_status") return reply("ready");
    throw new Error("unexpected");
  });
  await s.create(input, () => true);
  expect(s.snapshot().uncertain).toBe(true);
  await s.status();
  expect(s.snapshot().operation).toEqual(reply("ready"));
  expect(
    h.invoke.mock.calls.filter(([c]) => c === "worktree_start"),
  ).toHaveLength(1);
});
it("keeps a trusted settled unknown result settled despite an older in-flight status", async () => {
  const s = await store();
  await s.create(input, () => true);
  h.invoke.mockResolvedValueOnce(reply("unknown", true));
  await s.status();
  h.invoke.mockResolvedValueOnce(reply("running", false));
  await s.status();
  expect(s.snapshot().operation).toMatchObject({
    state: "unknown",
    settled: true,
  });
});
it("cancel of an already successful job reports its actual ready result", async () => {
  const s = await store();
  await s.create(input, () => true);
  h.invoke.mockResolvedValueOnce({ ...reply("ready"), cancelRequested: true });
  await s.cancel();
  expect(s.snapshot().operation).toMatchObject({
    state: "ready",
    cancelRequested: true,
  });
});
it("rejects wrong IDs and null statuses without declaring no side effect", async () => {
  const s = await store();
  await s.create(input, () => true);
  h.invoke.mockResolvedValueOnce({ ...reply("ready"), operationId: "other" });
  await s.status();
  expect(s.snapshot()).toMatchObject({
    uncertain: true,
    operation: { state: "running" },
  });
  h.invoke.mockResolvedValueOnce(null);
  await s.recheck();
  expect(s.snapshot().uncertain).toBe(true);
});
it("cold prepared intents are only displayed, never started", async () => {
  h.id = "prior";
  h.invoke.mockResolvedValueOnce({
    locations: [location],
    materials: [],
    operation: reply("prepared"),
  });
  const s = await store();
  expect(s.snapshot().operation).toMatchObject({ state: "prepared" });
  expect(h.invoke.mock.calls).toEqual([["worktree_list"]]);
});
it("checks exact saved location before use and never accepts a changed path", async () => {
  const s = await store();
  h.invoke.mockResolvedValueOnce({ ...location, path: "/another" });
  await expect(s.check(location)).rejects.toThrow();
  h.invoke.mockResolvedValueOnce(location);
  expect(await s.check(location)).toEqual(location);
});
it("an unconfirmed forget retains the listing until a successful refresh", async () => {
  h.invoke.mockResolvedValueOnce({
    locations: [location],
    materials: [],
    operation: null,
  });
  const s = await store();
  h.invoke.mockRejectedValueOnce(new Error("lost"));
  await expect(s.forget(location)).rejects.toThrow();
  expect(s.snapshot().locations).toEqual([location]);
  h.invoke.mockResolvedValueOnce({
    locations: [],
    materials: [],
    operation: null,
  });
  await s.load();
  expect(s.snapshot().locations).toEqual([]);
});
it("only an explicitly acknowledged settled unknown allows another creation", async () => {
  const s = await store();
  await s.create(input, () => true);
  h.invoke.mockResolvedValueOnce({
    ...reply("unknown", true),
    targetPath: "/trees/possible",
  });
  await s.status();
  await expect(s.create(input, () => true)).rejects.toThrow();
  const reviewed = {
    ...reply("unknown", true),
    reviewed: true,
    targetPath: "/trees/possible",
  };
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "worktree_acknowledge") return reviewed;
    if (command === "worktree_list")
      return {
        locations: [],
        materials: [
          {
            operationId: h.id,
            path: "/trees/possible",
            repositoryRoot: "/source",
          },
        ],
        operation: reviewed,
      };
    if (command === "worktree_prepare_create") {
      h.id = args.operationId;
      return reply("failed");
    }
    throw Error("unexpected");
  });
  await s.acknowledge(h.id);
  expect(s.snapshot().operation).toMatchObject({
    state: "unknown",
    reviewed: true,
  });
  expect(s.snapshot().materials).toHaveLength(1);
  expect(s.snapshot().locations).toHaveLength(0);
  await s.create(input, () => true);
  expect(s.snapshot().operation).toMatchObject({ state: "failed" });
  expect(s.snapshot().materials).toHaveLength(1);
});
it("never acknowledges a running operation", async () => {
  const s = await store();
  await s.create(input, () => true);
  await expect(s.acknowledge(h.id)).rejects.toThrow();
  expect(h.invoke.mock.calls.some(([c]) => c === "worktree_acknowledge")).toBe(
    false,
  );
});
it("late review or cancel controls cannot target a different operation", async () => {
  const s = await store();
  await s.create(input, () => true);
  h.invoke.mockResolvedValueOnce(reply("unknown", true));
  await s.status();
  const calls = h.invoke.mock.calls.length;
  await expect(s.acknowledge("previous")).rejects.toThrow();
  await s.cancel("previous");
  expect(h.invoke.mock.calls).toHaveLength(calls);
});
it("an old late prepared reply is cancelled without changing the newer operation", async () => {
  const s = await store(),
    late = deferred<unknown>();
  let first = "";
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "worktree_prepare_create") {
      h.id = args.operationId;
      if (!first) {
        first = h.id;
        return late.promise;
      }
      return reply("prepared");
    }
    if (command === "worktree_start") return reply("ready");
    if (command === "worktree_cancel")
      return { ...reply("cancelled"), operationId: args.operationId };
    throw Error("unexpected");
  });
  const previous = s.create(input, () => true);
  await s.cancel();
  await s.create(input, () => true);
  const current = s.snapshot().operationId;
  late.resolve({ ...reply("prepared"), operationId: first });
  await previous;
  expect(s.snapshot()).toMatchObject({
    operationId: current,
    working: false,
    uncertain: false,
    operation: { state: "ready", operationId: current },
  });
  expect(
    h.invoke.mock.calls.filter(([c]) => c === "worktree_start"),
  ).toHaveLength(1);
});
it("requires confirmed material-list readback before replacing a reviewed unknown", async () => {
  const s = await store();
  await s.create(input, () => true);
  h.invoke.mockResolvedValueOnce({
    ...reply("unknown", true),
    targetPath: "/possible",
  });
  await s.status();
  h.invoke.mockImplementation(async (command) => {
    if (command === "worktree_acknowledge")
      return {
        ...reply("unknown", true),
        reviewed: true,
        targetPath: "/possible",
      };
    throw Error("readback failed");
  });
  await s.acknowledge(h.id);
  await expect(s.create(input, () => true)).rejects.toThrow();
  expect(s.snapshot().operation).toMatchObject({
    state: "unknown",
    reviewed: true,
    targetPath: "/possible",
  });
});
it("explicit recheck may invalidate a formerly ready location", async () => {
  const s = await store();
  await s.create(input, () => true);
  await s.status();
  h.invoke.mockResolvedValueOnce({
    ...reply("unknown", true),
    code: "changed",
  });
  await s.recheck();
  expect(s.snapshot().operation).toMatchObject({
    state: "unknown",
    code: "changed",
  });
  await expect(s.create(input, () => true)).rejects.toThrow();
});
it("failed fresh location check reads back saved unavailability without applying", async () => {
  h.id = "prior";
  h.invoke.mockResolvedValueOnce({
    locations: [location],
    materials: [],
    operation: reply("ready"),
  });
  const s = await store();
  const changed = { ...location, revision: 2, availability: "missing" };
  h.invoke.mockImplementation(async (command) => {
    if (command === "worktree_check_location") throw { code: "missing" };
    if (command === "worktree_list")
      return { locations: [changed], materials: [], operation: reply("ready") };
    throw Error("unexpected");
  });
  await expect(s.check(location)).rejects.toThrow();
  expect(s.snapshot().locations).toEqual([changed]);
});
it("confirmed forgetting clears the associated result and old observations cannot resurrect it", async () => {
  h.id = "prior";
  h.invoke.mockResolvedValueOnce({
    locations: [location],
    materials: [],
    operation: reply("ready"),
  });
  const s = await store();
  const pending = deferred<unknown>();
  h.invoke.mockResolvedValueOnce(pending.promise);
  const observation = s.status();
  await vi.advanceTimersByTimeAsync(10_000);
  h.invoke.mockResolvedValueOnce({ forgotten: true });
  await s.forget(location);
  pending.resolve(reply("ready"));
  await observation;
  expect(s.snapshot()).toMatchObject({
    locations: [],
    operation: null,
    operationId: null,
  });
});
it("fixed backend failure codes reach safe descriptions while arbitrary failures stay generic", async () => {
  const s = await store();
  const { WORKTREE_STRINGS: S } = await import("./worktree_strings");
  h.invoke.mockRejectedValueOnce({ code: "bare" });
  await expect(s.inspect("/repo")).rejects.toThrow(S.blockers.bare);
  h.invoke.mockRejectedValueOnce({ code: "inspectionExpired" });
  await expect(s.refs("expired")).rejects.toThrow(S.errors.inspectionExpired);
  h.invoke.mockRejectedValueOnce({ code: "bare", secret: "untrusted" });
  await expect(s.inspect("/repo")).rejects.toThrow(S.unavailable);
});
