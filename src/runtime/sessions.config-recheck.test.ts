import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), channels: new Map() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, type OpenResult, type ThreadState } from "./sessions";
import { composerDrafts, draftPersistence } from "./drafts";
import { STRINGS } from "./strings";
import { freshThreadState } from "./session_projection";
import { HistoryReplayBuffer } from "./history_replay";

const option = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "confirmed",
  options: [{ value: "confirmed", name: "Confirmed" }],
};
const ready = () => ({
  status: "ready" as const,
  issues: [],
  protectedIds: ["model"],
  current: {
    choices: [
      { id: "model", category: "model", type: "select", value: "confirmed" },
    ],
  },
});
function opened(args: Record<string, any>): OpenResult {
  h.channels.set(args.nativeSessionId, args.channel);
  args.channel.onmessage({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Existing history" },
    },
  });
  args.channel.onmessage({
    kind: "session_history_complete",
    openToken: args.openToken,
  });
  return {
    cwd: args.cwd,
    nativeSessionId: args.nativeSessionId,
    resumed: true,
    configOptions: [option],
    configCheck: ready(),
    service: null,
    permissionState: "ready",
    warnings: [],
  };
}
async function seed(id: string) {
  const state = await threads.open({
    agentId: "recheck",
    cwd: "/p",
    nativeSessionId: id,
  });
  h.invoke.mockClear();
  return state;
}
function block(state: ThreadState) {
  h.channels.get(state.nativeSessionId).onmessage({
    kind: "configCheck",
    check: {
      ...ready(),
      status: "blocked",
      issues: [
        {
          id: "model",
          category: "model",
          reason: "unknown",
          expected: "confirmed",
          current: null,
        },
      ],
    },
  });
}
beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open") return opened(args);
    if (command === "agent_work_get") return { cwd: args.cwd };
    if (command === "session_prompt") return { status: "accepted" };
    return command === "settings_get" ? null : [];
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockReset();
  h.channels.clear();
});

it("rechecks the same native conversation and admits the next explicit input exactly once", async () => {
  const old = await seed("recheck-next-input");
  block(old);
  composerDrafts.update(`session:${old.key}`, (draft) => ({
    ...draft,
    text: "Preserved unsent draft",
  }));
  expect(old.queuePaused).toBe("unavailable");
  const state = await threads.recheckConfig(old.key);
  expect(
    h.invoke.mock.calls.filter(
      ([command]) => command === "session_detach_for_config_check",
    ),
  ).toHaveLength(1);
  expect(
    h.invoke.mock.calls.find(([command]) => command === "session_open")?.[1],
  ).toMatchObject({
    agentId: old.agentId,
    cwd: old.cwd,
    nativeSessionId: old.nativeSessionId,
    service: null,
  });
  expect(state.key).toBe(old.key);
  expect(state.modelDrift).toBe(false);
  expect(state.queuePaused).toBeNull();
  expect(state.items).toContainEqual(
    expect.objectContaining({ text: "Existing history" }),
  );
  expect(composerDrafts.read(`session:${old.key}`).text).toBe(
    "Preserved unsent draft",
  );
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
  expect(
    await threads.send(state.key, [
      { type: "text", text: "Explicit next input" },
    ]),
  ).toEqual({ status: "accepted" });
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_prompt"),
  ).toHaveLength(1);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_close"),
  ).toBe(false);
});

it.each(["stopped", "uncertain", "no_result", "unavailable"] as const)(
  "preserves a pre-existing %s pause without sending a queue",
  async (pause) => {
    const old = await seed(`recheck-pause-${pause}`);
    old.queuePaused = pause;
    block(old);
    const state = await threads.recheckConfig(old.key);
    expect(state.queuePaused).toBe(pause);
    expect(
      h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
    ).toBe(false);
  },
);

it("does not release or send any previously queued message", async () => {
  const old = await seed("recheck-existing-queue");
  block(old);
  const queue = (old.queued = [[{ type: "text", text: "Previously queued" }]]);
  const state = await threads.recheckConfig(old.key);
  expect(state.queued).toBe(queue);
  expect(state.queuePaused).toBe("unavailable");
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it.each([
  "running",
  "submitting",
  "configuring",
  "stopUnconfirmed",
  "connectionOutcomeUnknown",
] as const)("rejects rechecking while %s", async (flag) => {
  const old = await seed(`recheck-busy-${flag}`);
  block(old);
  old[flag] = true;
  await expect(threads.recheckConfig(old.key)).rejects.toBeTruthy();
  expect(h.invoke).not.toHaveBeenCalled();
});

it.each(["sendPending", "queueEdit"] as const)(
  "rejects rechecking while draft %s owns input",
  async (flag) => {
    const old = await seed(`recheck-draft-${flag}`);
    block(old);
    composerDrafts.update(
      `${flag === "queueEdit" ? "queue-edit" : "session"}:${old.key}`,
      (draft) => ({
        ...draft,
        text: "Owned input",
        ...(flag === "sendPending"
          ? { sendPending: true }
          : { queueEdit: { index: 0, original: [] } }),
      }),
    );
    await expect(threads.recheckConfig(old.key)).rejects.toBeTruthy();
    expect(h.invoke).not.toHaveBeenCalled();
  },
);

it("keeps the original channel and unknown guard if safe detach fails", async () => {
  const old = await seed("recheck-detach-failure");
  block(old);
  const channel = h.channels.get(old.nativeSessionId);
  h.invoke.mockImplementation(async (command) => {
    if (command === "session_detach_for_config_check")
      throw new Error("Private transport diagnostic");
    return command === "settings_get" ? null : [];
  });
  await expect(threads.recheckConfig(old.key)).rejects.toBeTruthy();
  expect(threads.thread(old.key)).toBe(old);
  expect(old.modelDrift).toBe(true);
  expect(old.queuePaused).toBe("unavailable");
  expect(old.configError).toBe(STRINGS.repair.recheckConfigFailed);
  expect(old.reconnecting).toBe(false);
  channel.onmessage({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Still connected" },
    },
  });
  expect(
    old.items.some(
      (item) => "text" in item && item.text.includes("Still connected"),
    ),
  ).toBe(true);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_open"),
  ).toBe(false);
});

it("retains protection when a reload cannot confirm the saved choice", async () => {
  const old = await seed("recheck-still-unknown");
  block(old);
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open")
      return {
        ...opened(args),
        configCheck: {
          ...ready(),
          status: "blocked",
          issues: [
            {
              id: "model",
              category: "model",
              reason: "unknown",
              expected: "confirmed",
              current: null,
            },
          ],
        },
        warnings: ["Private official diagnostic"],
      };
    return command === "settings_get" ? null : [];
  });
  const state = await threads.recheckConfig(old.key);
  expect(state.modelDrift).toBe(true);
  expect(state.queuePaused).toBe("unavailable");
  expect(state.configError).toBe(STRINGS.repair.recheckConfigFailed);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("retains proven configuration-pause ownership across failed rechecks until a confirmed successful recheck", async () => {
  const old = await seed("recheck-failure-then-success");
  block(old);
  let failed = true;
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open")
      return {
        ...opened(args),
        ...(failed
          ? {
              configCheck: {
                ...ready(),
                status: "blocked",
                issues: [
                  {
                    id: "model",
                    category: "model",
                    reason: "unknown",
                    expected: "confirmed",
                    current: null,
                  },
                ],
              },
            }
          : {}),
      };
    return command === "settings_get" ? null : [];
  });
  const guarded = await threads.recheckConfig(old.key);
  expect(guarded.queuePaused).toBe("unavailable");
  failed = false;
  const recovered = await threads.recheckConfig(old.key);
  expect(recovered.queuePaused).toBeNull();
  expect(recovered.configError).toBeNull();
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it.each([false, true])(
  "only an explicit matching save confirmation releases a proven empty pause (existing queue: %s)",
  async (queued) => {
    const old = await seed(`recheck-save-confirm-${queued}`);
    block(old);
    if (queued) old.queued = [[{ type: "text", text: "Previously queued" }]];
    h.channels.get(old.nativeSessionId).onmessage({
      kind: "configCheck",
      check: { ...ready(), status: "record_failed" },
    });
    h.invoke.mockImplementation(async (command) => {
      if (command === "session_confirm_config") {
        const check = ready();
        h.channels
          .get(old.nativeSessionId)
          .onmessage({ kind: "configCheck", check });
        return check;
      }
      return command === "settings_get" ? null : [];
    });
    await threads.confirmConfig(old.key);
    expect(old.queuePaused).toBe(queued ? "unavailable" : null);
    expect(
      h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
    ).toBe(false);
  },
);

it.each(["unknown", "record_failed", "after_ready"])(
  "does not allow a stale reload receipt to clear %s from the new channel",
  async (reason) => {
    const old = await seed(`recheck-late-guard-${reason}`);
    block(old);
    h.invoke.mockImplementation(async (command, args) => {
      if (command === "session_open") {
        const result = opened(args);
        if (reason === "after_ready")
          args.channel.onmessage({ kind: "configCheck", check: ready() });
        args.channel.onmessage({
          kind: "configCheck",
          check: {
            ...ready(),
            status: reason === "record_failed" ? "record_failed" : "blocked",
            issues: [
              {
                category: "model",
                reason: reason === "unknown" ? "unknown" : "changed",
                expected: "confirmed",
                current: "other",
              },
            ],
          },
        });
        args.channel.onmessage({ kind: "configCheck", check: ready() });
        return result;
      }
      return command === "settings_get" ? null : [];
    });
    const state = await threads.recheckConfig(old.key);
    expect(state.modelDrift).toBe(true);
    expect(state.queuePaused).toBe("unavailable");
    expect(state.configError).toBe(STRINGS.repair.recheckConfigFailed);
  },
);

it("does not discard a stop that begins during detach", async () => {
  const old = await seed("recheck-stop-during-detach");
  block(old);
  h.invoke.mockImplementation(async (command) => {
    if (command === "session_detach_for_config_check") {
      old.stopping = true;
      old.queuePaused = "stopped";
    }
    return command === "settings_get" ? null : [];
  });
  await expect(threads.recheckConfig(old.key)).rejects.toBeTruthy();
  expect(old.queuePaused).toBe("stopped");
  expect(old.stopping).toBe(true);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_open"),
  ).toBe(false);
});

it("does not accept a replaced target or a changed service source", async () => {
  const old = await seed("recheck-wrong-source");
  block(old);
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open")
      return {
        ...opened(args),
        service: {
          id: "different-source",
          fingerprint: "different",
          model: "confirmed",
        },
      };
    return command === "settings_get" ? null : [];
  });
  await expect(threads.recheckConfig(old.key)).rejects.toBeTruthy();
  expect(threads.thread(old.key)).toBe(old);
  expect(old.service).toBeUndefined();
  expect(old.modelDrift).toBe(true);
  expect(old.queuePaused).toBe("unavailable");
});

it("explicitly retries its failed configuration reload without falling back to the ordinary cache or stranding an empty pause", async () => {
  const old = await seed("recheck-rpc-failure-then-retry");
  block(old);
  let fail = true;
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open") {
      if (fail) throw new Error("Private load diagnostic");
      return opened(args);
    }
    return command === "settings_get" ? null : [];
  });
  await expect(threads.recheckConfig(old.key)).rejects.toBeTruthy();
  expect(old.connectionLost).toBe(true);
  expect(old.configError).toBe(STRINGS.repair.recheckConfigFailed);
  fail = false;
  const recovered = await threads.reconnect(old.key);
  expect(recovered?.configCheck?.status).toBe("ready");
  expect(recovered?.queuePaused).toBeNull();
  expect(
    h.invoke.mock.calls.filter(
      ([command]) => command === "session_detach_for_config_check",
    ),
  ).toHaveLength(2);
  const detaches = h.invoke.mock.calls.filter(
    ([command]) => command === "session_detach_for_config_check",
  );
  expect(detaches[0][1].allowAlreadyDetached).toBeUndefined();
  expect(detaches[1][1].allowAlreadyDetached).toBe(true);
  expect(
    h.invoke.mock.calls.some(([command]) =>
      ["session_close", "session_prompt"].includes(command),
    ),
  ).toBe(false);
});

it.each([false, true])(
  "does not consume an identical unavailable pause from a real unsupported inquiry (during reload: %s)",
  async (during) => {
    const old = await seed(`recheck-non-config-pause-${during}`);
    block(old);
    if (!during)
      h.channels
        .get(old.nativeSessionId)
        .onmessage({ kind: "elicitationUnavailable", params: {} });
    if (during)
      h.invoke.mockImplementation(async (command, args) => {
        if (command === "session_open") {
          const result = opened(args);
          args.channel.onmessage({
            kind: "elicitationUnavailable",
            params: {},
          });
          return result;
        }
        return command === "settings_get" ? null : [];
      });
    const recovered = await threads.recheckConfig(old.key);
    expect(recovered.configCheck?.status).toBe("ready");
    expect(recovered.queuePaused).toBe("unavailable");
    expect(
      h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
    ).toBe(false);
  },
);

it("does not replace an owner that changes while official loading is in flight", async () => {
  const old = await seed("recheck-replaced-owner");
  block(old);
  const replacement = freshThreadState(
    old.key,
    old.agentId,
    old.cwd,
    old.nativeSessionId,
  );
  const before = structuredClone(replacement);
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open") {
      const result = opened(args);
      threads.getSnapshot().threads.set(old.key, replacement);
      return result;
    }
    return command === "settings_get" ? null : [];
  });
  await expect(threads.recheckConfig(old.key)).rejects.toBeTruthy();
  expect(threads.thread(old.key)).toBe(replacement);
  expect(replacement.configCheck).toBeNull();
  expect(replacement).toEqual(before);
});

it("preserves a new unknown permission signal during configuration reloading", async () => {
  const old = await seed("recheck-permission-unknown");
  block(old);
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open") {
      const result = opened(args);
      args.channel.onmessage({
        kind: "permissionState",
        permissionConfigId: "approval_policy",
        permissionState: "unknown",
      });
      return result;
    }
    return command === "settings_get" ? null : [];
  });
  const state = await threads.recheckConfig(old.key);
  expect(state.permissionState).toBe("unknown");
  expect(state.queuePaused).toBe("stopped");
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("retires unbound replay staging after a rejected reload without changing the retained draft or history", async () => {
  const old = await seed("recheck-retired-replay");
  block(old);
  composerDrafts.update(`session:${old.key}`, (draft) => ({
    ...draft,
    text: "Preserved during rejected reload",
  }));
  const draft = structuredClone(composerDrafts.read(`session:${old.key}`));
  const buffered = vi.spyOn(HistoryReplayBuffer.prototype, "push");
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open")
      return {
        ...opened(args),
        service: {
          id: "different-source",
          fingerprint: "different",
          model: "confirmed",
        },
      };
    return command === "settings_get" ? null : [];
  });
  await expect(threads.recheckConfig(old.key)).rejects.toBeTruthy();
  const items = structuredClone(old.items);
  const lateChannel = h.channels.get(old.nativeSessionId);
  buffered.mockClear();
  // Exercise the actual failed opening callback and its real buffer, rather
  // than inspecting a private collection or relying on garbage collection.
  for (let index = 0; index < 128; index++)
    lateChannel.onmessage({
      update: {
        sessionUpdate: "future_failed_reload",
        index,
        untouched: [null, true, "原值🙂"],
        padding: "x".repeat(1024),
      },
    });
  expect(buffered).not.toHaveBeenCalled();
  expect(threads.thread(old.key)).toBe(old);
  expect(old.items).toEqual(items);
  expect(composerDrafts.read(`session:${old.key}`)).toEqual(draft);
  expect(old.modelDrift).toBe(true);
  expect(old.queuePaused).toBe("unavailable");
  expect(
    h.invoke.mock.calls.some(([command]) =>
      ["session_close", "session_prompt", "session_set_config_option"].includes(
        command,
      ),
    ),
  ).toBe(false);
});

it("keeps bound live unknown data and connection loss after opening staging settles", async () => {
  const state = await seed("recheck-live-after-replay");
  const buffered = vi.spyOn(HistoryReplayBuffer.prototype, "push");
  const update = {
    sessionUpdate: "future_live_after_replay",
    value: [null, false, { full: "原值🙂", count: 17 }],
  };
  const channel = h.channels.get(state.nativeSessionId);
  channel.onmessage({ update });
  const retained = state.items.find(
    (item) => item.kind === "raw" && item.update === update,
  );
  expect(retained?.kind === "raw" && retained.update).toBe(update);
  expect(buffered).not.toHaveBeenCalled();
  channel.onmessage({ kind: "connectionLost", closeReason: "unexpected" });
  expect(state.connectionLost).toBe(true);
  expect(state.connectionCloseReason).toBe("unexpected");
});
