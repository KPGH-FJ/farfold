import { expect, it, vi } from "vitest";
import {
  InterfaceScalePreference,
  INTERFACE_SCALE_STRINGS as S,
} from "./interface_scale";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
it("restores without writing and persists before applying the next size", async () => {
  const order: string[] = [];
  const apply = vi.fn(async (value) => {
    order.push(`apply:${value}`);
  });
  const write = vi.fn(async (value) => {
    order.push(`save:${value}`);
  });
  const owner = new InterfaceScalePreference(apply, async () => 125, write);
  await owner.load();
  await owner.save(150);
  expect(order).toEqual(["apply:125", "save:150", "apply:150"]);
  expect(owner.getSnapshot()).toMatchObject({
    value: 150,
    ready: true,
    saving: false,
    error: null,
  });
});
it.each([null, 0, 90, 500, "125", {}, NaN])(
  "defaults invalid stored value without rewriting: %s",
  async (value) => {
    const apply = vi.fn().mockResolvedValue(undefined),
      write = vi.fn();
    const owner = new InterfaceScalePreference(apply, async () => value, write);
    await owner.load();
    expect(apply).toHaveBeenCalledExactlyOnceWith(100);
    expect(write).not.toHaveBeenCalled();
  },
);
it("keeps the old size on save failure and allows an explicit retry", async () => {
  const apply = vi.fn().mockResolvedValue(undefined);
  const write = vi
    .fn()
    .mockRejectedValueOnce("secret")
    .mockResolvedValue(undefined);
  const owner = new InterfaceScalePreference(apply, async () => 110, write);
  await owner.load();
  await owner.save(150);
  expect(apply.mock.calls).toEqual([[110]]);
  expect(owner.getSnapshot()).toMatchObject({
    value: 110,
    error: S.saveFailed,
    errorKind: "save",
    saving: false,
  });
  await owner.save(150);
  expect(apply.mock.calls).toEqual([[110], [150]]);
});
it("distinguishes saved preference from native display failure and retries only display", async () => {
  const apply = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce("secret")
    .mockResolvedValue(undefined);
  const write = vi.fn().mockResolvedValue(undefined);
  const owner = new InterfaceScalePreference(apply, async () => 100, write);
  await owner.load();
  await owner.save(125);
  expect(owner.getSnapshot()).toMatchObject({
    value: 125,
    error: S.applyFailed,
    errorKind: "apply",
    saving: false,
  });
  await owner.retryApply();
  expect(write).toHaveBeenCalledExactlyOnceWith(125);
  expect(apply.mock.calls).toEqual([[100], [125], [125]]);
  expect(owner.getSnapshot().error).toBeNull();
});
it("does not let late read or write receipts from released views change the screen", async () => {
  const read = deferred<unknown>(),
    write = deferred<unknown>(),
    apply = vi.fn().mockResolvedValue(undefined);
  const old = new InterfaceScalePreference(apply, () => read.promise);
  const reading = old.load();
  old.release();
  read.resolve(150);
  await reading;
  expect(apply).not.toHaveBeenCalled();
  const next = new InterfaceScalePreference(
    apply,
    async () => 100,
    () => write.promise,
  );
  await next.load();
  const saving = next.save(150);
  next.release();
  write.resolve(undefined);
  await saving;
  expect(apply.mock.calls).toEqual([[100]]);
});
it("shares pending reads, blocks premature writes, handles sync read failure", async () => {
  const apply = vi.fn().mockResolvedValue(undefined),
    write = vi.fn();
  const read = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error("secret");
    })
    .mockResolvedValue(110);
  const owner = new InterfaceScalePreference(apply, read, write);
  const first = owner.load();
  expect(owner.load()).toBe(first);
  await owner.save(125);
  await first;
  expect(write).not.toHaveBeenCalled();
  expect(owner.getSnapshot()).toMatchObject({
    ready: false,
    error: S.loadFailed,
  });
  await owner.load();
  expect(owner.getSnapshot().value).toBe(110);
});
it("blocks overlapping choices while native application is pending", async () => {
  const pending = deferred<void>();
  const apply = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockReturnValueOnce(pending.promise);
  const write = vi.fn().mockResolvedValue(undefined);
  const owner = new InterfaceScalePreference(apply, async () => 100, write);
  await owner.load();
  const saving = owner.save(125);
  await Promise.resolve();
  await Promise.resolve();
  await owner.save(150);
  await owner.load();
  expect(write).toHaveBeenCalledExactlyOnceWith(125);
  pending.resolve();
  await saving;
  expect(owner.getSnapshot()).toMatchObject({ value: 125, saving: false });
});
