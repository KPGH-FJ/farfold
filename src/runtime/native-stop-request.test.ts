import { describe, expect, it, vi } from "vitest";
import { NativeStopRequest } from "./native-stop-request";

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("native Stop request", () => {
  it("keeps stopping after acknowledgement and prevents duplicate commands until native termination", async () => {
    const request = new NativeStopRequest();
    const send = vi.fn().mockResolvedValue(true);
    request.reconcile("session:1", true);
    await request.request(send, vi.fn(), vi.fn());
    expect(request.stopping).toBe(true);
    await request.request(send, vi.fn(), vi.fn());
    expect(send).toHaveBeenCalledTimes(1);
    request.reconcile("session:1", false);
    expect(request.stopping).toBe(false);
  });

  it("allows retry after native rejection without claiming stopped", async () => {
    const request = new NativeStopRequest();
    const failed = vi.fn();
    request.reconcile("session:1", true);
    await request.request(async () => false, vi.fn(), failed);
    expect(failed).toHaveBeenCalledWith(
      expect.stringContaining("停止尚未确认"),
    );
    expect(request.stopping).toBe(false);
    await request.request(async () => true, vi.fn(), failed);
    expect(request.stopping).toBe(true);
  });

  it("ignores late failure from a previous turn in the same native session", async () => {
    const request = new NativeStopRequest();
    const old = deferred();
    const failed = vi.fn();
    request.reconcile("session:1", true);
    const pending = request.request(() => old.promise, vi.fn(), failed);
    request.reconcile("session:1", false);
    request.reconcile("session:1", true);
    await request.request(async () => true, vi.fn(), failed);
    old.reject(new Error("late response"));
    await pending;
    expect(failed).not.toHaveBeenCalled();
    expect(request.stopping).toBe(true);
  });

  it("invalidates pending commands when switching session or process generation", async () => {
    const request = new NativeStopRequest();
    const old = deferred();
    const failed = vi.fn();
    request.reconcile("session:1", true);
    const pending = request.request(() => old.promise, vi.fn(), failed);
    request.reconcile("session:2", true);
    expect(request.stopping).toBe(false);
    old.reject(new Error("old process"));
    await pending;
    expect(failed).not.toHaveBeenCalled();
  });
});
