import { expect, it, vi } from "vitest";
import { BrowserSurfaceGuard } from "./browser_surface_guard";
import { InterfaceZoom } from "./interface_scale_native";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
it("waits for native hide and zoom acknowledgements before revealing", async () => {
  const guard = new BrowserSurfaceGuard(),
    hidden = deferred(),
    zoomed = deferred();
  const owner = guard.register(vi.fn(), () => hidden.promise);
  const zoom = vi.fn(() => zoomed.promise),
    applied = vi.fn();
  const controller = new InterfaceZoom(guard, zoom, applied);
  const operation = controller.apply(150);
  await settle();
  expect(zoom).not.toHaveBeenCalled();
  expect(owner.reveal()).toBe(false);
  hidden.resolve();
  await settle();
  expect(zoom).toHaveBeenCalledExactlyOnceWith(1.5);
  expect(applied).not.toHaveBeenCalled();
  expect(owner.reveal()).toBe(false);
  zoomed.resolve();
  await operation;
  expect(applied).toHaveBeenCalledExactlyOnceWith(1.5);
  expect(owner.reveal()).toBe(true);
});
it("retains an uncertain zoom hold until an explicit successful retry", async () => {
  const guard = new BrowserSurfaceGuard();
  const owner = guard.register(vi.fn(), async () => {});
  const zoom = vi
      .fn()
      .mockRejectedValueOnce("no receipt")
      .mockResolvedValue(undefined),
    applied = vi.fn();
  const controller = new InterfaceZoom(guard, zoom, applied);
  await expect(controller.apply(125)).rejects.toBe("no receipt");
  expect(owner.reveal()).toBe(false);
  expect(applied).not.toHaveBeenCalled();
  await controller.apply(125);
  expect(applied).toHaveBeenCalledExactlyOnceWith(1.25);
  expect(owner.reveal()).toBe(true);
});
it("does not zoom after failed hide; explicit retry closes only that failed surface", async () => {
  const guard = new BrowserSurfaceGuard(),
    close = vi.fn().mockResolvedValue(undefined);
  guard.register(close, async () => {
    throw new Error("hide failed");
  });
  const zoom = vi.fn().mockResolvedValue(undefined);
  const controller = new InterfaceZoom(guard, zoom, vi.fn());
  await expect(controller.apply(125)).rejects.toThrow("could not be hidden");
  expect(zoom).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  await controller.apply(125);
  expect(close).toHaveBeenCalledOnce();
  expect(zoom).toHaveBeenCalledExactlyOnceWith(1.25);
  expect(guard.canOpen).toBe(true);
});
it("serializes owners across pending native operations", async () => {
  const first = deferred(),
    guard = new BrowserSurfaceGuard();
  const zoom = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined),
    applied = vi.fn();
  const controller = new InterfaceZoom(guard, zoom, applied);
  const a = controller.apply(125),
    b = controller.apply(150);
  await settle();
  expect(zoom.mock.calls).toEqual([[1.25]]);
  first.resolve();
  await Promise.all([a, b]);
  expect(applied.mock.calls).toEqual([[1.25], [1.5]]);
  expect(guard.canOpen).toBe(true);
});
