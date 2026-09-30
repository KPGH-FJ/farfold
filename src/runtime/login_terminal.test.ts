import { describe, expect, it, vi } from "vitest";
import { BufferedLoginTerminal, LoginTerminal } from "./login_terminal";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const start = deferred<string>();
  const wait = deferred<number>();
  const closed = deferred<number | null>();
  const ports = {
    start: vi.fn(() => start.promise),
    wait: vi.fn(() => wait.promise),
    close: vi.fn(() => closed.promise),
    ready: vi.fn(),
    exit: vi.fn(),
    error: vi.fn(),
  };
  return { start, wait, closed, ports, terminal: new LoginTerminal(ports) };
}

describe("login terminal ownership", () => {
  it("retains a close failure after a real terminal id, including a cancellation-shaped error", async () => {
    const wait = deferred<number>();
    const error = new Error("AUTH_CANCELLED");
    const terminal = new BufferedLoginTerminal({
      start: async () => "owned",
      wait: () => wait.promise,
      close: async () => {
        throw error;
      },
      exit: vi.fn(),
    });
    await terminal.start();
    await expect(terminal.close()).rejects.toBe(error);
    expect(terminal.getSnapshot()).toMatchObject({
      id: "owned",
      error,
      exit: null,
      closing: false,
    });
    wait.resolve(1);
  });
  it("waits for an already-consumed owner's real success instead of inventing cancellation failure", async () => {
    const f = fixture();
    f.start.resolve("owned");
    await f.terminal.start();
    const closing = f.terminal.close();
    f.closed.resolve(null);
    await Promise.resolve();
    expect(f.ports.exit).not.toHaveBeenCalled();
    f.wait.resolve(0);
    await closing;
    expect(f.ports.exit).toHaveBeenCalledExactlyOnceWith(0, true);
  });
  it("a cancel during startup waits for the actual owner and closes only once", async () => {
    const f = fixture();
    const starting = f.terminal.start();
    const cancelled = f.terminal.close();
    expect(f.terminal.close()).toBe(cancelled);
    expect(f.ports.close).not.toHaveBeenCalled();
    f.start.resolve("owned");
    await starting;
    await Promise.resolve();
    expect(f.ports.close).toHaveBeenCalledExactlyOnceWith("owned");
    expect(f.ports.exit).not.toHaveBeenCalled();
    f.closed.resolve(1);
    await cancelled;
    expect(f.ports.exit).toHaveBeenCalledExactlyOnceWith(1, true);
    f.wait.resolve(0);
    await Promise.resolve();
    expect(f.ports.exit).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed close retryable without reporting exit", async () => {
    const f = fixture();
    f.start.resolve("owned");
    await f.terminal.start();
    const closing = f.terminal.close();
    f.closed.reject(new Error("still alive"));
    await expect(closing).rejects.toThrow("still alive");
    expect(f.ports.exit).not.toHaveBeenCalled();
    f.ports.close.mockResolvedValueOnce(1);
    await f.terminal.close();
    expect(f.ports.close).toHaveBeenCalledTimes(2);
    expect(f.ports.exit).toHaveBeenCalledExactlyOnceWith(1, true);
  });

  it("does not claim a failed wait is process termination", async () => {
    const f = fixture();
    f.start.resolve("owned");
    await f.terminal.start();
    f.wait.reject(new Error("channel unavailable"));
    await Promise.resolve();
    expect(f.ports.error).toHaveBeenCalled();
    expect(f.ports.exit).not.toHaveBeenCalled();
    f.closed.resolve(1);
    await f.terminal.close();
    expect(f.ports.exit).toHaveBeenCalledExactlyOnceWith(1, true);
  });

  it("disposing during startup reclaims the late owner without stale UI callbacks", async () => {
    const f = fixture();
    const starting = f.terminal.start();
    f.terminal.dispose();
    f.start.resolve("late");
    await starting;
    await Promise.resolve();
    expect(f.ports.close).toHaveBeenCalledExactlyOnceWith("late");
    f.closed.resolve(1);
    f.wait.resolve(0);
    await Promise.resolve();
    expect(f.ports.ready).not.toHaveBeenCalled();
    expect(f.ports.exit).not.toHaveBeenCalled();
  });
});
