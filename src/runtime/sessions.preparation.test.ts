import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";
import { AgentPreparation } from "./agent_preparation";
import { draftPersistence } from "./drafts";
const settings = new Map<string, unknown>();
function localCommand(command: string, args?: Record<string, unknown>) {
  if (command === "settings_get")
    return args?.key === "autoArchiveDays"
      ? 30
      : (settings.get(String(args?.key)) ?? null);
  if (command === "settings_set") {
    settings.set(String(args?.key), structuredClone(args?.value));
    return null;
  }
  return [];
}
beforeEach(() => {
  settings.clear();
  h.invoke.mockReset();
});
afterEach(async () => {
  await draftPersistence.flush();
});

it("isolates simultaneous preparation and ordinary drafts even when both request a fresh session", async () => {
  const opens: ((result: unknown) => void)[] = [];
  h.invoke.mockImplementation((command: string, args) =>
    command === "session_open"
      ? new Promise((resolve) => {
          opens.push(resolve);
        })
      : Promise.resolve(localCommand(command, args)),
  );
  const ordinary = threads.open({
    agentId: "scope-test",
    cwd: "/work",
    fresh: true,
  });
  const preparing = threads.open({
    agentId: "scope-test",
    cwd: "/work",
    fresh: true,
    draftScope: "setup",
  });
  expect(opens).toHaveLength(2);
  opens[0]({ cwd: "/work", nativeSessionId: "ordinary", resumed: false });
  opens[1]({ cwd: "/work", nativeSessionId: "preparation", resumed: false });
  const [a, b] = await Promise.all([ordinary, preparing]);
  expect(a.key).not.toBe(b.key);
  expect(await threads.open({ agentId: "scope-test", cwd: "/work" })).toBe(a);
  expect(
    await threads.open({
      agentId: "scope-test",
      cwd: "/work",
      draftScope: "setup",
    }),
  ).toBe(b);
});

it.each(["accepted", "rejected", "unknown"] as const)(
  "returns %s admission without pretending the Agent finished",
  async (status) => {
    h.invoke.mockImplementation(async (command: string, args) =>
      command === "session_prompt" ? { status } : localCommand(command, args),
    );
    const s = threads.markOpenFailed(
      `receipt:/work:${status}`,
      "receipt",
      "/work",
      status,
      "",
    );
    s.openError = null;
    s.connectionLost = false;
    expect(
      await threads.send(s.key, [{ type: "text", text: "check" }]),
    ).toEqual({ status });
    expect(s.items.some((item) => item.kind === "settled")).toBe(false);
  },
);

it("requires explicit preparation of a fresh draft after a rejected test, without resuming a paused queue", async () => {
  h.invoke.mockClear();
  let sequence = 0;
  let prompts = 0;
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "session_open")
      return {
        cwd: "/work",
        nativeSessionId: `rejection-${++sequence}`,
        resumed: false,
      };
    if (command === "session_prompt")
      return ++prompts === 1
        ? { status: "rejected", reason: "failed" }
        : { status: "accepted" };
    return localCommand(command, args);
  });
  const controller = new AgentPreparation(threads, () => "rejected-test");
  const send = vi.spyOn(threads, "send");
  const input = {
    agentId: "rejected-prepare",
    agentName: "Example",
    cwd: "/work",
    program: "program",
    service: null,
  };
  await controller.prepare(input);
  const rejectedKey = controller.getSnapshot().threadKey!;
  const rejected = threads.thread(rejectedKey)!;
  await controller.start();
  expect(controller.getSnapshot().phase).toBe("failed");
  expect(rejected.queuePaused).toBe("failed");
  expect(rejected.queued).toHaveLength(0);

  await controller.start();
  expect(prompts).toBe(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(rejected.queued).toHaveLength(0);
  await controller.prepare(input, true);
  const freshKey = controller.getSnapshot().threadKey!;
  expect(freshKey).not.toBe(rejectedKey);
  expect(threads.thread(rejectedKey)).toBeUndefined();
  expect(rejected.queuePaused).toBe("failed");
  expect(controller.getSnapshot().phase).toBe("untested");
  expect(prompts).toBe(1);

  await controller.start();
  expect(prompts).toBe(2);
  expect(threads.thread(freshKey)?.identity).toBe("established");
  send.mockRestore();
});

it("retains an unapplied explicit model choice as a read failure until an explicit retry", async () => {
  let sequence = 0;
  const input = {
    agentId: "unapplied-choice",
    agentName: "Example",
    cwd: "/work",
    program: "program",
    service: null,
    config: { model: "chosen", reasoning: "high" },
  };
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "session_open") {
      sequence++;
      return {
        cwd: "/work",
        nativeSessionId: `choice-${sequence}`,
        resumed: false,
        warnings:
          sequence === 1
            ? ["private upstream details must not become UI text"]
            : [],
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            category: "model",
            currentValue: "chosen",
            options: [],
          },
          {
            id: "reasoning",
            name: "Reasoning",
            type: "select",
            currentValue: sequence === 1 ? "off" : "high",
            options: [],
          },
        ],
      };
    }
    return localCommand(command, args);
  });
  const controller = new AgentPreparation(threads, () => "choice");
  await controller.prepare(input);
  expect(controller.getSnapshot()).toMatchObject({
    phase: "failed",
    input,
    config: { model: "chosen", reasoning: "off" },
    error: expect.any(String),
  });
  expect(controller.getSnapshot().error).not.toContain("private upstream");
  await controller.start();
  await controller.prepare(input);
  expect(sequence).toBe(1);
  expect(input.config).toEqual({ model: "chosen", reasoning: "high" });
  expect(h.invoke.mock.calls.some(([cmd]) => cmd === "session_prompt")).toBe(
    false,
  );
  await controller.prepare(input, true);
  expect(sequence).toBe(2);
  expect(controller.getSnapshot()).toMatchObject({
    phase: "untested",
    error: null,
    config: input.config,
  });
});

it("retains separate modes through option updates replayed during model reading", async () => {
  const options = [
    {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "chosen",
      options: [],
    },
    {
      id: "thought_level",
      name: "Thinking",
      type: "select",
      category: "thought_level",
      currentValue: "off",
      options: [],
    },
  ];
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "session_open") {
      args.channel.onmessage({
        update: {
          sessionUpdate: "config_option_update",
          configOptions: options,
        },
      });
      args.channel.onmessage({
        update: {
          sessionUpdate: "config_option_update",
          configOptions: options,
        },
      });
      args.channel.onmessage({
        update: { sessionUpdate: "current_mode_update", currentModeId: "off" },
      });
      return {
        cwd: "/work",
        nativeSessionId: "separate-mode",
        resumed: false,
        configOptions: options,
        modes: {
          currentModeId: "off",
          availableModes: [{ id: "off", name: "Off" }],
        },
        warnings: [],
      };
    }
    return localCommand(command, args);
  });
  const controller = new AgentPreparation(threads, () => "modes");
  const config = { model: "chosen", thought_level: "off", mode: "off" };
  await controller.prepare({
    agentId: "separate-mode",
    agentName: "Example",
    cwd: "/work",
    program: "program",
    service: null,
    config,
  });
  expect(controller.getSnapshot()).toMatchObject({
    phase: "untested",
    config,
    error: null,
  });
  expect(
    threads.thread(controller.getSnapshot().threadKey!)?.modesSeparate,
  ).toBe(true);
});

it("keeps a real category-less mode at initial open and routes its changes through config options", async () => {
  const option = {
    id: "mode",
    name: "Actual mode",
    type: "select",
    currentValue: "real-a",
    options: [
      { value: "real-a", name: "A" },
      { value: "real-b", name: "B" },
    ],
  };
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "session_open")
      return {
        cwd: "/work",
        nativeSessionId: "real-category-less-mode",
        resumed: false,
        configOptions: [option],
        modes: {
          currentModeId: "separate",
          availableModes: [{ id: "separate", name: "Separate" }],
        },
        warnings: [],
      };
    if (command === "session_set_config")
      return {
        configOptions: [{ ...option, currentValue: args.value }],
        configCheck: { status: "ready", issues: [], current: {} },
        permissionConfigId: null,
        permissionState: "ready",
        service: null,
      };
    return localCommand(command, args);
  });
  const controller = new AgentPreparation(threads, () => "real-mode");
  await controller.prepare({
    agentId: "real-category-less-mode",
    agentName: "Example",
    cwd: "/work",
    program: "program",
    service: null,
    config: { mode: "real-a" },
  });
  const snapshot = controller.getSnapshot();
  const state = threads.thread(snapshot.threadKey!)!;
  expect(state.configOptions.map((value) => value.id)).toEqual(["mode"]);
  expect(state.modesSeparate).toBe(false);
  expect(snapshot).toMatchObject({
    phase: "untested",
    config: { mode: "real-a" },
  });
  await threads.setConfig(state.key, "mode", "real-b");
  expect(h.invoke).toHaveBeenCalledWith(
    "session_set_config",
    expect.objectContaining({ configId: "mode", value: "real-b" }),
  );
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_set_mode"),
  ).toBe(false);
  expect(state.configOptions).toHaveLength(1);
  expect(controller.getSnapshot().config).toEqual({ mode: "real-b" });
});
