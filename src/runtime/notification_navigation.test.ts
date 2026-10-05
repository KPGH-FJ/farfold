import { expect, it, vi } from "vitest";
import { notificationNavigation } from "./notification_navigation";

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
it("listens before consuming startup clicks and only selects the latest existing key", async () => {
  const order: string[] = [];
  const select = vi.fn();
  const off = vi.fn();
  const stop = await notificationNavigation(select, {
    listen: async () => {
      order.push("listen");
      return off;
    },
    take: async () => {
      order.push("take");
      return ["first", "last"];
    },
  });
  await settle();
  expect(order).toEqual(["listen", "take"]);
  expect(select).toHaveBeenCalledExactlyOnceWith("last");
  stop();
  expect(off).toHaveBeenCalledOnce();
});
it("keeps a wake received during a pending drain and does not open or resend anything", async () => {
  const first = deferred<unknown>();
  let wake!: () => void;
  const take = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(["later"]);
  const select = vi.fn();
  const stop = await notificationNavigation(select, {
    listen: async (callback) => {
      wake = callback;
      return () => {};
    },
    take,
  });
  wake();
  first.resolve(["earlier"]);
  await settle();
  expect(take).toHaveBeenCalledTimes(2);
  expect(select.mock.calls).toEqual([["earlier"], ["later"]]);
  stop();
});
it("ignores stale/malformed targets and late delivery after UI disposal", async () => {
  const pending = deferred<unknown>();
  const select = vi.fn();
  const stop = await notificationNavigation(select, {
    listen: async () => () => {},
    take: () => pending.promise,
  });
  stop();
  pending.resolve(["existing"]);
  await settle();
  expect(select).not.toHaveBeenCalled();
  for (const result of [null, "path", [], [{}], [""], ["x".repeat(16385)]]) {
    const close = await notificationNavigation(select, {
      listen: async () => () => {},
      take: async () => result,
    });
    await settle();
    close();
  }
  expect(select).not.toHaveBeenCalled();
});
