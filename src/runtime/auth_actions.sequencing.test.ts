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
import { applyUpdate, threads, type ThreadState } from "./sessions";
import { invalidateAuthentication } from "./authentication";
import { emitOpeningHeader } from "./session_open_test_fixture";

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
    if (command === "session_open") {
      const result = {
        cwd: args.cwd,
        nativeSessionId: `preview-${++sequence}`,
        connectionId: `preview-connection-${sequence}`,
        resumed: false,
        configOptions: [],
        warnings: [],
      };
      emitOpeningHeader(args, result);
      return result;
    }
    if (command === "auth_run")
      return args.viaTerminal
        ? { kind: "terminal", ptyId: "terminal" }
        : { kind: "agent", ptyId: null };
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

function startup(state: ThreadState) {
  applyUpdate(state, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Startup information" },
  });
  applyUpdate(state, { sessionUpdate: "future_startup", payload: true });
}

it("closes an owned unprompted read with startup content before authenticating, retaining its records", async () => {
  const original = h.invoke.getMockImplementation()!;
  const unknown = { sessionUpdate: "future_startup", payload: { keep: true } };
  let channel: { onmessage: (event: unknown) => void };
  const initialize = (text: string) =>
    channel.onmessage({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  h.invoke.mockImplementation(async (command, args) => {
    const result = await original(command, args);
    if (command === "session_open") {
      channel = args.channel;
      initialize("Startup information");
      channel.onmessage({ update: unknown });
    }
    return result;
  });
  const f = await preview("startup-content");
  const state = threads.thread(f.key)!;
  expect(state.items.map((item) => item.kind)).toEqual(["agent", "raw"]);
  const close = deferred<void>();
  h.invoke.mockImplementation((command, args) =>
    command === "session_close" ? close.promise : original(command, args),
  );
  const job = start(f.target);
  expect(calls("session_close")).toHaveLength(1);
  expect(calls("session_close")[0][1]).toEqual({
    agentId: f.agentId,
    cwd: f.target.cwd,
    sessionId: state.nativeSessionId,
    allowAlreadyClosed: true,
  });
  expect(calls("auth_run")).toHaveLength(0);
  expect(f.controller.getSnapshot().threadKey).toBe(f.key);
  initialize("More startup information");
  close.resolve();
  await vi.waitFor(() => expect(calls("auth_run")).toHaveLength(1));
  expect(f.controller.getSnapshot().threadKey).toBeNull();
  expect(threads.thread(f.key)).toBe(state);
  expect(state).toMatchObject({
    identity: "draft",
    connectionLost: true,
    connectionOutcomeUnknown: false,
  });
  expect(state.items.map((item) => item.kind)).toEqual([
    "agent",
    "raw",
    "agent",
  ]);
  expect(state.items[1]).toMatchObject({ update: unknown });
  expect(calls("session_dismiss")).toHaveLength(0);
  const retained = [...state.items];
  channel!.onmessage({ update: { sessionUpdate: "late_future_startup" } });
  expect(state.items).toEqual(retained);
  expect(state.items).toHaveLength(3);
  await job.cancel();
});

it("retains startup records and their owner after a failed close, allowing an explicit retry", async () => {
  const f = await preview("startup-close-failure");
  const state = threads.thread(f.key)!;
  startup(state);
  const records = [...state.items];
  const original = h.invoke.getMockImplementation()!;
  let failed = true;
  h.invoke.mockImplementation((command, args) =>
    command === "session_close" && failed
      ? Promise.reject(new Error("close not confirmed"))
      : original(command, args),
  );
  const job = start(f.target);
  await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("failed"));
  expect(calls("auth_run")).toHaveLength(0);
  expect(calls("session_dismiss")).toHaveLength(0);
  expect(state.items).toEqual(records);
  expect(state.connectionLost).toBe(false);
  expect(f.controller.getSnapshot().threadKey).toBe(f.key);
  failed = false;
  const retry = start(f.target);
  await vi.waitFor(() => expect(calls("auth_run")).toHaveLength(1));
  expect(calls("session_close")).toHaveLength(2);
  expect(threads.thread(f.key)).toBe(state);
  expect(f.controller.getSnapshot().threadKey).toBeNull();
  await retry.cancel();
});

it.each([
  {
    label: "user input in a rolled-back draft",
    change: (s: ThreadState) =>
      applyUpdate(s, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Keep my input" },
      }),
  },
  {
    label: "a rolled-back request marker",
    change: (s: ThreadState) => (s.roundItemBase = s.items.length),
  },
  {
    label: "active tool metadata without a tool card",
    change: (s: ThreadState) => (s.activeToolCallIds = ["tool"]),
  },
  {
    label: "an unknown connection outcome",
    change: (s: ThreadState) => (s.connectionOutcomeUnknown = true),
  },
  {
    label: "changing permissions",
    change: (s: ThreadState) => (s.permissionState = "changing"),
  },
  {
    label: "unconfirmed reasoning activity",
    change: (s: ThreadState) =>
      applyUpdate(s, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking" },
      }),
  },
  {
    label: "an unconfirmed plan",
    change: (s: ThreadState) =>
      applyUpdate(s, { sessionUpdate: "plan", entries: [] }),
  },
])("cannot retire startup content with $label", async ({ label, change }) => {
  const f = await preview(label);
  const state = threads.thread(f.key)!;
  startup(state);
  change(state);
  const records = [...state.items];
  const job = start(f.target);
  await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("failed"));
  expect(calls("session_close")).toHaveLength(0);
  expect(calls("auth_run")).toHaveLength(0);
  expect(calls("session_dismiss")).toHaveLength(0);
  expect(f.controller.getSnapshot().threadKey).toBe(f.key);
  expect(threads.thread(f.key)).toBe(state);
  expect(state.items).toEqual(records);
});

it.each([
  {
    label: "a late queued user request",
    change: (s: ThreadState) =>
      s.queued.push([{ type: "text", text: "Do not lose this request" }]),
  },
  {
    label: "late tool activity",
    change: (s: ThreadState) => (s.activeToolCallIds = ["tool"]),
  },
  {
    label: "an ongoing configuration change",
    change: (s: ThreadState) => (s.configuring = true),
  },
  {
    label: "a newly unknown outcome",
    change: (s: ThreadState) => (s.connectionOutcomeUnknown = true),
  },
])(
  "keeps the owner and records when close overlaps $label",
  async ({ label, change }) => {
    const f = await preview(label);
    const state = threads.thread(f.key)!;
    startup(state);
    const records = [...state.items];
    const close = deferred<void>();
    const original = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation((command, args) =>
      command === "session_close" ? close.promise : original(command, args),
    );
    const job = start(f.target);
    expect(calls("session_close")).toHaveLength(1);
    change(state);
    close.resolve();
    await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("failed"));
    expect(calls("auth_run")).toHaveLength(0);
    expect(calls("session_dismiss")).toHaveLength(0);
    expect(f.controller.getSnapshot().threadKey).toBe(f.key);
    expect(threads.thread(f.key)).toBe(state);
    expect(state.connectionLost).toBe(false);
    expect(state.items).toEqual(records);
  },
);

it("does not release a newer preparation owner when an earlier read close is acknowledged", async () => {
  const f = await preview("changed-owner");
  const state = threads.thread(f.key)!;
  startup(state);
  const close = deferred<void>();
  const original = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation((command, args) =>
    command === "session_close" ? close.promise : original(command, args),
  );
  const job = start(f.target);
  expect(calls("session_close")).toHaveLength(1);
  await f.controller.prepare(
    { ...f.controller.getSnapshot().input!, program: "changed" },
    true,
  );
  const currentKey = f.controller.getSnapshot().threadKey;
  expect(currentKey).not.toBe(f.key);
  close.resolve();
  await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("failed"));
  expect(calls("auth_run")).toHaveLength(0);
  expect(calls("session_dismiss")).toHaveLength(0);
  expect(f.controller.getSnapshot().threadKey).toBe(currentKey);
  expect(threads.thread(f.key)).toBe(state);
  expect(state.connectionLost).toBe(false);
});

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

it("keeps the selected Key reference frozen while waiting for preparation cleanup", async () => {
  const f = await preview("method-key-selection");
  const close = deferred<void>();
  const original = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation((command, args) =>
    command === "session_close" ? close.promise : original(command, args),
  );
  const input = {
    target: { ...f.target },
    method: {
      id: "key-login",
      kind: "api-key",
      apiKeyProvider: "selected-provider",
    },
    credentialId: "selected-key-ref",
    credentialRevision: "selected-revision",
    onChanged: async () => {},
  };
  const job = beginAuthentication(input);
  expect(calls("auth_run")).toHaveLength(0);
  input.target.cwd = "/later";
  input.method.apiKeyProvider = "later-provider";
  input.credentialId = "later-key-ref";
  input.credentialRevision = "later-revision";
  close.resolve();
  await vi.waitFor(() => expect(calls("auth_run")).toHaveLength(1));
  expect(calls("auth_run")[0][1]).toMatchObject({
    cwd: f.target.cwd,
    methodId: "key-login",
    credentialId: "selected-key-ref",
    credentialRevision: "selected-revision",
  });
  await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("completed"));
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
  const result = {
    cwd: target.cwd,
    nativeSessionId: "delayed",
    connectionId: "delayed-connection",
    resumed: false,
    configOptions: [],
    warnings: [],
  };
  emitOpeningHeader(calls("session_open").at(-1)![1], result);
  open.resolve(result);
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
  const result = {
    cwd: target.cwd,
    nativeSessionId: "manual-delayed",
    connectionId: "manual-delayed-connection",
    resumed: false,
    configOptions: [],
  };
  emitOpeningHeader(calls("session_open").at(-1)![1], result);
  open.resolve(result);
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
  const result = {
    cwd: target.cwd,
    nativeSessionId: "configure-delayed",
    connectionId: "configure-delayed-connection",
    resumed: false,
    configOptions: [],
  };
  emitOpeningHeader(calls("session_open").at(-1)![1], result);
  open.resolve(result);
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
