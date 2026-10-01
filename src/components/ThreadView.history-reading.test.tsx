import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import {
  threads,
  applyUpdate,
  hasActiveTools,
  toolActivityState,
  type OpenResult,
  type ThreadState,
} from "../runtime/sessions";
import { draftPersistence } from "../runtime/drafts";
import { STRINGS } from "../runtime/strings";
import { ThreadView } from "./ThreadView";

const view = (thread: ThreadState) =>
  renderToStaticMarkup(
    <ThreadView
      thread={thread}
      active
      agents={[]}
      onGoSettings={() => {}}
      onOpened={() => {}}
    />,
  );
function old(id: string, cwd = "/p") {
  const state = threads.markOpenFailed(
    `fixture:${cwd}:${id}`,
    "fixture",
    cwd,
    id,
    "retry",
  );
  state.items.push({
    kind: "agent",
    id: `old-${id}`,
    text: "Previous readable body",
    streaming: false,
    time: 0,
  });
  state.queued = [[{ type: "text", text: "Keep unsent" }]];
  state.queuePaused = "stopped";
  return state;
}
function loaded(
  args: Record<string, any>,
  overrides: Partial<OpenResult> = {},
) {
  return {
    cwd: args.cwd,
    nativeSessionId: args.nativeSessionId,
    resumed: true,
    configOptions: [],
    service: null,
    serviceContext: null,
    ...overrides,
  };
}
function boundary(args: Record<string, any>) {
  args.channel.onmessage({
    kind: "session_history_complete",
    openToken: args.openToken,
  });
}
function open(state: ThreadState) {
  return threads.open({
    agentId: state.agentId,
    cwd: state.cwd,
    nativeSessionId: state.nativeSessionId,
  });
}
function harmlessCallsOnly() {
  expect(
    h.invoke.mock.calls.some(([command]) =>
      [
        "session_prompt",
        "session_set_config",
        "session_confirm_config",
      ].includes(command),
    ),
  ).toBe(false);
}

beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  h.invoke.mockImplementation(async (command) =>
    command === "settings_get" ? null : [],
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  h.invoke.mockReset();
});

it("reports an acknowledged config-only load as missing history without claiming a lost connection", async () => {
  const state = old("config-only");
  state.modelDrift = true;
  state.configCheck = {
    status: "blocked",
    issues: [],
    current: { original: "guard" },
  };
  const guard = state.configCheck;
  const originalItems = state.items;
  const queue = state.queued;
  h.invoke.mockImplementation(async (command, args) => {
    if (command !== "session_open") return [];
    args.channel.onmessage({
      update: { sessionUpdate: "config_option_update", configOptions: [] },
    });
    boundary(args);
    return loaded(args);
  });
  await expect(open(state)).rejects.toBeTruthy();
  expect(state.historyUnavailable?.reason).toBe("empty");
  expect(state.connectionLost).toBe(false);
  expect(state.items).toBe(originalItems);
  expect(state.queued).toBe(queue);
  expect(state.configCheck).toBe(guard);
  expect(state.modelDrift).toBe(true);
  const html = view(state);
  expect(html).toContain("对话读取失败");
  expect(html).toContain("未能读取对话内容");
  expect(html).toMatch(/>重试读取<\/button>/);
  expect(html).toContain(STRINGS.repair.newDraft);
  expect(html).not.toContain(STRINGS.repair.reconnectFailed);
  expect(html).not.toContain(STRINGS.thread.connectionIdle);
  await threads.send(state.key, [{ type: "text", text: "Do not send" }]);
  harmlessCallsOnly();
});

it("classifies an incomplete local boundary separately and ignores its late replay", async () => {
  vi.useFakeTimers();
  const state = old("missing-marker");
  let channel!: { onmessage: (event: unknown) => void };
  let args!: Record<string, any>;
  h.invoke.mockImplementation(async (command, input) => {
    if (command !== "session_open") return [];
    args = input;
    channel = args.channel;
    channel.onmessage({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Partial body" },
      },
    });
    return loaded(args);
  });
  const opening = expect(open(state)).rejects.toBeTruthy();
  await vi.advanceTimersByTimeAsync(30_000);
  await opening;
  expect(state.historyUnavailable?.reason).toBe("incomplete");
  expect(state.connectionLost).toBe(false);
  expect(view(state)).toContain("未能完整读取对话内容");
  boundary(args);
  channel.onmessage({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Late body" },
    },
  });
  expect(state.items).toEqual([
    expect.objectContaining({ text: "Previous readable body" }),
  ]);
  harmlessCallsOnly();
});

it("does not relabel an observed connection loss as an empty history", async () => {
  const state = old("real-lost");
  h.invoke.mockImplementation(async (command, args) => {
    if (command !== "session_open") return [];
    args.channel.onmessage({ kind: "connectionLost" });
    boundary(args);
    return loaded(args);
  });
  await expect(open(state)).rejects.toBeTruthy();
  expect(state.historyUnavailable).toBeNull();
  expect(state.connectionLost).toBe(true);
  expect(view(state)).toContain(STRINGS.thread.connectionIdle);
  expect(view(state)).not.toContain("对话读取失败");
});

it("does not classify a remote error with the same visible history words", async () => {
  const state = old("remote-canary");
  h.invoke.mockImplementation(async (command) => {
    if (command === "session_open")
      throw new Error(STRINGS.repair.historyUnavailable);
    return [];
  });
  await expect(open(state)).rejects.toBeTruthy();
  expect(state.historyUnavailable).toBeNull();
  expect(state.connectionLost).toBe(true);
  expect(state.openError).toBe(STRINGS.repair.reconnectFailed);
  expect(view(state)).not.toContain("对话读取失败");
});

it("clears an earlier connection loss after acknowledged load while retaining unknown execution protection", async () => {
  const state = old("earlier-unknown");
  state.connectionLost = true;
  state.connectionOutcomeUnknown = true;
  state.stopUnconfirmed = true;
  h.invoke.mockImplementation(async (command, args) => {
    if (command !== "session_open") return [];
    boundary(args);
    return loaded(args);
  });
  await expect(open(state)).rejects.toBeTruthy();
  expect(state.historyUnavailable?.reason).toBe("empty");
  expect(state.connectionLost).toBe(false);
  expect(state.connectionOutcomeUnknown).toBe(true);
  expect(state.stopUnconfirmed).toBe(true);
  harmlessCallsOnly();
});

it("does not revive old tool activity when the replacement connection returned an unreadable history", async () => {
  const state = old("prior-tool-activity");
  applyUpdate(state, {
    sessionUpdate: "tool_call",
    toolCallId: "old-unfinished",
    title: "Old command",
    kind: "execute",
    status: "in_progress",
  });
  state.activeToolCallIds = ["old-unfinished"];
  state.connectionLost = true;
  state.connectionOutcomeUnknown = true;
  h.invoke.mockImplementation(async (command, args) => {
    if (command !== "session_open") return [];
    boundary(args);
    return loaded(args);
  });
  await expect(open(state)).rejects.toBeTruthy();
  expect(state.connectionLost).toBe(false);
  expect(state.connectionOutcomeUnknown).toBe(true);
  expect(hasActiveTools(state)).toBe(false);
  const tool = state.items.find((item) => item.kind === "tool");
  if (tool?.kind !== "tool") throw new Error("Missing prior tool");
  expect(tool.call.status).toBe("in_progress");
  expect(toolActivityState(state, tool.call)).toBe("unknown");
  expect(view(state)).not.toContain('class="g run"');
  harmlessCallsOnly();
});

it("retains the canonical target and confirmed API source for explicit retry and a fresh empty draft", async () => {
  const state = old("api-canonical", "/tmp/project");
  const service = {
    id: "original-api",
    model: "original-model",
    fingerprint: "f",
  };
  let phase: "fail" | "retry" | "fresh" = "fail";
  h.invoke.mockImplementation(async (command, args) => {
    if (command !== "session_open") return [];
    if (phase === "fresh") {
      expect(args).toMatchObject({
        agentId: "fixture",
        cwd: "/private/tmp/project",
        nativeSessionId: null,
        configOptions: null,
        service,
      });
      return loaded(args, {
        cwd: "/private/tmp/project",
        nativeSessionId: "api-new-draft",
        resumed: false,
        service,
        serviceContext: "original-revision",
      });
    }
    if (phase === "retry")
      expect(args).toMatchObject({
        cwd: "/private/tmp/project",
        nativeSessionId: "api-canonical",
        configOptions: null,
        service: null,
      });
    boundary(args);
    return loaded(args, {
      cwd: "/private/tmp/project",
      service,
      serviceContext: "original-revision",
    });
  });
  await expect(open(state)).rejects.toBeTruthy();
  const key = "fixture:/private/tmp/project:api-canonical";
  expect(threads.thread(key)).toBe(state);
  expect(threads.thread("fixture:/tmp/project:api-canonical")).toBeUndefined();
  expect(state.service).toEqual(service);
  expect(state.serviceContext).toBe("original-revision");
  phase = "retry";
  await threads.reconnect(key);
  expect(state.historyUnavailable?.reason).toBe("empty");
  phase = "fresh";
  const draft = await threads.newAfterRecoveryFailure(key);
  expect(draft.items).toEqual([]);
  expect(draft.queued).toEqual([]);
  expect(draft.identity).toBe("draft");
  expect(state.items[0]).toMatchObject({ text: "Previous readable body" });
  expect(state.queued).toHaveLength(1);
  harmlessCallsOnly();
});

it("does not invent an existing-settings source when the successful load omitted source metadata", async () => {
  const id = "cold-source-unknown";
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "agent_work_get") return { cwd: args.cwd, enabled: {} };
    if (command !== "session_open") return [];
    boundary(args);
    return {
      cwd: args.cwd,
      nativeSessionId: id,
      resumed: true,
      configOptions: [],
    };
  });
  await expect(
    threads.open({ agentId: "fixture", cwd: "/p", nativeSessionId: id }),
  ).rejects.toBeTruthy();
  const state = threads.thread(`fixture:/p:${id}`)!;
  expect(state.historyUnavailable?.reason).toBe("empty");
  h.invoke.mockClear();
  await expect(threads.newAfterRecoveryFailure(state.key)).rejects.toBeTruthy();
  expect(h.invoke).not.toHaveBeenCalled();
});

it("accepts a complete readable retry, clears the history failure and retains fixed model protection", async () => {
  const state = old("retry-readable");
  let fail = true;
  h.invoke.mockImplementation(async (command, args) => {
    if (command !== "session_open") return [];
    if (!fail)
      args.channel.onmessage({
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Recovered body" },
        },
      });
    boundary(args);
    return loaded(args, {
      configCheck: {
        status: "blocked",
        issues: [],
        current: { choices: [] },
      },
    });
  });
  await expect(open(state)).rejects.toBeTruthy();
  fail = false;
  await threads.reconnect(state.key);
  const recovered = threads.thread(state.key)!;
  expect(recovered.historyUnavailable).toBeNull();
  expect(recovered.openError).toBeNull();
  expect(recovered.connectionLost).toBe(false);
  expect(recovered.modelDrift).toBe(true);
  expect(recovered.configCheck?.status).toBe("blocked");
  expect(recovered.queued).toEqual(state.queued);
  expect(recovered.items[0]).toMatchObject({ text: "Recovered body" });
  harmlessCallsOnly();
});

it("retains the returned API identity in a genuinely cold failed placeholder", async () => {
  const id = "cold-api-source";
  const service = {
    id: "cold-api",
    model: "cold-model",
    fingerprint: "cold-f",
  };
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "agent_work_get") return { cwd: args.cwd, enabled: {} };
    if (command !== "session_open") return [];
    if (!args.nativeSessionId) {
      expect(args).toMatchObject({
        cwd: "/private/tmp/cold",
        service,
        configOptions: null,
      });
      return loaded(args, { nativeSessionId: "cold-api-new", resumed: false });
    }
    boundary(args);
    return loaded(args, {
      cwd: "/private/tmp/cold",
      service,
      serviceContext: "cold-api-revision",
    });
  });
  await expect(
    threads.open({ agentId: "fixture", cwd: "/tmp/cold", nativeSessionId: id }),
  ).rejects.toBeTruthy();
  const state = threads.thread(`fixture:/private/tmp/cold:${id}`)!;
  expect(state.service).toEqual(service);
  expect(state.serviceContext).toBe("cold-api-revision");
  expect(state.items).toEqual([]);
  expect(state.historyUnavailable?.reason).toBe("empty");
  expect(view(state)).not.toContain("原内容已保留");
  const draft = await threads.newAfterRecoveryFailure(state.key);
  expect(draft.identity).toBe("draft");
  harmlessCallsOnly();
});

it("observes a real loss after failed history without admitting late body or letting that owner affect a newer retry", async () => {
  const state = old("late-real-lost");
  let first!: Record<string, any>;
  let retried = false;
  h.invoke.mockImplementation(async (command, args) => {
    if (command !== "session_open") return [];
    if (!retried) first = args;
    else
      args.channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "New owner body" },
        },
      });
    boundary(args);
    return loaded(args);
  });
  await expect(open(state)).rejects.toBeTruthy();
  first.channel.onmessage({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Late rejected body" },
    },
  });
  expect(state.items[0]).toMatchObject({ text: "Previous readable body" });
  first.channel.onmessage({ kind: "connectionLost" });
  expect(state.connectionLost).toBe(true);
  expect(state.historyUnavailable?.reason).toBe("empty");
  retried = true;
  await threads.reconnect(state.key);
  const recovered = threads.thread(state.key)!;
  expect(recovered.connectionLost).toBe(false);
  first.channel.onmessage({ kind: "connectionLost" });
  expect(recovered.connectionLost).toBe(false);
  expect(recovered.items[0]).toMatchObject({ text: "New owner body" });
  harmlessCallsOnly();
});
