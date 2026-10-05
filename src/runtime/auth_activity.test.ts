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
const operation = (methodId: string) => ({
  kind: "authentication" as const,
  methodId,
  title: methodId,
  completion: "exit_code" as const,
});

const target = { agentId: "one", cwd: "/original" };
const terminalOperations = [
  operation("terminal"),
  {
    kind: "preparation" as const,
    actionId: "configure",
    purpose: "service_configuration" as const,
    title: "Configure service",
    completion: "exit_code" as const,
  },
];

describe("account activity continuity", () => {
  it("confirms the actual protocol reply before the separate connection check, retaining that evidence if checking fails", async () => {
    const job = new AuthActivity();
    const response = deferred<void>();
    const checked = deferred<void>();
    const reconnect = vi.fn(() => checked.promise);
    let unknown!: () => void;
    job.begin(target, operation("login"), "attempt");
    const running = job.protocol({
      run: (callback) => {
        unknown = callback;
        return response.promise;
      },
      cancel: async () => {},
      reconnect,
    });
    unknown();
    expect(job.getSnapshot()).toMatchObject({
      phase: "unknown",
      operationConfirmed: false,
      checked: false,
    });
    expect(reconnect).not.toHaveBeenCalled();
    response.resolve();
    await Promise.resolve();
    expect(job.getSnapshot()).toMatchObject({
      phase: "checking",
      operationConfirmed: true,
      checked: false,
      terminal: null,
      terminalOutcome: null,
    });
    const error = new Error("connection check incomplete");
    checked.reject(error);
    await running;
    expect(job.getSnapshot()).toMatchObject({
      phase: "completed",
      operationConfirmed: true,
      checked: false,
      error,
    });
    await job.recheck(async () => {});
    expect(job.getSnapshot()).toMatchObject({
      phase: "completed",
      operationConfirmed: true,
      checked: true,
      error: null,
    });
  });

  it("cannot turn a failed login into authentication proof by checking, and clears proof for the next account action", async () => {
    const job = new AuthActivity();
    job.begin(target, operation("login"), "failed");
    await job.protocol({
      run: async () => {
        throw new Error("authentication rejected");
      },
      cancel: async () => {},
      reconnect: async () => {},
    });
    await job.recheck(async () => {});
    expect(job.getSnapshot()).toMatchObject({
      phase: "completed",
      operationConfirmed: false,
      checked: true,
    });
    job.begin(target, operation("login"), "retry");
    await job.protocol({
      run: async () => {},
      cancel: async () => {},
      reconnect: async () => {},
    });
    expect(job.getSnapshot()?.operationConfirmed).toBe(true);
    job.begin(
      { ...target, cwd: "/later" },
      { ...operation("logout"), intent: "switch_account" },
      "switch",
    );
    expect(job.getSnapshot()).toMatchObject({
      attemptId: "switch",
      target: { cwd: "/later" },
      phase: "starting",
      operation: { intent: "switch_account" },
      operationConfirmed: false,
      checked: false,
      terminal: null,
      terminalOutcome: null,
    });
  });

  it("keeps a timed-out operation owned across detached views until its late response", async () => {
    const job = new AuthActivity();
    const response = deferred<void>();
    let unknown!: () => void;
    const reconnect = vi.fn(async () => {});
    job.begin(target, operation("login"), "attempt");
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
      job.begin({ agentId: "one", cwd: "/later" }, operation("login"), "later"),
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
    job.begin(target, operation("login"), "attempt");
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
      job.begin({ ...target, source: "api-a" }, operation("login"), "a"),
    ).toThrow();
    job.begin(target, operation("login"), "b");
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
    job.begin(target, operation("login"), "old");
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
    job.begin({ ...target, cwd: "/later" }, operation("login"), "new");
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
    job.begin(target, operation("terminal"), "attempt");
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
    job.begin(target, operation("terminal"), "attempt");
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
    job.begin(target, operation("terminal"), "attempt");
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
  it.each(terminalOperations)(
    "keeps a rejected $kind terminal wait unknown and owned until confirmed close",
    async (terminalOperation) => {
      const job = new AuthActivity();
      const exit = deferred<number>();
      const error = new Error("terminal wait unavailable");
      const close = vi.fn(async () => 130);
      const reconnect = vi.fn(async () => {});
      job.begin(target, terminalOperation, "attempt");
      job.terminal({
        start: async () => "owned-terminal",
        wait: () => exit.promise,
        close,
        reconnect,
      });
      const terminal = job.getSnapshot()!.terminal!;
      await terminal.start();
      exit.reject(error);
      await Promise.resolve();
      expect(terminal.getSnapshot()).toMatchObject({
        id: "owned-terminal",
        error,
        exit: null,
      });
      expect(job.getSnapshot()).toMatchObject({
        phase: "unknown",
        error,
        terminalOutcome: null,
        operationConfirmed: false,
        checked: false,
      });
      expect(authActive(job.getSnapshot())).toBe(true);
      expect(() => job.begin(target, operation("later"), "later")).toThrow();
      expect(reconnect).not.toHaveBeenCalled();
      await job.cancel();
      expect(close).toHaveBeenCalledExactlyOnceWith("owned-terminal");
      expect(job.getSnapshot()).toMatchObject({
        phase: "cancelled",
        error: null,
        terminalOutcome: { kind: "ended", code: 130, cancelled: true },
        operationConfirmed: false,
        checked: false,
      });
      expect(reconnect).not.toHaveBeenCalled();
    },
  );
  it.each(["checked", "check_failed"])(
    "uses the real %s result after an explicit return with nonzero terminal close",
    async (result) => {
      const job = new AuthActivity();
      const exit = deferred<number>();
      const check = deferred<void>();
      const reconnect = vi.fn(() => check.promise);
      job.begin(
        target,
        { ...operation("terminal"), completion: "return_and_verify" },
        "attempt",
      );
      job.terminal({
        start: async () => "owned-terminal",
        wait: () => exit.promise,
        close: async () => 130,
        reconnect,
      });
      await job.getSnapshot()!.terminal!.start();
      await job.cancel(true);
      expect(reconnect).toHaveBeenCalledOnce();
      expect(job.getSnapshot()).toMatchObject({
        phase: "checking",
        terminalOutcome: { kind: "ended", code: 130, cancelled: true },
        operationConfirmed: false,
        checked: false,
      });
      const error = new Error("connection check failed");
      if (result === "checked") check.resolve();
      else check.reject(error);
      await Promise.resolve();
      expect(job.getSnapshot()).toMatchObject({
        phase: "completed",
        operationConfirmed: false,
        checked: result === "checked",
        error: result === "checked" ? null : error,
      });
      job.begin({ ...target, cwd: "/later" }, operation("later"), "later");
      exit.reject(new Error("old terminal wait failed"));
      await Promise.resolve();
      expect(job.getSnapshot()).toMatchObject({
        attemptId: "later",
        phase: "starting",
        error: null,
        terminalOutcome: null,
      });
    },
  );
  it("does not check an explicit return until terminal recovery is confirmed", async () => {
    const job = new AuthActivity();
    const exit = deferred<number>();
    const error = new Error("terminal is still owned");
    const close = vi.fn<() => Promise<number | null>>(async () => {
      throw error;
    });
    const reconnect = vi.fn(async () => {});
    job.begin(
      target,
      { ...operation("terminal"), completion: "return_and_verify" },
      "attempt",
    );
    job.terminal({
      start: async () => "owned-terminal",
      wait: () => exit.promise,
      close,
      reconnect,
    });
    await job.getSnapshot()!.terminal!.start();
    await job.cancel(true);
    expect(job.getSnapshot()).toMatchObject({
      phase: "unknown",
      error,
      terminalOutcome: null,
      operationConfirmed: false,
      checked: false,
    });
    expect(authActive(job.getSnapshot())).toBe(true);
    expect(reconnect).not.toHaveBeenCalled();
    close.mockResolvedValueOnce(130);
    await job.cancel(true);
    await Promise.resolve();
    expect(reconnect).toHaveBeenCalledOnce();
    expect(job.getSnapshot()).toMatchObject({
      phase: "completed",
      terminalOutcome: { kind: "ended", code: 130, cancelled: true },
      operationConfirmed: false,
      checked: true,
    });
    exit.resolve(0);
  });
});

describe("explicit terminal finish and connection check", () => {
  it("waits for a real terminal before offering finish and notifies when it is ready", async () => {
    const job = new AuthActivity();
    const startup = deferred<string>();
    const exit = deferred<number>();
    const closed = deferred<number | null>();
    const close = vi.fn(() => closed.promise);
    const cancel = vi.fn(async () => {});
    const reconnect = vi.fn(async () => {});
    job.begin(target, operation("terminal"), "attempt");
    job.terminal({
      start: () => startup.promise,
      wait: () => exit.promise,
      close,
      cancel,
      reconnect,
    });
    const changed = vi.fn();
    job.subscribe(changed);
    await job.finishTerminal();
    expect(job.getSnapshot()).toMatchObject({
      phase: "starting",
      finishRequested: false,
      operationConfirmed: false,
      checked: false,
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    startup.resolve("same-terminal");
    await job.getSnapshot()!.terminal!.start();
    expect(changed).toHaveBeenCalled();
    expect(job.getSnapshot()?.phase).toBe("waiting");
    const finishing = job.finishTerminal();
    await job.finishTerminal();
    expect(close).toHaveBeenCalledOnce();
    expect(reconnect).not.toHaveBeenCalled();
    expect(job.getSnapshot()).toMatchObject({
      phase: "cancelling",
      finishRequested: true,
      operationConfirmed: false,
      checked: false,
    });
    closed.resolve(130);
    await finishing;
    expect(reconnect).toHaveBeenCalledOnce();
    expect(job.getSnapshot()).toMatchObject({
      phase: "completed",
      finishRequested: true,
      terminalOutcome: { kind: "ended", code: 130, cancelled: true },
      operationConfirmed: false,
      checked: true,
    });
    exit.resolve(0);
    await Promise.resolve();
    expect(reconnect).toHaveBeenCalledOnce();
    expect(job.getSnapshot()?.operationConfirmed).toBe(false);
    await job.finishTerminal();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the finish intent through a failed close and the ordinary retry-close action", async () => {
    const job = new AuthActivity();
    const exit = deferred<number>();
    const check = deferred<void>();
    const error = new Error("terminal remains owned");
    const close = vi
      .fn<() => Promise<number | null>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(130);
    const reconnect = vi.fn(() => check.promise);
    job.begin(target, operation("terminal"), "attempt");
    job.terminal({
      start: async () => "same-terminal",
      wait: () => exit.promise,
      close,
      reconnect,
    });
    await job.getSnapshot()!.terminal!.start();
    await job.finishTerminal();
    expect(job.getSnapshot()).toMatchObject({
      phase: "unknown",
      finishRequested: true,
      error,
      terminalOutcome: null,
      operationConfirmed: false,
      checked: false,
    });
    expect(authActive(job.getSnapshot())).toBe(true);
    expect(reconnect).not.toHaveBeenCalled();
    await job.cancel();
    expect(reconnect).toHaveBeenCalledOnce();
    expect(job.getSnapshot()).toMatchObject({
      phase: "checking",
      finishRequested: true,
      operationConfirmed: false,
      checked: false,
    });
    check.reject(new Error("new pending interaction blocks recheck"));
    await Promise.resolve();
    expect(job.getSnapshot()).toMatchObject({
      phase: "completed",
      finishRequested: true,
      operationConfirmed: false,
      checked: false,
    });
    job.begin({ ...target, cwd: "/later" }, operation("later"), "later");
    expect(job.getSnapshot()?.finishRequested).toBe(false);
    exit.resolve(0);
    await Promise.resolve();
    expect(job.getSnapshot()).toMatchObject({
      attemptId: "later",
      phase: "starting",
      finishRequested: false,
    });
  });

  it("never uses terminal finish to end a protocol login", async () => {
    const job = new AuthActivity();
    const response = deferred<void>();
    const cancel = vi.fn(async () => {});
    const reconnect = vi.fn(async () => {});
    job.begin(target, operation("login"), "attempt");
    const running = job.protocol({
      run: () => response.promise,
      cancel,
      reconnect,
    });
    await job.finishTerminal();
    expect(cancel).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
    expect(job.getSnapshot()).toMatchObject({
      phase: "waiting",
      finishRequested: false,
    });
    response.resolve();
    await running;
  });

  it("does not overwrite an immediate unknown wait or real exit with the ready notification", async () => {
    const job = new AuthActivity();
    const close = vi.fn(async () => 130);
    const reconnect = vi.fn(async () => {});
    const error = new Error("wait result unavailable");
    job.begin(target, operation("terminal"), "unknown");
    job.terminal({
      start: async () => "owned-terminal",
      wait: async () => {
        throw error;
      },
      close,
      reconnect,
    });
    await job.getSnapshot()!.terminal!.start();
    expect(job.getSnapshot()).toMatchObject({
      phase: "unknown",
      error,
      finishRequested: false,
    });
    await job.finishTerminal();
    expect(job.getSnapshot()).toMatchObject({
      phase: "completed",
      finishRequested: true,
      operationConfirmed: false,
      checked: true,
    });
    job.begin(target, operation("terminal"), "natural-exit");
    job.terminal({
      start: async () => "next-terminal",
      wait: async () => 0,
      close,
      reconnect,
    });
    await job.getSnapshot()!.terminal!.start();
    await Promise.resolve();
    expect(job.getSnapshot()).toMatchObject({
      phase: "completed",
      finishRequested: false,
      operationConfirmed: true,
      checked: true,
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
