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
import { emitOpeningHeader } from "./session_open_test_fixture";
import { ZERO_SEND_STRINGS } from "./conversation_access";
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

it("keeps a checked ID as an established read-only conversation across open and reopen without prompt admission", async () => {
  const receipt = {
    accountVerified: true,
    provider: "openai",
    fileAccess: "read-only",
    toolNetwork: false,
    approval: "on-request",
    model: "gpt-6-astra",
    effort: "ultra",
  };
  const input = { agentId: "receipt-test", cwd: "/receipt" };
  const opens: { purpose: unknown; nativeId: unknown }[] = [];
  h.invoke.mockImplementation(async (command, io) => {
    if (command !== "session_open") return localCommand(command, io);
    opens.push({ purpose: io.openPurpose, nativeId: io.nativeSessionId });
    const result = {
      cwd: input.cwd,
      nativeSessionId: "receipt-native-id",
      connectionId: `receipt-connection-${opens.length}`,
      resumed: Boolean(io.nativeSessionId),
      historyEmptyConfirmed: true,
      conversationAccess: { kind: "zero-send", receipt },
    };
    emitOpeningHeader(io, result);
    if (result.resumed)
      io.channel.onmessage({
        kind: "session_history_complete",
        openToken: io.openToken,
      });
    return result;
  });
  const state = await threads.open({
    ...input,
    fresh: true,
    openPurpose: "codex-official-check",
  });
  expect(state.identity).toBe("established");
  expect(state.conversationAccess?.receipt).toEqual(receipt);
  const blocks = [{ type: "text", text: "Keep this message" }] as const;
  await expect(threads.send(state.key, [...blocks])).resolves.toEqual({
    status: "rejected",
    reason: "unavailable",
  });
  expect(state.queued).toEqual([]);
  state.connectionLost = true;
  const reopened = await threads.open({
    ...input,
    nativeSessionId: state.nativeSessionId,
  });
  expect(reopened.key).toBe(state.key);
  expect(reopened.conversationAccess?.receipt).toEqual(receipt);
  expect(opens).toEqual([
    { purpose: "codex-official-check", nativeId: null },
    { purpose: undefined, nativeId: "receipt-native-id" },
  ]);
  await threads.continueQueue(reopened.key);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("rejects a legacy receipt returned for the checked-conversation action", async () => {
  h.invoke.mockImplementation(async (command, io) => {
    if (command !== "session_open") return localCommand(command, io);
    const result = {
      cwd: io.cwd,
      nativeSessionId: "legacy-result",
      connectionId: "legacy",
      resumed: false,
    };
    emitOpeningHeader(io, result);
    return result;
  });
  await expect(
    threads.open({
      agentId: "receipt-test",
      cwd: "/invalid-receipt",
      fresh: true,
      openPurpose: "codex-official-check",
    }),
  ).rejects.toThrow(ZERO_SEND_STRINGS.openFailed);
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_open"),
  ).toHaveLength(1);
});

const waitTarget = { agentId: "draft-wait", cancelWaitingDraft: true } as const;
type DraftOpening = {
  wire: Parameters<typeof emitOpeningHeader>[0] & {
    draftWaitChannel: { onmessage(event: unknown): void };
  };
  ready(): void;
  reject(reason: string): void;
};

function draftOpens() {
  const opens: DraftOpening[] = [];
  const cancellations: { token: string; confirm(result: boolean): void }[] = [];
  h.invoke.mockImplementation((command: string, args) => {
    if (command === "session_cancel_waiting_draft")
      return new Promise<boolean>((resolve) => {
        cancellations.push({ token: args.openToken, confirm: resolve });
      });
    if (command !== "session_open")
      return Promise.resolve(localCommand(command, args));
    return new Promise((resolve, reject) => {
      const result = {
        cwd: args.cwd,
        nativeSessionId: `draft-wait-${args.openToken}`,
        connectionId: `connection-${args.openToken}`,
        resumed: false,
      };
      opens.push({
        wire: args,
        ready: () => {
          emitOpeningHeader(args, result);
          resolve(result);
        },
        reject,
      });
    });
  });
  return { opens, cancellations };
}

it("keeps a shared draft open when another interested caller joins as the first leaves", async () => {
  const { opens, cancellations } = draftOpens();
  const a = new AbortController();
  const b = new AbortController();
  const input = { ...waitTarget, cwd: "/coalesced" };
  const first = threads.open({ ...input, inquirySignal: a.signal });
  const { openToken, draftWaitChannel } = opens[0].wire;
  draftWaitChannel.onmessage({ openToken });
  a.abort();
  const second = threads.open({ ...input, inquirySignal: b.signal });
  expect(second).toBe(first);
  await Promise.resolve();
  expect(cancellations).toEqual([]);
  opens[0].ready();
  expect((await second).cwd).toBe(input.cwd);
  b.abort();
  draftWaitChannel.onmessage({ openToken });
  expect(cancellations).toEqual([]);
});

it.each([
  { case: "confirmed", confirmed: true, stillCurrent: true },
  { case: "unconfirmed", confirmed: false, stillCurrent: true },
  { case: "caller-left", confirmed: true, stillCurrent: false },
])(
  "lets a late same-target caller proceed only after confirmed withdrawal: $case",
  async ({ case: name, confirmed, stillCurrent }) => {
    const { opens, cancellations } = draftOpens();
    const a = new AbortController();
    const b = new AbortController();
    const input = { ...waitTarget, cwd: `/late-${name}` };
    const first = threads.open({ ...input, inquirySignal: a.signal });
    const firstResult = first.catch((error) => error);
    const { openToken, draftWaitChannel } = opens[0].wire;
    a.abort();
    await Promise.resolve();
    const late = threads.open({ ...input, inquirySignal: b.signal });
    const lateResult = late.catch((error) => error);
    expect(late).not.toBe(first);
    draftWaitChannel.onmessage({ openToken: "foreign-token" });
    draftWaitChannel.onmessage({ openToken, extra: true });
    expect(cancellations).toEqual([]);
    draftWaitChannel.onmessage({ openToken });
    draftWaitChannel.onmessage({ openToken });
    expect(cancellations.map(({ token }) => token)).toEqual([openToken]);
    opens[0].reject("original waiting open ended");
    expect(await firstResult).toBe("original waiting open ended");
    expect(opens).toHaveLength(1);
    if (!stillCurrent) b.abort();
    cancellations[0].confirm(confirmed);
    if (confirmed && stillCurrent) {
      await vi.waitFor(() => expect(opens).toHaveLength(2));
      expect(opens[1].wire.openToken).not.toBe(openToken);
      opens[1].ready();
      expect(await lateResult).toMatchObject({ cwd: input.cwd });
    } else {
      expect(await lateResult).toBe("original waiting open ended");
      expect(opens).toHaveLength(1);
    }
    expect(
      h.invoke.mock.calls.filter(
        ([name]) => name === "session_cancel_waiting_draft",
      ),
    ).toEqual([["session_cancel_waiting_draft", { openToken }]]);
  },
);

it("isolates simultaneous preparation and ordinary drafts even when both request a fresh session", async () => {
  const opens: ((
    result: Parameters<typeof emitOpeningHeader>[1] & { resumed: boolean },
  ) => void)[] = [];
  h.invoke.mockImplementation((command: string, args) =>
    command === "session_open"
      ? new Promise((resolve) => {
          opens.push((result) => {
            emitOpeningHeader(args, result);
            resolve(result);
          });
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
  opens[0]({
    cwd: "/work",
    nativeSessionId: "ordinary",
    connectionId: "ordinary-connection",
    resumed: false,
  });
  opens[1]({
    cwd: "/work",
    nativeSessionId: "preparation",
    connectionId: "preparation-connection",
    resumed: false,
  });
  const [a, b] = await Promise.all([ordinary, preparing]);
  for (const [command, args] of h.invoke.mock.calls)
    if (command === "session_open")
      expect(args).not.toHaveProperty("draftWaitChannel");
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
    if (command === "session_open") {
      const result = {
        cwd: "/work",
        nativeSessionId: `rejection-${++sequence}`,
        connectionId: `rejection-connection-${sequence}`,
        resumed: false,
      };
      emitOpeningHeader(args, result);
      return result;
    }
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
      const result = {
        cwd: "/work",
        nativeSessionId: `choice-${sequence}`,
        connectionId: `choice-connection-${sequence}`,
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
      emitOpeningHeader(args, result);
      return result;
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

it("prefers complete modern options over separate modes during model reading", async () => {
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
      const result = {
        cwd: "/work",
        nativeSessionId: "separate-mode",
        connectionId: "separate-mode-connection",
        resumed: false,
        configOptions: options,
        modes: {
          currentModeId: "off",
          availableModes: [{ id: "off", name: "Off" }],
        },
        warnings: [],
      };
      emitOpeningHeader(args, result);
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
      return result;
    }
    return localCommand(command, args);
  });
  const controller = new AgentPreparation(threads, () => "modes");
  const config = { model: "chosen", thought_level: "off" };
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
  ).toBe(false);
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
    if (command === "session_open") {
      const result = {
        cwd: "/work",
        nativeSessionId: "real-category-less-mode",
        connectionId: "real-category-less-mode-connection",
        resumed: false,
        configOptions: [option],
        modes: {
          currentModeId: "separate",
          availableModes: [{ id: "separate", name: "Separate" }],
        },
        warnings: [],
      };
      emitOpeningHeader(args, result);
      return result;
    }
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
