import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";
import type { ThreadState } from "./session_types";
import type { ConfigCheck } from "./config_check";
import { draftPersistence } from "./drafts";
import { emitOpeningHeader } from "./session_open_test_fixture";
import { isHistoryReadFailure } from "./session_recovery";

let sequence = 0;
function event(s: ThreadState, check: ConfigCheck) {
  (
    threads as unknown as {
      applyChannelEvent(key: string, event: unknown): void;
    }
  ).applyChannelEvent(s.key, { kind: "configCheck", check });
}
function fixture() {
  const id = `receipt-before-pull-${sequence++}`;
  const s = threads.markOpenFailed(
    `ordering:/fixture:${id}`,
    "ordering",
    "/fixture",
    id,
    "fixture",
  );
  s.openError = null;
  s.connectionId = `connection-${id}`;
  s.configOptions = [
    {
      id: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: "a",
      options: [{ value: "b", name: "B" }],
    },
  ];
  const options = s.configOptions.map((option) => ({
    ...option,
    currentValue: "b",
  }));
  const check: ConfigCheck = {
    status: "ready",
    issues: [],
    protectedIds: ["model"],
    current: {
      choices: [{ id: "model", category: "model", type: "select", value: "b" }],
    },
  };
  event(s, { ...check, status: "record_failed" });
  h.invoke.mockImplementation(async (command) => {
    if (command === "session_confirm_config")
      return {
        ...check,
        configuration: {
          configOptions: options,
          configOptionsModern: true,
          configCheck: check,
          service: null,
          permissionConfigId: null,
          permissionState: "ready",
        },
      };
    return command === "settings_get" ? null : [];
  });
  return { s, check, options };
}

beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  h.invoke.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it("accepts the matching complete RPC before the queued ready body is pulled", async () => {
  const { s, check, options } = fixture();
  await threads.confirmConfig(s.key);
  expect(s.configOptions).toEqual(options);
  expect(s.configCheck).toEqual(check);
  expect(s.queuePaused).toBeNull();
  expect(s.configError).toBeNull();
  event(s, check);
  expect(s.configOptions).toEqual(options);
  expect(s.configError).toBeNull();
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("requires the original connection for a missing model and preserves paused work", async () => {
  const { s, check } = fixture();
  s.resumed = true;
  s.permissionState = "ready";
  s.queued = [[{ type: "text", text: "keep paused" }]];
  s.historicalOutcomeUnknown = true;
  event(s, {
    ...check,
    status: "confirmation_required",
    issues: [
      {
        id: "model",
        category: "model",
        reason: "unrecorded",
        expected: null,
        current: "b",
      },
    ],
  });
  await threads.confirmConfig(s.key);
  expect(h.invoke).not.toHaveBeenCalledWith(
    "session_confirm_config",
    expect.anything(),
  );
  expect(s.modelDrift).toBe(true);

  s.historicalOutcomeUnknown = false;
  await threads.confirmConfig(s.key);
  expect(h.invoke).toHaveBeenCalledWith(
    "session_confirm_config",
    expect.objectContaining({
      connectionId: s.connectionId,
      displayed: check.current,
    }),
  );
  expect(s.modelDrift).toBe(false);
  expect(s.queued).toEqual([[{ type: "text", text: "keep paused" }]]);
  expect(s.queuePaused).toBe("unavailable");
  expect(h.invoke).not.toHaveBeenCalledWith(
    "session_prompt",
    expect.anything(),
  );
});

it("accepts a saved protected ID whose current display category has changed", async () => {
  const { s, check, options } = fixture();
  // The real guard retains a saved ID's role; current categories describe UX.
  // Both complete checks still identify the same protected ID/type/value.
  options[0].category = "_custom";
  await threads.confirmConfig(s.key);
  expect(s.configOptions).toEqual(options);
  expect(s.configCheck).toEqual(check);
  expect(s.configError).toBeNull();
  expect(s.queuePaused).toBeNull();
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("does not write an old confirmation error onto the same view after failed-history reconnect", async () => {
  const { s, check, options } = fixture();
  const originalOptions = structuredClone(s.configOptions);
  const originalCheck = s.configCheck;
  const invoke = h.invoke.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_confirm_config")
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (command === "agent_work_get") return { cwd: args.cwd };
    if (command === "session_open") {
      const result = {
        cwd: args.cwd,
        nativeSessionId: args.nativeSessionId,
        connectionId: "replacement-connection",
        resumed: true,
        service: null,
        serviceContext: "replacement-source-context",
        configOptions: options,
        configCheck: check,
        permissionState: "ready",
        warnings: [],
      };
      emitOpeningHeader(args, result);
      args.channel.onmessage({
        kind: "session_history_complete",
        openToken: args.openToken,
      });
      return result;
    }
    return invoke(command, args);
  });
  const pending = threads.confirmConfig(s.key);
  expect(s.configuring).toBe(true);
  channelEvent(s.key, { kind: "connectionLost" });
  const failure = await threads
    .open({
      agentId: s.agentId,
      cwd: s.cwd,
      nativeSessionId: s.nativeSessionId,
    })
    .catch((error: unknown) => error);
  expect(isHistoryReadFailure(failure), String(failure)).toBe(true);
  expect(threads.thread(s.key)).toBe(s);
  expect(s.connectionId).toBe("replacement-connection");
  expect(s.serviceContext).toBe("replacement-source-context");
  expect(s.historyUnavailable?.reason).toBe("empty");
  expect(s.configuring).toBe(true);
  expect(s.configError).toBeNull();
  const newFailure = s.openError;
  finish({
    ...check,
    configuration: {
      configOptions: options,
      configOptionsModern: true,
      configCheck: check,
      service: null,
      permissionConfigId: null,
      permissionState: "ready",
    },
  });
  await pending;
  expect(s.configError).toBeNull();
  expect(s.configuring).toBe(false);
  expect(s.configOptions).toEqual(originalOptions);
  expect(s.configCheck).toBe(originalCheck);
  expect(s.openError).toBe(newFailure);
  expect(s.connectionId).toBe("replacement-connection");
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("keeps a later pulled difference authoritative while sidebar refresh is pending", async () => {
  const { s, check, options } = fixture();
  const invoke = h.invoke.getMockImplementation()!;
  let refresh!: () => void;
  h.invoke.mockImplementation((command, ...args) =>
    command === "session_index_list"
      ? new Promise((resolve) => {
          refresh = () => resolve([]);
        })
      : invoke(command, ...args),
  );
  const pending = threads.confirmConfig(s.key);
  await vi.waitFor(() => expect(s.configOptions).toEqual(options));
  const changed: ConfigCheck = {
    ...check,
    status: "blocked",
    issues: [
      { category: "model", reason: "changed", expected: "b", current: "c" },
    ],
    current: {
      choices: [{ id: "model", category: "model", type: "select", value: "c" }],
    },
  };
  event(s, changed);
  refresh();
  await pending;
  expect(s.configCheck).toEqual(changed);
  expect(s.modelDrift).toBe(true);
  expect(s.queuePaused).toBe("unavailable");
  expect(s.configOptions).toEqual(options);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

// These two existing regressions moved here because adding the complete wire
// receipt would take sessions.regression.test.ts over the 1,500-line limit.
function channelEvent(key: string, value: unknown) {
  (
    threads as unknown as {
      applyChannelEvent(key: string, event: unknown): void;
    }
  ).applyChannelEvent(key, value);
}
function regressionSeed(id: string) {
  const s = threads.markOpenFailed(
    `ordering:/fixture:${id}`,
    "ordering",
    "/fixture",
    id,
    "fixture",
  );
  s.openError = null;
  s.connectionId = `connection-${id}`;
  s.configCheck = { status: "ready", issues: [], current: { choices: [] } };
  return s;
}

it("uses backend reasoning protection and never drains a queue on confirmation", async () => {
  const s = regressionSeed("reasoning-confirm");
  s.identity = "established";
  s.queued = [[{ type: "text", text: "keep paused" }]];
  const current = {
    model: { id: "model", category: "model", value: "m" },
    thoughtLevel: { id: "effort", category: "thought_level", value: "high" },
  };
  s.configOptions = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "m",
      options: [],
    },
    {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [],
    },
  ];
  channelEvent(s.key, {
    kind: "configCheck",
    check: {
      status: "confirmation_required",
      issues: [
        {
          category: "thought_level",
          reason: "unrecorded",
          expected: null,
          current: "high",
        },
      ],
      current,
    },
  });
  expect(s.modelDrift).toBe(true);
  await threads.send(s.key, [{ type: "text", text: "blocked" }]);
  expect(h.invoke.mock.calls.some(([cmd]) => cmd === "session_prompt")).toBe(
    false,
  );
  h.invoke.mockImplementation(async (cmd: string) => {
    if (cmd !== "session_confirm_config") return [];
    const check = { status: "ready", issues: [], current };
    channelEvent(s.key, { kind: "configCheck", check });
    return {
      ...check,
      configuration: {
        configOptions: s.configOptions,
        configOptionsModern: true,
        configCheck: check,
        service: null,
        permissionConfigId: null,
        permissionState: s.permissionState,
      },
    };
  });
  await threads.confirmConfig(s.key);
  expect(h.invoke).toHaveBeenCalledWith(
    "session_confirm_config",
    expect.objectContaining({ displayed: current }),
  );
  expect(s.modelDrift).toBe(false);
  expect(s.queuePaused).toBe("unavailable");
  expect(s.queued[0][0]).toMatchObject({ text: "keep paused" });
  expect(h.invoke.mock.calls.some(([cmd]) => cmd === "session_prompt")).toBe(
    false,
  );
});

it("does not replace a newer guard notification with an older confirmation reply", async () => {
  const s = regressionSeed("confirm-race");
  channelEvent(s.key, {
    kind: "configCheck",
    check: {
      status: "confirmation_required",
      issues: [],
      current: { sample: "high" },
    },
  });
  h.invoke.mockImplementation(async (cmd: string) => {
    if (cmd !== "session_confirm_config") return [];
    channelEvent(s.key, {
      kind: "configCheck",
      check: { status: "ready", issues: [], current: { sample: "high" } },
    });
    channelEvent(s.key, {
      kind: "configCheck",
      check: {
        status: "blocked",
        issues: [
          {
            category: "thought_level",
            reason: "changed",
            expected: "high",
            current: "low",
          },
        ],
        current: { sample: "low" },
      },
    });
    const check = { status: "ready", issues: [], current: { sample: "high" } };
    return {
      ...check,
      configuration: {
        configOptions: s.configOptions,
        configOptionsModern: true,
        configCheck: check,
        service: null,
        permissionConfigId: null,
        permissionState: s.permissionState,
      },
    };
  });
  await threads.confirmConfig(s.key);
  expect(s.modelDrift).toBe(true);
  expect(s.configCheck?.issues[0].current).toBe("low");
});
