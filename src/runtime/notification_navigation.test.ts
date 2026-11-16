import { expect, it, vi } from "vitest";
import { notificationNavigation } from "./notification_navigation";

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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

it.each(["read", "navigation"])(
  "keeps a new explicit wake when the prior notification %s fails",
  async (failure) => {
    const blocked = deferred<never>();
    let wake!: () => void;
    const take = vi.fn().mockResolvedValue(["later"]);
    if (failure === "read") take.mockReturnValueOnce(blocked.promise);
    else take.mockResolvedValueOnce(["earlier"]);
    const select = vi.fn();
    if (failure === "navigation") select.mockReturnValueOnce(blocked.promise);
    const stop = await notificationNavigation(select, {
      listen: async (callback) => {
        wake = callback;
        return () => {};
      },
      take,
    });
    await settle();
    wake();
    blocked.reject(new Error("old notification unavailable"));
    await settle();
    expect(take).toHaveBeenCalledTimes(2);
    expect(select.mock.calls).toEqual(
      failure === "read" ? [["later"]] : [["earlier"], ["later"]],
    );
    stop();
  },
);

it("does not retry a failed read without another explicit activation", async () => {
  const take = vi.fn().mockRejectedValue(new Error("unavailable"));
  const select = vi.fn();
  const stop = await notificationNavigation(select, {
    listen: async () => () => {},
    take,
  });
  await settle();
  expect(take).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
  stop();
});

it("routes an explicit test reminder to settings without selecting a conversation", async () => {
  const select = vi.fn();
  const settings = vi.fn();
  const close = await notificationNavigation(
    select,
    {
      listen: async () => () => {},
      take: async () => [{ kind: "settings", section: "notifications" }],
    },
    settings,
  );
  await settle();
  expect(settings).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
  close();
});

it.each([
  { kind: "settings", section: "privacy" },
  { kind: "settings", section: "notifications", key: "fake-thread" },
  { kind: "notification", section: "notifications" },
  ["settings", "notifications"],
])(
  "rejects malformed settings targets without falling back to a thread",
  async (target) => {
    const select = vi.fn(),
      settings = vi.fn();
    const close = await notificationNavigation(
      select,
      {
        listen: async () => () => {},
        take: async () => [target],
      },
      settings,
    );
    await settle();
    close();
    expect(select).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
  },
);

it("keeps only the most recent mixed activation and ignores late settings after disposal", async () => {
  const select = vi.fn(),
    settings = vi.fn();
  const close = await notificationNavigation(
    select,
    {
      listen: async () => () => {},
      take: async () => [
        { kind: "settings", section: "notifications" },
        "thread",
      ],
    },
    settings,
  );
  await settle();
  close();
  expect(select).toHaveBeenCalledExactlyOnceWith("thread");
  expect(settings).not.toHaveBeenCalled();
  const pending = deferred<unknown>();
  const stop = await notificationNavigation(
    select,
    {
      listen: async () => () => {},
      take: () => pending.promise,
    },
    settings,
  );
  stop();
  pending.resolve([{ kind: "settings", section: "notifications" }]);
  await settle();
  expect(settings).not.toHaveBeenCalled();
});
