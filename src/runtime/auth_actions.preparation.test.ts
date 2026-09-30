import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { beginPreparationAction } from "./auth_actions";
import {
  authenticationActivity,
  observeAuthentication,
  authenticationRequired,
  useAuthentication,
} from "./authentication";
import {
  preparationFor,
  preparationNeedsExplicitRead,
} from "./agent_preparation";
import { PREPARATION_ACTION_STRINGS as S } from "./preparation_action_strings";
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const action = {
  id: "configure-service",
  purpose: "service_configuration" as const,
  transport: "terminal" as const,
  command: "/managed/program",
  args: ["configure"],
  sourceUrl: "https://example.com/official",
};
afterEach(() => vi.clearAllMocks());

it("freezes the reviewed operation, immediately cancels startup, and reaps a late exact terminal", async () => {
  const startup = deferred<string>(),
    exit = deferred<number>();
  h.invoke.mockImplementation(async (cmd, args) => {
    if (cmd === "agent_preparation_action_run") return startup.promise;
    if (cmd === "pty_await") return exit.promise;
    if (cmd === "pty_close") {
      expect(args).toEqual({ id: "owned-terminal" });
      return 1;
    }
    return undefined;
  });
  const target = { agentId: "prepare-cancel-late", cwd: "/original" };
  const reviewed = { ...action, args: [...action.args] };
  const job = beginPreparationAction({
    target,
    action: reviewed,
    onChanged: async () => {},
  });
  const id = job.getSnapshot()!.attemptId;
  reviewed.args[0] = "changed";
  target.cwd = "/later";
  expect(job.getSnapshot()).toMatchObject({
    target: { cwd: "/original" },
    operation: {
      kind: "preparation",
      title: S.title,
      actionId: action.id,
      completion: "exit_code",
    },
  });
  expect(h.invoke).toHaveBeenCalledWith(
    "agent_preparation_action_run",
    expect.objectContaining({ expectedArgs: ["configure"], cwd: "/original" }),
  );
  const cancelling = job.cancel();
  expect(h.invoke).toHaveBeenCalledWith("auth_cancel", {
    agentId: target.agentId,
    attemptId: id,
  });
  expect(h.invoke.mock.calls.some(([cmd]) => cmd === "pty_close")).toBe(false);
  expect(job.getSnapshot()?.phase).toBe("cancelling");
  startup.resolve("owned-terminal");
  await cancelling;
  expect(job.getSnapshot()?.phase).toBe("cancelled");
  expect(
    h.invoke.mock.calls.some(
      ([cmd]) => cmd === "auth_end" || cmd === "auth_recheck",
    ),
  ).toBe(false);
  exit.resolve(1);
});

it("reports early acknowledged cancellation without a fabricated PTY or generic failure", async () => {
  const startup = deferred<string>();
  h.invoke.mockImplementation(async (cmd) => {
    if (cmd === "agent_preparation_action_run") return startup.promise;
    if (cmd === "auth_cancel") startup.reject(new Error("AUTH_CANCELLED"));
  });
  const job = beginPreparationAction({
    target: { agentId: "prepare-cancel-early", cwd: "/work" },
    action,
    onChanged: async () => {},
  });
  await job.cancel();
  expect(job.getSnapshot()).toMatchObject({
    phase: "cancelled",
    error: null,
    checked: false,
  });
  expect(job.getSnapshot()?.terminal?.getSnapshot()).toMatchObject({
    id: null,
    error: null,
    exit: null,
    closing: false,
  });
  await job.recheck(async () => {});
  expect(job.getSnapshot()).toMatchObject({
    phase: "completed",
    checked: true,
    terminalOutcome: { kind: "cancelled" },
  });
  expect(
    h.invoke.mock.calls.some(
      ([cmd]) => cmd === "pty_close" || cmd === "auth_end",
    ),
  ).toBe(false);
});

it("retains a completed command and failed recheck, then requires explicit models after retry", async () => {
  const exit = deferred<number>();
  let checks = 0;
  h.invoke.mockImplementation(async (cmd) => {
    if (cmd === "agent_preparation_action_run") return "configuration";
    if (cmd === "pty_await") return exit.promise;
    if (cmd === "auth_recheck" && ++checks === 1)
      throw new Error("connection unavailable");
  });
  const target = { agentId: "prepare-completion", cwd: "/original" };
  observeAuthentication(
    target.agentId,
    target.cwd,
    "AUTH_REQUIRED",
    undefined,
    "request",
  );
  const onChanged = vi.fn(async () => {});
  const job = beginPreparationAction({ target, action, onChanged });
  const terminal = job.getSnapshot()!.terminal!;
  const detach = terminal.subscribe(() => {});
  detach();
  exit.resolve(0);
  await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("completed"));
  expect(authenticationActivity(target.agentId)).toBe(job);
  expect(job.getSnapshot()).toMatchObject({
    checked: false,
    operation: { title: S.title },
  });
  expect(job.getSnapshot()?.error).toBeTruthy();
  expect(terminal.getSnapshot().exit).toBe(0);
  await job.recheck(async () => {
    await h.invoke("auth_recheck", target);
    await onChanged();
  });
  expect(job.getSnapshot()).toMatchObject({
    checked: true,
    phase: "completed",
    error: null,
  });
  const input = {
    ...target,
    agentName: "Example",
    program: "program",
    service: null,
  };
  const controller = preparationFor(target.agentId);
  await controller.prepare(input);
  expect(preparationNeedsExplicitRead(controller.getSnapshot(), input)).toBe(
    true,
  );
  expect(
    authenticationRequired(useAuthentication(), target.agentId, target.cwd),
  ).toBe(true);
  expect(
    h.invoke.mock.calls.some(([cmd]) =>
      ["session_open", "session_prompt", "auth_end"].includes(cmd),
    ),
  ).toBe(false);
});

it("rejects API configuration before starting an action or touching preparation", () => {
  expect(() =>
    beginPreparationAction({
      target: { agentId: "prepare-api", cwd: "/original", source: "api-key" },
      action,
      onChanged: async () => {},
    }),
  ).toThrow();
  expect(h.invoke).not.toHaveBeenCalled();
});
