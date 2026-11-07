import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, type ThreadState } from "./sessions";
import { composerDrafts, draftPersistence } from "./drafts";
import { freshThreadState, normalizeConfigOptions } from "./session_projection";
import { STRINGS } from "./strings";
import { restoreSavedConfiguration } from "./saved_configuration_restore";
import {
  configurationConfirmationNotice,
  isConfigurationRestoreNotice,
} from "./configuration_restore_feedback";
import { configChangeBusy, configChangeBusyReason } from "./protected_config";
import { authenticationActivity } from "./authentication";
import { applyConfigCheck, ownsConfigurationPause } from "./config_check";
import { sendNewConversation } from "./new_conversation";
import { rememberPendingConversation } from "./pending_conversation";
import { pauseQueue } from "./queue";

let state: ThreadState;
let serial = 0;
const saved = { model: "kept", thought_level: "medium" };
const check = () => ({
  status: "ready" as const,
  issues: [],
  current: {
    choices: Object.entries(saved).map(([id, value]) => ({
      id,
      category: id,
      type: "select",
      value,
    })),
  },
});
function event(value: unknown) {
  (
    threads as unknown as {
      applyChannelEvent(key: string, value: unknown, live: boolean): void;
    }
  ).applyChannelEvent(state.key, value, true);
}
function calls() {
  return h.invoke.mock.calls.filter(
    ([name]) => name === "session_confirm_config",
  );
}
beforeEach(() => {
  h.invoke
    .mockReset()
    .mockImplementation(async (name) => (name === "settings_get" ? null : []));
  state = threads.markOpenFailed(
    `saved-baseline-${++serial}`,
    "chosen",
    "/controlled",
    `native-${serial}`,
    "",
  );
  state.identity = "draft";
  state.openError = null;
  state.connectionId = "owned-connection";
  state.configOptions = normalizeConfigOptions(
    Object.entries(saved).map(([id, value]) => ({
      id,
      category: id,
      name: id,
      type: "select",
      currentValue: value,
      options: [{ value, name: value }],
    })),
  );
  state.configCheck = check();
});
afterEach(async () => {
  await draftPersistence.flush();
});

it("sends exactly one first prompt after strict confirmation of a fresh draft's changed model", async () => {
  const model = "explicit-fresh-model";
  const selection = { ...saved, model };
  const ready = {
    ...check(),
    current: {
      choices: check().current.choices.map((choice) =>
        choice.id === "model" ? { ...choice, value: model } : choice,
      ),
    },
  };
  state.workEnabled = true;
  state.configOptions[0].options.push({ value: model, name: "Explicit model" });
  applyConfigCheck(state, { ...check(), status: "blocked" });
  applyConfigCheck(state, check());
  expect(state.queuePaused).toBe("unavailable");
  expect(ownsConfigurationPause(state)).toBe(true);
  h.invoke.mockImplementation(async (name, args) => {
    if (name === "session_set_config")
      return {
        configOptions: state.configOptions.map((option) =>
          option.id === "model" ? { ...option, currentValue: model } : option,
        ),
        configOptionsModern: true,
        configCheck: ready,
        permissionState: "ready",
        service: null,
      };
    if (name === "session_confirm_config") return ready;
    if (name === "session_prompt") {
      args.admissionChannel.onmessage({ receiptId: 83, phase: "offered" });
      return { status: "accepted" };
    }
    return name === "settings_get" ? null : [];
  });
  await threads.setConfig(state.key, "model", model);
  expect(state.queuePaused).toBe("unavailable");
  await threads.confirmRestoredConfig(state.key, selection);
  expect(state.queuePaused).toBeNull();
  expect(ownsConfigurationPause(state)).toBe(false);
  const blocks = [{ type: "text" as const, text: "Owned first input" }];
  composerDrafts.update("new", () => ({
    text: blocks[0].text,
    attachments: [],
    sendPending: true,
  }));
  const attempt = await rememberPendingConversation(
    "new",
    composerDrafts.read("new"),
    state,
  );
  try {
    const outcome = await sendNewConversation(state.key, blocks, attempt).catch(
      (error: unknown) => error,
    );
    expect.soft(outcome).toBeUndefined();
    expect
      .soft(h.invoke.mock.calls.filter(([name]) => name === "session_prompt"))
      .toHaveLength(1);
    expect.soft(state.identity).toBe("established");
    expect(state.queued).toEqual([]);
    expect(calls()).toHaveLength(1);
  } finally {
    composerDrafts.clear("new");
  }
});

it.each([
  "established",
  "resumed",
  "history",
  "earlier-round",
  "queued",
  "manual",
  "work-disabled",
  "unknown-pause",
] as const)(
  "keeps the %s pause after strict confirmation",
  async (condition) => {
    applyConfigCheck(state, { ...check(), status: "blocked" });
    applyConfigCheck(state, check());
    if (condition === "established") state.identity = "established";
    if (condition === "resumed") state.resumed = true;
    if (condition === "history")
      event({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Owned prior history" },
        },
      });
    if (condition === "earlier-round") state.roundItemBase = 1;
    if (condition === "queued")
      state.queued = [[{ type: "text", text: "Existing queued input" }]];
    if (condition === "manual") pauseQueue(state, "unavailable");
    if (condition === "work-disabled") pauseQueue(state, "work_disabled");
    if (condition === "unknown-pause") pauseQueue(state, "uncertain");
    const pause = state.queuePaused;
    const queued = state.queued.slice();
    h.invoke.mockImplementation(async (name) =>
      name === "session_confirm_config"
        ? check()
        : name === "settings_get"
          ? null
          : [],
    );
    await expect(
      threads.confirmRestoredConfig(state.key, saved),
    ).resolves.toBeUndefined();
    expect(state.queuePaused).toBe(pause);
    expect(state.queued).toEqual(queued);
    expect(calls()).toHaveLength(1);
    expect(
      h.invoke.mock.calls.filter(([name]) => name === "session_prompt"),
    ).toHaveLength(0);
  },
);

it.each(["rejected", "not-ready", "owner-changed", "busy-after"] as const)(
  "keeps a fresh draft's configuration pause when confirmation is %s",
  async (failure) => {
    applyConfigCheck(state, { ...check(), status: "blocked" });
    applyConfigCheck(state, check());
    h.invoke.mockImplementation(async (name) => {
      if (name !== "session_confirm_config")
        return name === "settings_get" ? null : [];
      if (failure === "rejected")
        throw "FARFOLD_RESTORE_CONFIRM_GUARD_NOT_READY";
      if (failure === "not-ready") return { ...check(), status: "blocked" };
      if (failure === "owner-changed") state.connectionId = "replaced-owner";
      if (failure === "busy-after") state.running = true;
      return check();
    });
    await expect(
      threads.confirmRestoredConfig(state.key, saved),
    ).rejects.toThrow(STRINGS.repair.confirmConfigFailed);
    expect(state.queuePaused).toBe("unavailable");
    expect(ownsConfigurationPause(state)).toBe(true);
    expect(calls()).toHaveLength(1);
    expect(
      h.invoke.mock.calls.filter(([name]) => name === "session_prompt"),
    ).toHaveLength(0);
  },
);

it("uses the real strict invoke bridge with the saved map and ordered ready event, without manual refresh or a setter", async () => {
  h.invoke.mockImplementation(async (name) => {
    if (name !== "session_confirm_config")
      return name === "settings_get" ? null : [];
    const ready = check();
    event({ kind: "configCheck", check: ready });
    return ready;
  });
  await expect(
    threads.confirmRestoredConfig(state.key, saved),
  ).resolves.toBeUndefined();
  expect(calls()).toHaveLength(1);
  expect(calls()[0][1]).toMatchObject({
    agentId: "chosen",
    cwd: "/controlled",
    sessionId: state.nativeSessionId,
    displayed: check().current,
    restoreSelection: saved,
  });
  expect(state.configuring).toBe(false);
  expect(state.configError).toBeNull();
  expect(
    h.invoke.mock.calls.filter(([name]) =>
      [
        "session_index_list",
        "session_touch",
        "session_set_config",
        "session_prompt",
      ].includes(name),
    ),
  ).toHaveLength(0);
});

it.each([
  "transport",
  "nonready",
  "later-different-current",
  "later-drift",
] as const)("throws and never publishes stale ready for %s", async (reason) => {
  h.invoke.mockImplementation(async (name) => {
    if (name !== "session_confirm_config")
      return name === "settings_get" ? null : [];
    if (reason === "transport") throw new Error("controlled failure");
    if (reason === "nonready") return { ...check(), status: "record_failed" };
    if (reason === "later-different-current")
      event({
        kind: "configCheck",
        check: { ...check(), current: { changed: true } },
      });
    if (reason === "later-drift") {
      event({ kind: "configCheck", check: check() });
      event({
        kind: "configCheck",
        check: { ...check(), status: "blocked", current: { changed: true } },
      });
    }
    return check();
  });
  const failure = await threads
    .confirmRestoredConfig(state.key, saved)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(STRINGS.repair.confirmConfigFailed);
  const reasons = {
    transport: "invoke-rejected",
    nonready: "reply-not-ready",
    "later-different-current": "snapshot-changed",
    "later-drift": "state-not-ready",
  } as const;
  expect(configurationConfirmationNotice(failure)?.detail).toBe(
    STRINGS.repair.confirmConfigReasons[reasons[reason]],
  );
  expect(
    isConfigurationRestoreNotice(configurationConfirmationNotice(failure)),
  ).toBe(false);
  expect(calls()).toHaveLength(1);
  expect(state.configError).toBe(STRINGS.repair.confirmConfigFailed);
  expect(state.configuring).toBe(false);
  if (reason === "later-drift") {
    expect(state.configCheck?.status).toBe("blocked");
    expect(state.modelDrift).toBe(true);
  }
});

it.each(Object.entries(STRINGS.repair.confirmConfigNativeReasons))(
  "classifies only the exact confirmation rejection %s without changing protection",
  async (code, detail) => {
    h.invoke.mockImplementation(async (name) => {
      if (name === "session_confirm_config") throw code;
      return name === "settings_get" ? null : [];
    });
    const failure = await threads
      .confirmRestoredConfig(state.key, saved)
      .catch((error: unknown) => error);
    const notice = configurationConfirmationNotice(failure);
    expect(notice).toEqual({
      message: STRINGS.repair.confirmConfigFailed,
      detail,
    });
    expect(isConfigurationRestoreNotice(notice)).toBe(false);
    expect(calls()).toHaveLength(1);
    expect(state.configuring).toBe(false);
    expect(state.configError).toBe(STRINGS.repair.confirmConfigFailed);
    expect(state.configCheck).toEqual(check());
  },
);

it.each([
  "unknown",
  "before",
  "after",
  "space",
  "wrapped",
  "object",
  "coercion",
] as const)(
  "hides unknown or decorated confirmation rejection payloads: %s",
  async (kind) => {
    const privateCanary = "PRIVATE_ACCOUNT_MODEL_DIRECTORY_ERROR_CANARY";
    const code = "FARFOLD_RESTORE_CONFIRM_GUARD_NOT_READY";
    const reason: unknown =
      kind === "before"
        ? `${privateCanary}${code}`
        : kind === "after"
          ? `${code}:${privateCanary}`
          : kind === "space"
            ? `${code} `
            : kind === "wrapped"
              ? new Error(code)
              : kind === "object"
                ? { code, message: privateCanary }
                : kind === "coercion"
                  ? {
                      toString() {
                        throw new Error(privateCanary);
                      },
                    }
                  : `FARFOLD_RESTORE_CONFIRM_${privateCanary}`;
    h.invoke.mockImplementation(async (name) => {
      if (name === "session_confirm_config") throw reason;
      return name === "settings_get" ? null : [];
    });
    const failure = await threads
      .confirmRestoredConfig(state.key, saved)
      .catch((error: unknown) => error);
    const notice = configurationConfirmationNotice(failure);
    expect(notice).toEqual({
      message: STRINGS.repair.confirmConfigFailed,
      detail: STRINGS.repair.confirmConfigReasons["invoke-rejected"],
    });
    expect(JSON.stringify(notice)).not.toContain(privateCanary);
    expect(JSON.stringify(notice)).not.toContain(code);
    expect(isConfigurationRestoreNotice(notice)).toBe(false);
    expect(calls()).toHaveLength(1);
    expect(state.configCheck).toEqual(check());
  },
);

it.each(["selection", "owner", "displayed"] as const)(
  "separates %s preparation failure from an invoked rejection without exposing its cause",
  async (kind) => {
    const privateCanary = "PRIVATE_PREPARATION_ERROR_CANARY";
    const originalClone = globalThis.structuredClone.bind(globalThis);
    const target =
      kind === "selection"
        ? saved
        : kind === "owner"
          ? (state.service ?? null)
          : state.configCheck!.current;
    const clone = vi
      .spyOn(globalThis, "structuredClone")
      .mockImplementation((value) => {
        if (value === target) throw new Error(privateCanary);
        return originalClone(value);
      });
    let failure: unknown;
    try {
      failure = await threads
        .confirmRestoredConfig(state.key, saved)
        .catch((error: unknown) => error);
    } finally {
      clone.mockRestore();
    }
    const notice = configurationConfirmationNotice(failure);
    expect(notice).toEqual({
      message: STRINGS.repair.confirmConfigFailed,
      detail: STRINGS.repair.confirmConfigReasons["prepare-failed"],
    });
    expect(JSON.stringify(notice)).not.toContain(privateCanary);
    expect(isConfigurationRestoreNotice(notice)).toBe(false);
    expect(calls()).toHaveLength(0);
    expect(state.configuring).toBe(false);
  },
);

it.each(["missing", "busy", "mismatched-saved", "empty-intent"])(
  "rejects %s before invoking confirmation",
  async (reason) => {
    if (reason === "missing") state.configCheck = null;
    if (reason === "busy") state.running = true;
    const selection =
      reason === "mismatched-saved"
        ? { ...saved, model: "other" }
        : reason === "empty-intent"
          ? {}
          : saved;
    await expect(
      threads.confirmRestoredConfig(state.key, selection),
    ).rejects.toThrow();
    expect(calls()).toHaveLength(0);
  },
);

it.each(["owner", "source", "connection", "readback"])(
  "rejects a late reply after %s changed without overwriting the current state",
  async (reason) => {
    let replacement: ThreadState | null = null;
    h.invoke.mockImplementation(async (name) => {
      if (name !== "session_confirm_config")
        return name === "settings_get" ? null : [];
      event({ kind: "configCheck", check: check() });
      if (reason === "owner") {
        replacement = freshThreadState(
          state.key,
          "chosen",
          "/controlled",
          "replacement",
        );
        (
          threads as unknown as { threads: Map<string, ThreadState> }
        ).threads.set(state.key, replacement);
      } else if (reason === "source") state.serviceContext = "changed-source";
      else if (reason === "connection")
        state.connectionId = "changed-connection";
      else state.configOptions[0].currentValue = "changed";
      return check();
    });
    await expect(
      threads.confirmRestoredConfig(state.key, saved),
    ).rejects.toThrow();
    expect(calls()).toHaveLength(1);
    if (replacement) {
      expect(threads.thread(state.key)).toBe(replacement);
      expect((replacement as ThreadState).configError).toBeNull();
      expect((replacement as ThreadState).configuring).toBe(false);
    }
  },
);

it("accepts an explicit thought-only original intention and leaves the other current model as inherited", async () => {
  h.invoke.mockImplementation(async (name) => {
    if (name !== "session_confirm_config")
      return name === "settings_get" ? null : [];
    const ready = check();
    event({ kind: "configCheck", check: ready });
    return ready;
  });
  await expect(
    threads.confirmRestoredConfig(state.key, { thought_level: "medium" }),
  ).resolves.toBeUndefined();
  expect(calls()[0][1]).toMatchObject({
    restoreSelection: { thought_level: "medium" },
  });
  expect(calls()[0][1].restoreSelection).not.toHaveProperty("model");
});
it("rejects a late ready reply if work becomes unknown while confirmation is pending", async () => {
  h.invoke.mockImplementation(async (name) => {
    if (name !== "session_confirm_config") return [];
    event({ kind: "configCheck", check: check() });
    state.uncertainPrompt = [{ type: "text", text: "controlled pending work" }];
    state.queuePaused = "uncertain";
    return check();
  });
  await expect(
    threads.confirmRestoredConfig(state.key, saved),
  ).rejects.toThrow();
  expect(state.uncertainPrompt).toEqual([
    { type: "text", text: "controlled pending work" },
  ]);
  expect(state.queuePaused).toBe("uncertain");
  expect(calls()).toHaveLength(1);
});

it("accepts the same-owner native ready acknowledgement before its queued channel event without applying the reply", async () => {
  const original = state.configCheck;
  const originalOptions = state.configOptions;
  const originalChoiceValues = state.configOptions.map(
    (item) => item.currentValue,
  );
  const ready = check();
  h.invoke.mockImplementation(async (name) =>
    name === "session_confirm_config" ? ready : [],
  );
  await expect(
    threads.confirmRestoredConfig(state.key, saved),
  ).resolves.toBeUndefined();
  expect(calls()).toHaveLength(1);
  expect(state.configCheck).toBe(original);
  expect(state.configCheck).not.toBe(ready);
  expect(state.configOptions).toBe(originalOptions);
  expect(state.configOptions.map((item) => item.currentValue)).toEqual(
    originalChoiceValues,
  );
  expect(state.configuring).toBe(false);
  expect(
    h.invoke.mock.calls.filter(([name]) => name !== "session_confirm_config"),
  ).toHaveLength(0);
  event({
    kind: "configCheck",
    check: { ...check(), status: "blocked", current: { changed: true } },
  });
  expect(state.configCheck?.status).toBe("blocked");
  expect(state.modelDrift).toBe(true);
});

it.each(["ordered", "not-delivered", "rejected", "before-busy"])(
  "restores the public model and thought categories through the real setter and %s final confirmation",
  async (delivery) => {
    const model = "chosen-free-model";
    let options = [
      {
        id: "provider",
        name: "Provider",
        type: "select",
        currentValue: "chosen-provider",
        options: [{ value: "chosen-provider", name: "Chosen provider" }],
      },
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "auto",
        options: [{ value: "auto", name: "Auto" }],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "initial-model",
        options: [
          { value: "initial-model", name: "Initial" },
          { value: model, name: "Chosen" },
        ],
      },
      {
        id: "thinking_effort",
        name: "Thinking effort",
        category: "thought_level",
        type: "select",
        currentValue: "off",
        options: [{ value: "off", name: "Off" }],
      },
    ];
    const ready = () => ({
      status: "ready" as const,
      issues: [],
      current: {
        choices: options
          .filter((option) =>
            ["model", "thought_level"].includes(option.category ?? ""),
          )
          .map((option) => ({
            id: option.id,
            category: option.category,
            type: "select",
            value: option.currentValue,
          })),
      },
      protectedIds: ["model", "thinking_effort"],
    });
    state.configOptions = normalizeConfigOptions(options);
    state.configCheck = ready();
    const selection = { model, thinking_effort: "off" };
    const privateCanary = "PRIVATE_KEY_ACCOUNT_DIRECTORY_MODEL_CANARY";
    h.invoke.mockImplementation(async (name, input) => {
      if (name === "session_set_config") {
        expect(input).toMatchObject({ configId: "model", value: model });
        options = options.map((option) =>
          option.id === "model" ? { ...option, currentValue: model } : option,
        );
        event({
          kind: "configOptions",
          options: structuredClone(options),
          modern: true,
        });
        event({ kind: "configCheck", check: ready() });
        return {
          configOptions: structuredClone(options),
          configOptionsModern: true,
          configCheck: ready(),
          service: null,
          permissionConfigId: null,
          permissionState: "ready",
          permissionEffect: null,
        };
      }
      if (name === "session_confirm_config") {
        expect(input).toMatchObject({
          displayed: ready().current,
          restoreSelection: selection,
        });
        if (delivery === "rejected") throw new Error(privateCanary);
        if (delivery === "ordered")
          event({ kind: "configCheck", check: ready() });
        return ready();
      }
      return name === "settings_get" ? null : [];
    });
    const restore = restoreSavedConfiguration(state, selection, {
      current: () => threads.thread(state.key) === state,
      validateService: async () => {
        if (delivery === "before-busy") state.connectionOutcomeUnknown = true;
      },
      set: (id, value) => threads.setConfig(state.key, id, value),
      confirm: (value) => threads.confirmRestoredConfig(state.key, value),
    });
    if (["rejected", "before-busy"].includes(delivery)) {
      const failure = await restore.catch((error: unknown) => error);
      const notice = configurationConfirmationNotice(failure);
      expect(notice).toEqual({
        message: STRINGS.repair.confirmConfigFailed,
        detail:
          delivery === "rejected"
            ? STRINGS.repair.confirmConfigReasons["invoke-rejected"]
            : `${STRINGS.repair.confirmConfigReasons["busy-before"]}：${STRINGS.repair.confirmConfigBusyReasons.connectionOutcomeUnknown}。`,
      });
      expect(isConfigurationRestoreNotice(notice)).toBe(false);
      expect(JSON.stringify(notice)).not.toContain(privateCanary);
    } else await expect(restore).resolves.toBe(true);
    expect(
      h.invoke.mock.calls.filter(([name]) => name === "session_set_config"),
    ).toHaveLength(1);
    expect(calls()).toHaveLength(delivery === "before-busy" ? 0 : 1);
    expect(
      h.invoke.mock.calls.filter(([name]) => name === "session_prompt"),
    ).toHaveLength(0);
    expect(selection).toEqual({ model, thinking_effort: "off" });
  },
);

it.each([
  "running",
  "submitting",
  "configuring",
  "reconnecting",
  "stopping",
  "stopUnconfirmed",
  "connectionLost",
  "connectionOutcomeUnknown",
  "sourceError",
  "unrecoverable",
] as const)(
  "keeps %s blocked and explains that exact busy reason before invoking",
  async (reason) => {
    expect(configChangeBusy(state)).toBe(false);
    state[reason] = true;
    const failure = await threads
      .confirmRestoredConfig(state.key, saved)
      .catch((error: unknown) => error);
    expect(configChangeBusy(state)).toBe(true);
    expect(configChangeBusyReason(state)).toBe(reason);
    expect(configurationConfirmationNotice(failure)?.detail).toBe(
      `${STRINGS.repair.confirmConfigReasons["busy-before"]}：${STRINGS.repair.confirmConfigBusyReasons[reason]}。`,
    );
    expect(calls()).toHaveLength(0);
  },
);

it.each([
  "uncertainPrompt",
  "openError",
  "historyUnavailable",
  "activeWork",
  "pendingRequests",
] as const)(
  "explains %s without exposing its private values",
  async (reason) => {
    const privateCanary = "PRIVATE_ACCOUNT_PROMPT_TOOL_DIRECTORY_CANARY";
    if (reason === "uncertainPrompt")
      state.uncertainPrompt = [{ type: "text", text: privateCanary }];
    if (reason === "openError") state.openError = privateCanary;
    if (reason === "historyUnavailable")
      state.historyUnavailable = { reason: "unreadable", sourceKnown: true };
    if (reason === "activeWork") state.activeToolCallIds = [privateCanary];
    if (reason === "pendingRequests")
      state.browserReadRequestId = privateCanary;
    const failure = await threads
      .confirmRestoredConfig(state.key, saved)
      .catch((error: unknown) => error);
    expect(configChangeBusyReason(state)).toBe(reason);
    const notice = configurationConfirmationNotice(failure);
    expect(notice?.detail).toContain(
      STRINGS.repair.confirmConfigBusyReasons[reason],
    );
    expect(JSON.stringify(notice)).not.toContain(privateCanary);
    expect(isConfigurationRestoreNotice(notice)).toBe(false);
    expect(calls()).toHaveLength(0);
  },
);

it("short-circuits on running before reading later state, authentication or work", () => {
  const earlyBusy = new Proxy(state, {
    get(_target, property) {
      if (property === "running") return true;
      throw new Error(`unexpected later read: ${String(property)}`);
    },
  });
  expect(configChangeBusyReason(earlyBusy)).toBe("running");
  expect(configChangeBusy(earlyBusy)).toBe(true);
});

it("keeps an active login blocked using only the fixed busy reason", async () => {
  const activity = authenticationActivity(state.agentId);
  activity.begin(
    { agentId: state.agentId, cwd: "/private-controlled" },
    {
      kind: "authentication",
      methodId: "private-method",
      title: "private-title",
      completion: "return_and_verify",
    },
    "private-attempt",
  );
  try {
    const failure = await threads
      .confirmRestoredConfig(state.key, saved)
      .catch((error: unknown) => error);
    expect(configChangeBusyReason(state)).toBe("authentication");
    expect(configurationConfirmationNotice(failure)?.detail).toContain(
      STRINGS.repair.confirmConfigBusyReasons.authentication,
    );
    expect(
      JSON.stringify(configurationConfirmationNotice(failure)),
    ).not.toContain("private-");
    expect(calls()).toHaveLength(0);
  } finally {
    await activity.protocol({
      run: async () => {
        throw new Error("controlled completion");
      },
      cancel: async () => {},
      reconnect: async () => {},
    });
  }
});
