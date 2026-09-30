import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { beginAuthentication, beginPreparationAction } from "./auth_actions";
import { preparationFor } from "./agent_preparation";
import { threads } from "./sessions";
import { invalidateAuthentication } from "./authentication";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let sequence = 0;
const calls = (command: string) =>
  h.invoke.mock.calls.filter(([name]) => name === command);
beforeEach(() => {
  h.invoke.mockReset();
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open")
      return {
        cwd: args.cwd,
        nativeSessionId: `preview-${++sequence}`,
        resumed: false,
        configOptions: [],
        warnings: [],
      };
    if (command === "auth_run") return { kind: "terminal", ptyId: "terminal" };
    if (
      command === "auth_manual_run" ||
      command === "agent_preparation_action_run"
    )
      return "terminal";
    if (command === "pty_await") return new Promise(() => {});
    if (command === "pty_close") return 1;
    if (command === "settings_get") return null;
    return [];
  });
});
async function preview(label: string, cwd = "/original") {
  const agentId = `sequence-${label}-${++sequence}`;
  const controller = preparationFor(agentId);
  await controller.prepare({
    agentId,
    agentName: "Fixture",
    cwd,
    program: "selected",
    service: null,
  });
  const key = controller.getSnapshot().threadKey!;
  return { agentId, controller, key, target: { agentId, cwd } };
}
function start(
  target: { agentId: string; cwd: string },
  kind = "terminal",
  manual = false,
  logout = false,
) {
  return beginAuthentication({
    target,
    method: { id: "login", kind },
    manual,
    logout,
    onChanged: async () => {},
  });
}

it.each(["terminal", "agent", "manual", "logout", "configuration"])(
  "waits for the exact preparation close before %s dispatch",
  async (route) => {
    const f = await preview(route);
    const close = deferred<void>();
    const original = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation((command, args) =>
      command === "session_close" ? close.promise : original(command, args),
    );
    const job =
      route === "configuration"
        ? beginPreparationAction({
            target: f.target,
            action: {
              id: "configure",
              purpose: "service_configuration",
              transport: "terminal",
              command: "/selected",
              args: ["configure"],
              sourceUrl: "https://example.com",
            },
            onChanged: async () => {},
          })
        : start(
            f.target,
            route === "agent" || route === "logout" ? "agent" : "terminal",
            route === "manual",
            route === "logout",
          );
    const command =
      route === "configuration"
        ? "agent_preparation_action_run"
        : route === "manual"
          ? "auth_manual_run"
          : route === "logout"
            ? "agent_logout"
            : "auth_run";
    expect(calls("session_close")).toHaveLength(1);
    expect(calls("session_close")[0][1]).toMatchObject({
      cwd: f.target.cwd,
      allowAlreadyClosed: true,
    });
    expect(calls(command)).toHaveLength(0);
    expect(threads.thread(f.key)).toBeDefined();
    expect(job.getSnapshot()?.target).toEqual(f.target);
    close.resolve();
    await vi.waitFor(() => expect(calls(command)).toHaveLength(1));
    expect(threads.thread(f.key)).toBeUndefined();
    expect(calls("session_close")).toHaveLength(1);
    if (route !== "agent" && route !== "logout") await job.cancel();
  },
);

it("retains the exact draft and failed owner for an explicit retry when close fails", async () => {
  const f = await preview("failure");
  const original = h.invoke.getMockImplementation()!;
  let fails = true;
  h.invoke.mockImplementation((command, args) =>
    command === "session_close" && fails
      ? Promise.reject(new Error("close outcome unknown"))
      : original(command, args),
  );
  const job = start(f.target);
  await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("failed"));
  expect(calls("auth_run")).toHaveLength(0);
  expect(threads.thread(f.key)).toBeDefined();
  expect(f.controller.getSnapshot().threadKey).toBe(f.key);
  expect(job.getSnapshot()?.target).toEqual(f.target);
  fails = false;
  const retried = start(f.target);
  await vi.waitFor(() => expect(calls("auth_run")).toHaveLength(1));
  expect(calls("session_close")).toHaveLength(2);
  await retried.cancel();
});

it("does not dispatch login after cancellation while its close acknowledgment is pending", async () => {
  const f = await preview("cancel");
  const close = deferred<void>();
  const original = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation((command, args) =>
    command === "session_close" ? close.promise : original(command, args),
  );
  const job = start(f.target);
  const cancelling = job.cancel();
  expect(calls("auth_cancel")).toHaveLength(1);
  expect(calls("auth_run")).toHaveLength(0);
  close.resolve();
  await cancelling;
  await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("cancelled"));
  expect(calls("auth_run")).toHaveLength(0);
  expect(calls("pty_close")).toHaveLength(0);
  expect(job.getSnapshot()?.terminal?.getSnapshot().error).toBeNull();
});

it("does not close or authenticate through a draft with an uncertain request", async () => {
  const f = await preview("unknown");
  threads.thread(f.key)!.connectionOutcomeUnknown = true;
  const job = start(f.target);
  await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("failed"));
  expect(calls("auth_run")).toHaveLength(0);
  expect(calls("session_close")).toHaveLength(0);
  expect(threads.thread(f.key)).toBeDefined();
});

it("does not discard a preparation draft belonging to another directory", async () => {
  const f = await preview("other", "/other");
  const job = start({ agentId: f.agentId, cwd: "/original" });
  await vi.waitFor(() => expect(calls("auth_run")).toHaveLength(1));
  expect(calls("session_close")).toHaveLength(0);
  expect(threads.thread(f.key)).toBeDefined();
  await job.cancel();
});

it("waits for an in-flight model read and then closes its returned empty draft", async () => {
  const open = deferred<unknown>(),
    close = deferred<void>();
  const original = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation((command, args) =>
    command === "session_open"
      ? open.promise
      : command === "session_close"
        ? close.promise
        : original(command, args),
  );
  const target = {
    agentId: `sequence-opening-${++sequence}`,
    cwd: "/original",
  };
  const controller = preparationFor(target.agentId);
  const opening = controller.prepare({
    ...target,
    agentName: "Fixture",
    program: "selected",
    service: null,
  });
  const job = start(target);
  expect(calls("auth_run")).toHaveLength(0);
  open.resolve({
    cwd: target.cwd,
    nativeSessionId: "delayed",
    resumed: false,
    configOptions: [],
    warnings: [],
  });
  await opening;
  await vi.waitFor(() => expect(calls("session_close")).toHaveLength(1));
  expect(calls("auth_run")).toHaveLength(0);
  close.resolve();
  await vi.waitFor(() => expect(calls("auth_run")).toHaveLength(1));
  await job.cancel();
});

it("keeps a pending read owned after manual configuration invalidation until strict close succeeds", async () => {
  const open = deferred<unknown>();
  const original = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation((command, args) =>
    command === "session_open"
      ? open.promise
      : command === "session_close"
        ? Promise.reject(new Error("close outcome unknown"))
        : original(command, args),
  );
  const target = { agentId: `manual-opening-${++sequence}`, cwd: "/original" };
  const controller = preparationFor(target.agentId);
  const opening = controller.prepare({
    ...target,
    agentName: "Fixture",
    program: "selected",
    service: null,
  });
  // Saving an explicit manual command revokes verification while the read is pending.
  invalidateAuthentication(target.agentId);
  const job = start(target, "terminal", true);
  open.resolve({
    cwd: target.cwd,
    nativeSessionId: "manual-delayed",
    resumed: false,
    configOptions: [],
  });
  await opening;
  await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("failed"));
  expect(calls("auth_manual_run")).toHaveLength(0);
  expect(controller.getSnapshot().threadKey).not.toBeNull();
  expect(threads.thread(controller.getSnapshot().threadKey!)).toBeDefined();
});

it("does not let a delayed model read clear a service configuration's explicit read requirement", async () => {
  const open = deferred<unknown>();
  const original = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation((command, args) =>
    command === "session_open" ? open.promise : original(command, args),
  );
  const target = {
    agentId: `configure-opening-${++sequence}`,
    cwd: "/original",
  };
  const controller = preparationFor(target.agentId);
  const opening = controller.prepare(
    { ...target, agentName: "Fixture", program: "selected", service: null },
    true,
  );
  const job = beginPreparationAction({
    target,
    action: {
      id: "configure",
      purpose: "service_configuration",
      transport: "terminal",
      command: "/selected",
      args: ["configure"],
      sourceUrl: "https://example.com",
    },
    onChanged: async () => {},
  });
  const gate = controller.getSnapshot().explicitReadTargets;
  open.resolve({
    cwd: target.cwd,
    nativeSessionId: "configure-delayed",
    resumed: false,
    configOptions: [],
  });
  await opening;
  await vi.waitFor(() =>
    expect(calls("agent_preparation_action_run")).toHaveLength(1),
  );
  expect(controller.getSnapshot().explicitReadTargets).toEqual(gate);
  expect(gate).toHaveLength(1);
  await job.cancel();
});

it("keeps confirmed close usable when hiding the closed preview from history fails", async () => {
  const f = await preview("dismiss-failure");
  const original = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation((command, args) =>
    command === "session_dismiss"
      ? Promise.reject(new Error("storage failed"))
      : original(command, args),
  );
  const job = start(f.target);
  await vi.waitFor(() => expect(calls("auth_run")).toHaveLength(1));
  expect(threads.thread(f.key)).toBeUndefined();
  expect(calls("session_dismiss")).toHaveLength(1);
  await job.cancel();
});

it.each([false, true])(
  "does not dispatch a cancelled protocol operation after cancel IPC fails (logout=%s)",
  async (logout) => {
    const f = await preview(`cancel-ipc-${logout}`);
    const close = deferred<void>();
    const original = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation((command, args) =>
      command === "session_close"
        ? close.promise
        : command === "auth_cancel"
          ? Promise.reject(new Error("cancel delivery unknown"))
          : original(command, args),
    );
    const job = start(f.target, "agent", false, logout);
    await job.cancel();
    expect(job.getSnapshot()?.phase).toBe("unknown");
    close.resolve();
    await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("cancelled"));
    expect(calls(logout ? "agent_logout" : "auth_run")).toHaveLength(0);
    expect(calls("auth_recheck")).toHaveLength(0);
  },
);

it("does not close an API preparation preview for an existing-account action", async () => {
  const f = await preview("other-api");
  f.controller.getSnapshot().input!.service = {
    id: "api",
    model: "selected",
    revision: "same",
  };
  const job = start(f.target);
  await vi.waitFor(() => expect(calls("auth_run")).toHaveLength(1));
  expect(calls("session_close")).toHaveLength(0);
  expect(threads.thread(f.key)).toBeDefined();
  await job.cancel();
});

it("does not start login if work appears before the draft close is acknowledged", async () => {
  const f = await preview("late-work");
  const close = deferred<void>();
  const original = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation((command, args) =>
    command === "session_close" ? close.promise : original(command, args),
  );
  const job = start(f.target);
  threads.thread(f.key)!.submitting = true;
  close.resolve();
  await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("failed"));
  expect(calls("auth_run")).toHaveLength(0);
  expect(threads.thread(f.key)).toBeDefined();
});
