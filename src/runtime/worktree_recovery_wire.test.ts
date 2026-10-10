import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseWorktreeReply, parseWorktreeList } from "./worktree_types";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./sessions", () => ({ threads: { pauseQueuesForExit: vi.fn() } }));
vi.mock("./setup_storage", () => ({ setupStorage: { flush: vi.fn() } }));
const wire = JSON.parse(
  readFileSync(
    "docs/evidence/2026-10-09-capability-hardening/worktree-remove/cold-recovery-fix/actual-wire.json",
    "utf8",
  ),
);
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  h.invoke.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("accepts all four unchanged real Rust receipts through the strict TS parsers", () => {
  const list = parseWorktreeList(wire.canonicalList);
  const rechecked = parseWorktreeReply(wire.removalRechecked);
  const prepared = parseWorktreeReply(wire.recoverPrepared);
  const ready = parseWorktreeReply(wire.recoverReady);
  expect(list.recoveries).toHaveLength(1);
  expect(list.recoveries[0]).toEqual(wire.removalRechecked.recovery);
  expect(rechecked).toMatchObject({ state: "ready", action: "remove" });
  expect(prepared).toMatchObject({ state: "prepared", action: "recover" });
  expect(ready).toMatchObject({
    state: "ready",
    action: "recover",
    location: { ownership: "existing" },
  });
});
it("cold unknown→exact recheck→authoritative list→explicit recover uses the real backend response shapes without IO", async () => {
  const coldOp = {
    ...wire.removalRechecked,
    state: "unknown",
    recovery: {
      ...wire.removalRechecked.recovery,
      revision: 0,
      availability: "unknown",
    },
  };
  delete coldOp.removed;
  // Only the cold starting state is derived; all four success replies remain unchanged.
  const coldList = {
    ...wire.canonicalList,
    locations: [],
    operation: coldOp,
    recoveries: [coldOp.recovery],
  };
  let checked = false;
  h.invoke.mockImplementation(async (c) => {
    if (c === "worktree_list") return checked ? wire.canonicalList : coldList;
    if (c === "worktree_recheck") {
      checked = true;
      return wire.removalRechecked;
    }
    if (c === "worktree_recover_prepare") return wire.recoverPrepared;
    if (c === "worktree_start") return wire.recoverReady;
    throw Error(c);
  });
  const { worktrees: w } = await import("./worktrees");
  await w.load();
  expect(w.snapshot().recoveries[0].availability).toBe("unknown");
  await w.recheck();
  const r = w.snapshot().recoveries[0];
  expect(r.availability).toBe("verified");
  expect(r.revision).toBe(1);
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    wire.recoverPrepared.operationId,
  );
  const target = wire.recoverPrepared.targetPath,
    slash = target.lastIndexOf("/");
  await w.recover(
    r,
    target.slice(0, slash),
    target.slice(slash + 1),
    () => true,
  );
  expect(w.snapshot().operation).toEqual(wire.recoverReady);
  expect(h.invoke.mock.calls.filter(([c]) => c === "worktree_start")).toEqual([
    ["worktree_start", { operationId: wire.recoverPrepared.operationId }],
  ]);
  expect(w.snapshot().recoveries[0]).toBe(r);
});
