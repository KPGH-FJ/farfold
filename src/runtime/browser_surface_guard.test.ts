import { describe, expect, it, vi } from "vitest";
import { BrowserSurfaceGuard } from "./browser_surface_guard";

function deferred() {
  let resolve!: () => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let tick = 0; tick < 8; tick++) await Promise.resolve();
}

describe("BrowserSurfaceGuard", () => {
  it("runs navigation synchronously without native pages and keeps snapshots stable", () => {
    const guard = new BrowserSurfaceGuard();
    const initial = guard.getSnapshot();
    const navigate = vi.fn();
    guard.runLatest(navigate);
    expect(navigate).toHaveBeenCalledOnce();
    expect(guard.getSnapshot()).toBe(initial);
    expect(guard.hasSurfaces).toBe(false);
    expect(guard.canOpen).toBe(true);
  });

  it("waits for close acknowledgement before navigating", async () => {
    const guard = new BrowserSurfaceGuard();
    const closing = deferred();
    const close = vi.fn(() => closing.promise);
    const navigate = vi.fn();
    guard.register(close);
    expect(guard.getSnapshot().blocked).toBe(false);
    guard.runLatest(navigate);
    expect(close).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(guard.getSnapshot()).toEqual({
      busy: true,
      failed: false,
      blocked: true,
    });
    closing.resolve();
    await settle();
    expect(navigate).toHaveBeenCalledOnce();
    expect(guard.hasSurfaces).toBe(false);
    expect(guard.canOpen).toBe(true);
  });

  it("performs only C during rapid A to B to C navigation", async () => {
    const guard = new BrowserSurfaceGuard();
    const closing = deferred();
    const close = vi.fn(() => closing.promise);
    guard.register(close);
    const navigations = [vi.fn(), vi.fn(), vi.fn()];
    for (const navigation of navigations) guard.runLatest(navigation);
    expect(close).toHaveBeenCalledOnce();
    closing.resolve();
    await settle();
    expect(
      navigations.map((navigation) => navigation.mock.calls.length),
    ).toEqual([0, 0, 1]);
  });

  it("retains failed owners and the latest navigation for an explicit retry", async () => {
    const guard = new BrowserSurfaceGuard();
    const failed = deferred();
    const retried = deferred();
    const close = vi
      .fn()
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retried.promise);
    const old = vi.fn();
    const latest = vi.fn();
    guard.register(close);
    guard.runLatest(old);
    failed.reject(new Error("fixture close failure"));
    await settle();
    expect(guard.getSnapshot()).toEqual({
      busy: false,
      failed: true,
      blocked: true,
    });
    expect(guard.hasSurfaces).toBe(true);
    guard.runLatest(latest);
    expect(close).toHaveBeenCalledOnce();
    expect(old).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
    guard.retry();
    guard.retry();
    expect(close).toHaveBeenCalledTimes(2);
    retried.resolve();
    await settle();
    expect(old).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
    expect(guard.getSnapshot()).toEqual({
      busy: false,
      failed: false,
      blocked: false,
    });
  });

  it("keeps a ready hold blocking new opens until release even without owners", () => {
    const guard = new BrowserSurfaceGuard();
    const hold = guard.hold();
    expect(hold.ready).toBe(true);
    expect(guard.hasSurfaces).toBe(false);
    expect(guard.canOpen).toBe(false);
    const navigate = vi.fn();
    guard.runLatest(navigate);
    expect(navigate).toHaveBeenCalledOnce();
    expect(guard.canOpen).toBe(false);
    hold.release();
    hold.release();
    expect(hold.ready).toBe(false);
    expect(guard.canOpen).toBe(true);
  });

  it("does not present an overlay until native close is acknowledged", async () => {
    const guard = new BrowserSurfaceGuard();
    const closing = deferred();
    guard.register(() => closing.promise);
    const hold = guard.hold();
    expect(hold.ready).toBe(false);
    closing.resolve();
    await settle();
    expect(hold.ready).toBe(true);
    expect(guard.getSnapshot()).toEqual({
      busy: false,
      failed: false,
      blocked: true,
    });
    hold.release();
    expect(guard.canOpen).toBe(true);
  });

  it("never revives a released hold when its old close completes", async () => {
    const guard = new BrowserSurfaceGuard();
    const closing = deferred();
    const close = vi.fn(() => closing.promise);
    guard.register(close);
    const cancelled = guard.hold();
    cancelled.release();
    expect(guard.canOpen).toBe(false);
    const current = guard.hold();
    closing.resolve();
    await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(cancelled.ready).toBe(false);
    expect(current.ready).toBe(true);
    expect(guard.canOpen).toBe(false);
    current.release();
    expect(guard.canOpen).toBe(true);
  });

  it("keeps overlapping holds independent", () => {
    const guard = new BrowserSurfaceGuard();
    const first = guard.hold();
    const second = guard.hold();
    first.release();
    expect(first.ready).toBe(false);
    expect(second.ready).toBe(true);
    expect(guard.canOpen).toBe(false);
    second.release();
    expect(guard.canOpen).toBe(true);
  });

  it("retains a failed hold until retry closes the page", async () => {
    const guard = new BrowserSurfaceGuard();
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error("fixture"))
      .mockResolvedValueOnce(undefined);
    guard.register(close);
    const hold = guard.hold();
    await settle();
    expect(hold.ready).toBe(false);
    expect(guard.getSnapshot().failed).toBe(true);
    guard.retry();
    await settle();
    expect(hold.ready).toBe(true);
    expect(guard.canOpen).toBe(false);
  });

  it("waits for an already started open and then its close before navigating", async () => {
    const guard = new BrowserSurfaceGuard();
    const opening = deferred();
    const closing = deferred();
    const nativeClose = vi.fn(() => closing.promise);
    guard.register(async () => {
      await opening.promise;
      await nativeClose();
    });
    const navigate = vi.fn();
    guard.runLatest(navigate);
    await settle();
    expect(nativeClose).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    opening.resolve();
    await settle();
    expect(nativeClose).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    closing.resolve();
    await settle();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("cleanup does not overwrite navigation that is waiting for close", async () => {
    const guard = new BrowserSurfaceGuard();
    const closing = deferred();
    guard.register(() => closing.promise);
    const navigate = vi.fn();
    guard.runLatest(navigate);
    guard.requestClose();
    closing.resolve();
    await settle();
    expect(navigate).toHaveBeenCalledOnce();
    expect(guard.canOpen).toBe(true);
  });

  it("retains failed unmount cleanup even without navigation or a live overlay", async () => {
    const guard = new BrowserSurfaceGuard();
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error("fixture"))
      .mockResolvedValueOnce(undefined);
    guard.register(close);
    guard.requestClose();
    await settle();
    expect(guard.hasSurfaces).toBe(true);
    expect(guard.getSnapshot().failed).toBe(true);
    guard.retry();
    await settle();
    expect(close).toHaveBeenCalledTimes(2);
    expect(guard.hasSurfaces).toBe(false);
    expect(guard.canOpen).toBe(true);
  });

  it("retries only failed owners after a partial close", async () => {
    const guard = new BrowserSurfaceGuard();
    const good = vi.fn().mockResolvedValue(undefined);
    const bad = vi
      .fn()
      .mockRejectedValueOnce(new Error("fixture"))
      .mockResolvedValueOnce(undefined);
    guard.register(good);
    guard.register(bad);
    const navigate = vi.fn();
    guard.runLatest(navigate);
    await settle();
    expect(navigate).not.toHaveBeenCalled();
    guard.retry();
    await settle();
    expect(good).toHaveBeenCalledOnce();
    expect(bad).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("notifies surface presence changes without inventing a blocked normal page", () => {
    const guard = new BrowserSurfaceGuard();
    const initial = guard.getSnapshot();
    const observed: boolean[] = [];
    const unsubscribe = guard.subscribe(() => observed.push(guard.hasSurfaces));
    const release = guard.register(vi.fn());
    expect(guard.getSnapshot()).toBe(initial);
    release();
    release();
    expect(observed).toEqual([true, false]);
    expect(guard.getSnapshot()).toBe(initial);
    unsubscribe();
  });

  it("turns a synchronous close exception into a persistent retryable failure", async () => {
    const guard = new BrowserSurfaceGuard();
    const close = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("fixture");
      })
      .mockResolvedValueOnce(undefined);
    guard.register(close);
    expect(() => guard.requestClose()).not.toThrow();
    await settle();
    expect(guard.getSnapshot().failed).toBe(true);
    guard.retry();
    await settle();
    expect(guard.canOpen).toBe(true);
  });
});
