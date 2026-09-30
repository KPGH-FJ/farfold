import { describe, expect, it, vi } from "vitest";
import { AuthActivity, authActive } from "./auth_activity";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const target = { agentId: "one", cwd: "/original" };

describe("account activity continuity", () => {
  it("keeps a timed-out operation owned across detached views until its late response", async () => {
    const job = new AuthActivity();
    const response = deferred<void>();
    let unknown!: () => void;
    const reconnect = vi.fn(async () => {});
    job.begin(target, "login", "attempt");
    const unsubscribe = job.subscribe(() => {});
    const completed = job.protocol({
      run: (callback) => {
        unknown = callback;
        return response.promise;
      },
      cancel: async () => {},
      reconnect,
    });
    unsubscribe();
    unknown();
    expect(job.getSnapshot()?.phase).toBe("unknown");
    expect(authActive(job.getSnapshot())).toBe(true);
    expect(() =>
      job.begin({ agentId: "one", cwd: "/later" }, "login", "later"),
    ).toThrow();
    response.resolve();
    await completed;
    expect(job.getSnapshot()?.target.cwd).toBe("/original");
    expect(job.getSnapshot()?.phase).toBe("completed");
    expect(reconnect).toHaveBeenCalledTimes(1);
    unknown();
    expect(job.getSnapshot()?.phase).toBe("completed");
  });
  it("does not label cancellation requested as completed cancellation or discard late success", async () => {
    const job = new AuthActivity();
    const response = deferred<void>();
    const cancel = vi.fn(async () => {});
    job.begin(target, "login", "attempt");
    const completed = job.protocol({
      run: () => response.promise,
      cancel,
      reconnect: async () => {},
    });
    await job.cancel();
    expect(job.getSnapshot()?.phase).toBe("cancelling");
    expect(authActive(job.getSnapshot())).toBe(true);
    response.resolve();
    await completed;
    expect(job.getSnapshot()?.phase).toBe("completed");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("recognizes real cancellation responses and never accepts an API source for account login", async () => {
    const job = new AuthActivity();
    expect(() =>
      job.begin({ ...target, source: "api-a" }, "login", "a"),
    ).toThrow();
    job.begin(target, "login", "b");
    await job.protocol({
      run: async () => {
        throw new Error("AUTH_CANCELLED");
      },
      cancel: async () => {},
      reconnect: async () => {},
    });
    expect(job.getSnapshot()?.phase).toBe("cancelled");
    expect(job.getSnapshot()?.checked).toBe(false);
  });
  it("does not let a late cancel or end failure overwrite a completed or newer attempt", async () => {
    const job = new AuthActivity();
    const response = deferred<void>();
    const cancel = deferred<void>();
    const end = deferred<void>();
    job.begin(target, "login", "old");
    const completed = job.protocol({
      run: () => response.promise,
      cancel: () => cancel.promise,
      end: () => end.promise,
      reconnect: async () => {},
    });
    const cancellation = job.cancel();
    const ending = job.endConnection();
    response.resolve();
    await completed;
    cancel.reject(new Error("old cancellation failed"));
    await cancellation;
    expect(job.getSnapshot()?.phase).toBe("completed");
    job.begin({ ...target, cwd: "/later" }, "login", "new");
    end.reject(new Error("old end failed"));
    await ending;
    expect(job.getSnapshot()).toMatchObject({
      attemptId: "new",
      phase: "starting",
    });
  });
  it("keeps terminal output and input identity through detach and cancel during startup", async () => {
    const job = new AuthActivity();
    const startup = deferred<string>();
    const exit = deferred<number>();
    const close = deferred<number | null>();
    let output!: (data: string) => void;
    const closePort = vi.fn(() => close.promise);
    const start = vi.fn((listener: (data: string) => void) => {
      output = listener;
      return startup.promise;
    });
    job.begin(target, "terminal", "attempt");
    job.terminal({
      start,
      wait: () => exit.promise,
      close: closePort,
      reconnect: async () => {},
    });
    const terminal = job.getSnapshot()!.terminal!;
    const unsubscribe = terminal.subscribe(() => {});
    output("Zmlyc3Q=");
    unsubscribe();
    output("c2Vjb25k");
    const cancellation = job.cancel();
    expect(closePort).not.toHaveBeenCalled();
    startup.resolve("same-terminal");
    await Promise.resolve();
    await Promise.resolve();
    expect(terminal.getSnapshot().output.map((value) => value.data)).toEqual([
      "Zmlyc3Q=",
      "c2Vjb25k",
    ]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(closePort).toHaveBeenCalledWith("same-terminal");
    expect(job.getSnapshot()?.phase).toBe("cancelling");
    close.resolve(1);
    await cancellation;
    expect(job.getSnapshot()?.phase).toBe("cancelled");
    exit.resolve(0);
    await Promise.resolve();
    expect(job.getSnapshot()?.phase).toBe("cancelled");
  });
  it("retains unknown when terminal close fails, and a later real exit resolves the same attempt", async () => {
    const job = new AuthActivity();
    const exit = deferred<number>();
    job.begin(target, "terminal", "attempt");
    job.terminal({
      start: async () => "terminal",
      wait: () => exit.promise,
      close: async () => {
        throw new Error("still running");
      },
      reconnect: async () => {},
    });
    await job.cancel();
    expect(job.getSnapshot()?.phase).toBe("unknown");
    expect(authActive(job.getSnapshot())).toBe(true);
    exit.resolve(1);
    await Promise.resolve();
    expect(job.getSnapshot()?.phase).toBe("cancelled");
  });
  it("checks a confirmed successful terminal exit even when cancellation was requested", async () => {
    const job = new AuthActivity();
    const exit = deferred<number>();
    const reconnect = vi.fn(async () => {});
    job.begin(target, "terminal", "attempt");
    job.terminal({
      start: async () => "terminal",
      wait: () => exit.promise,
      close: async () => 0,
      reconnect,
    });
    await job.cancel();
    await Promise.resolve();
    expect(reconnect).toHaveBeenCalledOnce();
    expect(job.getSnapshot()?.phase).toBe("completed");
    exit.resolve(0);
  });
});
