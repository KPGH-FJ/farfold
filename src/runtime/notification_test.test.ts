import { expect, it, vi } from "vitest";
import {
  NotificationTest,
  NOTIFICATION_TEST as S,
  type NotificationTestPort,
} from "./notification_test";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  submit = vi
    .fn<NotificationTestPort["submit"]>()
    .mockResolvedValue("submitted"),
) {
  const changed = vi.fn(),
    withdraw = vi.fn().mockResolvedValue("withdrawn");
  return {
    changed,
    submit,
    withdraw,
    test: new NotificationTest(changed, { submit, withdraw }),
  };
}
it("sends only the explicit test command's ticket and blocks duplicate in-flight clicks", async () => {
  const pending = deferred<unknown>();
  const f = fixture(vi.fn().mockReturnValue(pending.promise));
  const first = f.test.send(true);
  await f.test.send(true);
  expect(f.submit).toHaveBeenCalledOnce();
  expect(f.test.state.phase).toBe("pending");
  const ticket = f.submit.mock.calls[0][0];
  expect(Object.keys(ticket).sort()).toEqual(["rendererNonce", "sequence"]);
  expect(ticket.rendererNonce).toMatch(/^[a-f0-9]{32}$/);
  expect(ticket.sequence).toBe(1);
  pending.resolve("submitted");
  await first;
  expect(f.test.state).toEqual({ phase: "submitted", message: S.submitted });
});
it("does not send while preference reading/saving has not succeeded", async () => {
  const f = fixture();
  await f.test.send(false);
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.test.state.message).toBe(S.unavailable);
});
it.each([
  ["NOTIFICATION_TEST_PERMISSION_REQUIRED", S.permission],
  ["NOTIFICATION_TEST_PREFERENCE_UNAVAILABLE", S.preference],
  ["NOTIFICATION_TEST_SYSTEM_UNAVAILABLE", S.system],
  ["NOTIFICATION_TEST_NOT_SUBMITTED", S.failed],
  ["NOTIFICATION_TEST_MAIN_ONLY", S.failed],
])(
  "shows a fixed safe explanation for known pre-dispatch error %s",
  async (error, message) => {
    const f = fixture(vi.fn().mockRejectedValue(error));
    await f.test.send(true);
    expect(f.test.state).toEqual({ phase: "failed", message });
    expect(f.submit).toHaveBeenCalledOnce();
  },
);
it.each([
  "NOTIFICATION_TEST_UNCONFIRMED",
  "secret/path/detail",
  "__proto__",
  "constructor",
  new Error("private detail"),
])(
  "keeps uncertain submission unknown without automatic retry or raw error",
  async (error) => {
    const f = fixture(vi.fn().mockRejectedValue(error));
    await f.test.send(true);
    expect(f.test.state).toEqual({ phase: "unknown", message: S.unknown });
    expect(f.submit).toHaveBeenCalledOnce();
    f.submit.mockResolvedValue("submitted");
    await f.test.send(true);
    expect(f.submit.mock.calls[1][0].sequence).toBe(2);
    expect(f.submit.mock.calls[1][0].rendererNonce).toBe(
      f.submit.mock.calls[0][0].rendererNonce,
    );
  },
);
it.each([undefined, null, true, {}, "success"])(
  "does not infer delivery from an invalid response",
  async (response) => {
    const f = fixture(vi.fn().mockResolvedValue(response));
    await f.test.send(true);
    expect(f.test.state.phase).toBe("unknown");
  },
);
it("distinguishes suppressed from submitted", async () => {
  const f = fixture(vi.fn().mockResolvedValue("suppressed"));
  await f.test.send(true);
  expect(f.test.state).toEqual({ phase: "suppressed", message: S.suppressed });
});
it.each(["resolve", "reject"])(
  "withdraws the exact in-flight ticket on disposal and ignores late %s",
  async (end) => {
    const pending = deferred<unknown>();
    const f = fixture(vi.fn().mockReturnValue(pending.promise));
    const first = f.test.send(true);
    const states = f.changed.mock.calls.length;
    f.test.release();
    f.test.release();
    expect(f.withdraw).toHaveBeenCalledExactlyOnceWith(
      f.submit.mock.calls[0][0],
    );
    if (end === "resolve") pending.resolve("submitted");
    else pending.reject("private detail");
    await first;
    await f.test.send(true);
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.changed).toHaveBeenCalledTimes(states);
  },
);
