import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.resetModules());

it("releasing maintenance cannot release an overlapping exit lock", async () => {
  const { draftPersistence: d } = await import("./draft_storage");
  const release = d.acquireInteractionLock();
  d.lockInteraction(true);
  release();
  expect(d.snapshot().interactionLocked).toBe(true);
  d.lockInteraction(false);
  expect(d.snapshot().interactionLocked).toBe(false);
});

it("a cancelled exit and a repeated old release cannot unlock newer maintenance", async () => {
  const { draftPersistence: d } = await import("./draft_storage");
  d.lockInteraction(true);
  const old = d.acquireInteractionLock();
  d.lockInteraction(false);
  expect(d.snapshot().interactionLocked).toBe(true);
  const next = d.acquireInteractionLock();
  old();
  old();
  expect(d.snapshot().interactionLocked).toBe(true);
  next();
  expect(d.snapshot().interactionLocked).toBe(false);
});

it("observers see the lock before maintenance starts and only the last release unlocks", async () => {
  const { draftPersistence: d } = await import("./draft_storage");
  const seen: boolean[] = [];
  const off = d.subscribe(() =>
    seen.push(Boolean(d.snapshot().interactionLocked)),
  );
  const a = d.acquireInteractionLock();
  const b = d.acquireInteractionLock();
  a();
  expect(seen.every(Boolean)).toBe(true);
  b();
  expect(seen.at(-1)).toBe(false);
  off();
});
