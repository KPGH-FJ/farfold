import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emitOpeningHeader } from "./session_open_test_fixture";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, storedModelValue } from "./sessions";
import { AgentPreparation } from "./agent_preparation";
import { draftPersistence } from "./drafts";
import { archiveActivity } from "./archive_activity";
import type { ConfigOptionView, ThreadState } from "./session_types";
import { STRINGS } from "./strings";
import { authenticationActivity } from "./authentication";

const values = {
  model: "original",
  inference_speed: "standard",
  reasoning_effort: "medium",
  thinking_budget: "0",
};
const choices = () =>
  Object.entries(values).map(([id, value]) => ({
    id,
    category:
      id === "model" || id === "inference_speed" ? "model" : "thought_level",
    type: "select",
    value,
  }));
const options = (): ConfigOptionView[] =>
  choices().map(({ id, category, type, value }) => ({
    id,
    category,
    type,
    name: id,
    currentValue: value,
    options: [value, "other"].map((v) => ({ value: v, name: v })),
  }));
function seed(id: string) {
  const s = threads.markOpenFailed(
    `categories:/p:${id}`,
    "categories",
    "/p",
    id,
    "fixture",
  );
  s.openError = null;
  s.configOptions = options();
  event(s, {
    status: "ready",
    issues: [],
    protectedIds: Object.keys(values),
    current: { choices: choices() },
  });
  return s;
}
function confirmed(s: ThreadState, updated: ConfigOptionView[]) {
  return {
    configOptions: updated,
    configCheck: {
      status: "ready",
      issues: [],
      protectedIds: Object.keys(values),
      current: {
        choices: updated.map(({ id, category, type, currentValue }) => ({
          id,
          category,
          type,
          value: currentValue,
        })),
      },
    },
    permissionConfigId: s.permissionConfigId ?? null,
    permissionState: s.permissionState,
    service: s.service ?? null,
  };
}
function reply(s: ThreadState, id: string, value: unknown) {
  const result = confirmed(
    s,
    s.configOptions.map((option) => ({
      ...option,
      currentValue: option.id === id ? value : option.currentValue,
    })),
  );
  event(s, result.configCheck);
  return result;
}
function changed(s: ThreadState, updated: ConfigOptionView[]) {
  const result = confirmed(s, updated);
  event(s, {
    ...result.configCheck,
    status: "blocked",
    issues: [
      {
        id: "model",
        category: "model",
        reason: "changed",
        expected: "original",
        current: updated.find((option) => option.id === "model")?.currentValue,
      },
    ],
  });
  return result;
}
function event(s: ThreadState, check: unknown) {
  (
    threads as unknown as {
      applyChannelEvent: (key: string, event: unknown) => void;
    }
  ).applyChannelEvent(s.key, { kind: "configCheck", check });
}
beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.spyOn(archiveActivity, "begin").mockResolvedValue();
  vi.spyOn(archiveActivity, "finish").mockResolvedValue();
  h.invoke.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

it.each(Object.keys(values))(
  "changes declared option %s after an established conversation is idle",
  async (id) => {
    const s = seed(`established-${id}`);
    s.identity = "established";
    h.invoke.mockImplementation(async () => reply(s, id, "other"));
    await threads.setConfig(s.key, id, "other");
    expect(
      s.configOptions.find((option) => option.id === id)?.currentValue,
    ).toBe("other");
    expect(s.identity).toBe("established");
    expect(s.nativeSessionId).toBe(`established-${id}`);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  },
);

it("changes a restored declared option while preserving the existing session", async () => {
  const s = seed("resumed");
  s.resumed = true;
  h.invoke.mockImplementation(async () =>
    confirmed(
      s,
      s.configOptions.map((option) => ({
        ...option,
        currentValue:
          option.id === "inference_speed" ? "other" : option.currentValue,
      })),
    ),
  );
  await threads.setConfig(s.key, "inference_speed", "other");
  expect(s.configOptions[1].currentValue).toBe("other");
  expect(s.resumed).toBe(true);
});

it.each([undefined, "vendor_feature", "mode"])(
  "keeps an original protected ID locked after its current category becomes %s",
  async (category) => {
    const s = seed(`changed-category-${category}`);
    s.identity = "established";
    s.configOptions = [{ ...options()[1], category }];
    event(s, {
      status: "ready",
      issues: [],
      protectedIds: ["inference_speed"],
      current: { choices: choices() },
    });
    await expect(
      threads.setConfig(s.key, "inference_speed", "other"),
    ).rejects.toThrow(STRINGS.repair.configFailed);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(s.configOptions[0].currentValue).toBe("standard");
  },
);

it("does not send a setter for a recorded protected ID missing from the current list", async () => {
  const s = seed("missing-id");
  s.identity = "established";
  s.configOptions = [];
  event(s, {
    status: "blocked",
    issues: [
      {
        id: "thinking_budget",
        category: "thought_level",
        reason: "missing",
        expected: "0",
        current: null,
      },
    ],
    protectedIds: ["thinking_budget"],
    current: { choices: [] },
  });
  await expect(
    threads.setConfig(s.key, "thinking_budget", "other"),
  ).rejects.toThrow(STRINGS.repair.configFailed);
  expect(h.invoke).not.toHaveBeenCalled();
});

it.each(Object.keys(values))(
  "lets a new draft select %s without dropping its other choices",
  async (id) => {
    const s = seed(`draft-${id}`);
    s.identity = "draft";
    h.invoke.mockImplementation(async (command: string, args) => {
      if (command !== "session_set_config") return [];
      return confirmed(
        s,
        s.configOptions.map((option) => ({
          ...option,
          currentValue:
            option.id === args.configId ? args.value : option.currentValue,
        })),
      );
    });
    await threads.setConfig(s.key, id, "other");
    expect(h.invoke).toHaveBeenCalledWith(
      "session_set_config",
      expect.objectContaining({ configId: id, value: "other" }),
    );
    expect(
      Object.fromEntries(s.configOptions.map((o) => [o.id, o.currentValue])),
    ).toEqual({ ...values, [id]: "other" });
    expect(
      h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
    ).toBe(false);
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
] as const)("does not change a model or reasoning while %s", async (field) => {
  const s = seed(`busy-${field}`);
  s[field] = true;
  const original = structuredClone(s.configOptions);
  for (const id of ["model", "reasoning_effort"])
    await expect(threads.setConfig(s.key, id, "other")).rejects.toThrow(
      STRINGS.repair.configFailed,
    );
  expect(s.configOptions).toEqual(original);
  expect(h.invoke).not.toHaveBeenCalled();
});

it("blocks active tools, pending approval and unknown input independently of running", async () => {
  const s = seed("busy-tool");
  s.activeToolCallIds = ["tool"];
  await expect(threads.setConfig(s.key, "model", "other")).rejects.toBeTruthy();
  s.activeToolCallIds = [];
  s.pendingPermissions = [
    {
      requestId: "r",
      status: "pending",
      error: null,
      toolCallId: null,
      title: "Approval",
      kind: "edit",
      locations: [],
      options: [],
      decision: null,
    },
  ];
  await expect(
    threads.setConfig(s.key, "reasoning_effort", "other"),
  ).rejects.toBeTruthy();
  s.pendingPermissions = [];
  s.uncertainPrompt = [{ type: "text", text: "keep unknown" }];
  await expect(threads.setConfig(s.key, "model", "other")).rejects.toBeTruthy();
  expect(h.invoke).not.toHaveBeenCalled();
});

it("publishes a model and its new reasoning choices together only after the saved matching receipt", async () => {
  const s = seed("model-receipt");
  s.items = [
    {
      kind: "agent",
      id: "history",
      text: "keep history",
      streaming: false,
      time: 1,
    },
  ];
  s.queued = [[{ type: "text", text: "keep paused" }]];
  s.queuePaused = "stopped";
  const original = structuredClone(s.configOptions);
  const oldCheck = s.configCheck;
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const setting = threads.setConfig(s.key, "model", "other");
  const updated = original.map((option) => ({
    ...option,
    currentValue:
      option.id === "model" || option.id === "reasoning_effort"
        ? "other"
        : option.currentValue,
    options:
      option.id === "reasoning_effort"
        ? [{ value: "other", name: "New effort" }]
        : option.options,
  }));
  (
    threads as unknown as {
      applyChannelEvent(key: string, event: unknown): void;
    }
  ).applyChannelEvent(s.key, {
    update: { sessionUpdate: "config_option_update", configOptions: updated },
  });
  event(s, {
    status: "ready",
    issues: [],
    protectedIds: Object.keys(values),
    current: { choices: updated },
  });
  expect(s.configOptions).toEqual(original);
  expect(s.configCheck).toBe(oldCheck);
  expect(s.configuring).toBe(true);
  finish(confirmed(s, updated));
  await setting;
  expect(s.configOptions).toEqual(updated);
  expect(s.modelDrift).toBe(false);
  expect(s.nativeSessionId).toBe("model-receipt");
  expect(s.items[0]).toMatchObject({ text: "keep history" });
  expect(s.queued[0][0]).toMatchObject({ text: "keep paused" });
  expect(s.queuePaused).toBe("stopped");
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it.each(["rejected", "mismatched", "unknown"])(
  "keeps confirmed choices after a %s setter outcome",
  async (outcome) => {
    const s = seed(`setter-${outcome}`);
    const original = structuredClone(s.configOptions);
    h.invoke.mockImplementation(async () => {
      (
        threads as unknown as {
          applyChannelEvent(key: string, event: unknown): void;
        }
      ).applyChannelEvent(s.key, {
        update: {
          sessionUpdate: "config_option_update",
          configOptions: original.map((option) => ({
            ...option,
            currentValue: "other",
          })),
        },
      });
      if (outcome === "unknown") {
        event(s, {
          status: "blocked",
          issues: [
            {
              id: "model",
              category: "model",
              reason: "unknown",
              expected: "original",
              current: "other",
            },
          ],
          current: {},
          protectedIds: Object.keys(values),
        });
        throw new Error("unknown result");
      }
      if (outcome === "rejected") throw new Error("rejected");
      event(s, {
        status: "ready",
        issues: [],
        current: {},
        protectedIds: Object.keys(values),
      });
      return confirmed(s, original);
    });
    await expect(
      threads.setConfig(s.key, "model", "other"),
    ).rejects.toBeTruthy();
    expect(s.configOptions).toEqual(original);
    expect(s.configError).toBe(STRINGS.repair.configFailed);
    expect(s.configuring).toBe(false);
    if (outcome === "unknown") {
      expect(s.modelDrift).toBe(true);
      expect(s.queuePaused).toBe("unavailable");
    }
    expect(h.invoke).toHaveBeenCalledTimes(1);
  },
);

it("updates the confirmed API model without changing its service identity", async () => {
  const s = seed("same-source-model");
  s.service = {
    id: "selected-service",
    fingerprint: "same-source",
    model: "original",
  };
  const originalSource = { ...s.service };
  h.invoke.mockImplementation(async () => ({
    ...confirmed(
      s,
      s.configOptions.map((option) => ({
        ...option,
        currentValue: option.id === "model" ? "other" : option.currentValue,
      })),
    ),
    service: { ...originalSource, model: "other" },
  }));
  await threads.setConfig(s.key, "model", "other");
  expect(s.service).toEqual({ ...originalSource, model: "other" });
  expect(s.agentId).toBe("categories");
  expect(s.nativeSessionId).toBe("same-source-model");
});

it("does not let an older saved receipt overwrite a newer unknown check", async () => {
  const s = seed("late-receipt");
  const original = structuredClone(s.configOptions);
  h.invoke.mockImplementation(async () => {
    const result = confirmed(
      s,
      s.configOptions.map((option) => ({
        ...option,
        currentValue: option.id === "model" ? "other" : option.currentValue,
      })),
    );
    event(s, result.configCheck);
    event(s, { ...result.configCheck, status: "blocked" });
    return result;
  });
  await expect(threads.setConfig(s.key, "model", "other")).rejects.toBeTruthy();
  expect(s.configOptions).toEqual(original);
  expect(s.modelDrift).toBe(true);
});

it.each(["unknown", "record_failed"] as const)(
  "does not release a %s check with a saved reply before any ready notification",
  async (outcome) => {
    const s = seed(`first-${outcome}-receipt`);
    const original = structuredClone(s.configOptions);
    h.invoke.mockImplementation(async () => {
      const result = confirmed(
        s,
        original.map((option) => ({
          ...option,
          currentValue: option.id === "model" ? "other" : option.currentValue,
        })),
      );
      event(s, {
        ...result.configCheck,
        status: outcome === "unknown" ? "blocked" : "record_failed",
        issues: [
          {
            id: "model",
            category: "model",
            reason: outcome === "unknown" ? "unknown" : "changed",
            expected: "original",
            current: "other",
          },
        ],
      });
      return result;
    });
    await expect(
      threads.setConfig(s.key, "model", "other"),
    ).rejects.toBeTruthy();
    expect(s.configOptions).toEqual(original);
    expect(s.configCheck?.status).toBe(
      outcome === "unknown" ? "blocked" : "record_failed",
    );
    expect(s.modelDrift).toBe(true);
    expect(s.queuePaused).toBe("unavailable");
  },
);

it("sends the next explicit input once after an intermediate changed check is saved", async () => {
  const s = seed("intermediate-changed");
  s.identity = "established";
  const updated = s.configOptions.map((option) => ({
    ...option,
    currentValue: option.id === "model" ? "other" : option.currentValue,
  }));
  h.invoke.mockImplementation(async (command) => {
    if (command === "session_set_config") return changed(s, updated);
    if (command === "session_prompt") return { status: "accepted" };
    return [];
  });
  await threads.setConfig(s.key, "model", "other");
  expect(s.configOptions).toEqual(updated);
  expect(s.configCheck?.status).toBe("ready");
  expect(s.modelDrift).toBe(false);
  await expect(
    threads.send(s.key, [{ type: "text", text: "next explicit input" }]),
  ).resolves.toEqual({ status: "accepted" });
  expect(s.queuePaused).toBe(null);
  expect(s.queued).toEqual([]);
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_prompt"),
  ).toHaveLength(1);
  expect(s.nativeSessionId).toBe("intermediate-changed");
});

it.each(["stopped", "unavailable", "no_result", "uncertain"] as const)(
  "preserves an existing %s pause and its old queue after a saved model change",
  async (pause) => {
    const s = seed(`model-old-pause-${pause}`);
    s.identity = "established";
    const previous = [{ type: "text" as const, text: "keep previous input" }];
    s.queued = [previous];
    s.queuePaused = pause;
    const updated = s.configOptions.map((option) => ({
      ...option,
      currentValue: option.id === "model" ? "other" : option.currentValue,
    }));
    h.invoke.mockImplementation(async () => changed(s, updated));
    await threads.setConfig(s.key, "model", "other");
    expect(s.queuePaused).toBe(pause);
    expect(s.queued).toEqual([previous]);
    expect(s.queued[0]).toBe(previous);
    expect(
      h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
    ).toBe(false);
  },
);

it("keeps a later stop pause when the model receipt succeeds", async () => {
  const s = seed("model-new-stop");
  const updated = s.configOptions.map((option) => ({
    ...option,
    currentValue: option.id === "model" ? "other" : option.currentValue,
  }));
  h.invoke.mockImplementation(async () => {
    const result = changed(s, updated);
    s.stopping = true;
    s.queuePaused = "stopped";
    return result;
  });
  await threads.setConfig(s.key, "model", "other");
  expect(s.queuePaused).toBe("stopped");
  expect(s.stopping).toBe(true);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("keeps a later permission pause when the model receipt succeeds", async () => {
  const s = seed("model-new-permission");
  s.permissionConfigId = "permission";
  const updated = s.configOptions.map((option) => ({
    ...option,
    currentValue: option.id === "model" ? "other" : option.currentValue,
  }));
  h.invoke.mockImplementation(async () => {
    const result = changed(s, updated);
    (
      threads as unknown as {
        applyChannelEvent(key: string, event: unknown): void;
      }
    ).applyChannelEvent(s.key, {
      kind: "permissionState",
      permissionConfigId: "permission",
      permissionState: "unknown",
    });
    return result;
  });
  await threads.setConfig(s.key, "model", "other");
  expect(s.queuePaused).toBe("stopped");
  expect(s.permissionState).toBe("unknown");
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("keeps a reported difference blocked when the matching setter fails", async () => {
  const s = seed("model-changed-rejected");
  const original = structuredClone(s.configOptions);
  h.invoke.mockImplementation(async () => {
    changed(
      s,
      original.map((option) => ({
        ...option,
        currentValue: option.id === "model" ? "other" : option.currentValue,
      })),
    );
    throw new Error("setter rejected");
  });
  await expect(threads.setConfig(s.key, "model", "other")).rejects.toThrow();
  expect(s.configOptions).toEqual(original);
  expect(s.modelDrift).toBe(true);
  expect(s.queuePaused).toBe("unavailable");
  expect(s.configError).toBe(STRINGS.repair.configFailed);
});

it("does not release a different reported snapshot with an older saved receipt", async () => {
  const s = seed("model-newer-difference");
  const original = structuredClone(s.configOptions);
  h.invoke.mockImplementation(async () => {
    const updated = original.map((option) => ({
      ...option,
      currentValue: option.id === "model" ? "other" : option.currentValue,
    }));
    changed(
      s,
      updated.map((option) => ({
        ...option,
        currentValue: option.id === "model" ? "newer" : option.currentValue,
      })),
    );
    return confirmed(s, updated);
  });
  await expect(threads.setConfig(s.key, "model", "other")).rejects.toThrow();
  expect(s.configOptions).toEqual(original);
  expect(s.modelDrift).toBe(true);
  expect(s.queuePaused).toBe("unavailable");
});

it("uses the later ready snapshot after an earlier intermediate model difference", async () => {
  const s = seed("model-final-reasoning");
  const updated = s.configOptions.map((option) => ({
    ...option,
    currentValue:
      option.id === "model" || option.id === "reasoning_effort"
        ? "other"
        : option.currentValue,
  }));
  h.invoke.mockImplementation(async () => {
    changed(
      s,
      updated.map((option) => ({
        ...option,
        currentValue:
          option.id === "reasoning_effort" ? "medium" : option.currentValue,
      })),
    );
    const result = confirmed(s, updated);
    event(s, result.configCheck);
    return result;
  });
  await threads.setConfig(s.key, "model", "other");
  expect(s.configOptions).toEqual(updated);
  expect(s.queuePaused).toBe(null);
  expect(s.modelDrift).toBe(false);
});

it.each(["starting", "unknown"] as const)(
  "blocks model changes during an account action with %s state",
  async (phase) => {
    const s = seed("account-change");
    s.agentId = `account-change-agent-${phase}`;
    const activity = authenticationActivity(s.agentId);
    activity.begin(
      { agentId: s.agentId, cwd: s.cwd },
      {
        kind: "authentication",
        methodId: "declared",
        title: "Account action",
        completion: "return_and_verify",
        intent: "switch_account",
      },
      "config-account-action",
    );
    vi.spyOn(activity, "getSnapshot").mockReturnValue({
      ...activity.getSnapshot()!,
      phase,
    });
    await expect(
      threads.setConfig(s.key, "model", "other"),
    ).rejects.toBeTruthy();
    expect(h.invoke).not.toHaveBeenCalled();
  },
);

it("keeps unrelated mode and model_config choices editable on an established conversation", async () => {
  const s = seed("unrelated");
  s.identity = "established";
  s.configOptions.push(
    {
      ...options()[0],
      id: "context",
      name: "Context",
      category: "model_config",
      currentValue: "default",
    },
    {
      ...options()[0],
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "default",
    },
  );
  h.invoke.mockImplementation(async (_command: string, args) =>
    confirmed(
      s,
      s.configOptions.map((o) => ({
        ...o,
        currentValue: o.id === args.configId ? args.value : o.currentValue,
      })),
    ),
  );
  await threads.setConfig(s.key, "context", "other");
  await threads.setConfig(s.key, "mode", "other");
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_set_config"),
  ).toHaveLength(2);
  expect(s.configOptions.slice(0, 4).map((o) => o.currentValue)).toEqual(
    Object.values(values),
  );
});

it("reads all repeated categories into the preparation draft without setters, prompts or source changes", async () => {
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "session_open") {
      const result = {
        nativeSessionId: "prepared",
        connectionId: "prepared-categories-connection",
        cwd: "/categories",
        resumed: false,
        configOptions: options(),
        configCheck: {
          status: "ready",
          issues: [],
          protectedIds: Object.keys(values),
          current: { choices: choices() },
        },
      };
      emitOpeningHeader(args, result);
      return result;
    }
    return [];
  });
  const controller = new AgentPreparation(threads, () => "test-marker");
  await controller.prepare({
    agentId: "category-preparation",
    agentName: "Example",
    cwd: "/categories",
    program: "current",
    service: null,
    config: { ...values },
  });
  const state = controller.getSnapshot();
  expect(state.phase).toBe("untested");
  expect(state.config).toEqual(values);
  expect(state.input?.service).toBeNull();
  expect(
    threads.thread(state.threadKey!)?.configOptions.map((o) => o.id),
  ).toEqual(Object.keys(values));
  expect(
    h.invoke.mock.calls.some(([command]) =>
      ["session_prompt", "session_set_config", "session_set_mode"].includes(
        command,
      ),
    ),
  ).toBe(false);
});

it.each([1, 2])(
  "passes the v%s snapshot verbatim, blocks incomplete protected evidence, and never drains paused input",
  async (version) => {
    const s = seed(`confirm-${version}`);
    s.identity = "established";
    s.queued = [[{ type: "text", text: "keep paused" }]];
    const current =
      version === 2
        ? { choices: choices(), _farfoldService: { kind: "existing" } }
        : {
            model: { id: "model", category: "model", value: "original" },
            thoughtLevel: {
              id: "reasoning_effort",
              category: "thought_level",
              value: "medium",
            },
          };
    const check = {
      status: "confirmation_required",
      issues: choices()
        .slice(2)
        .map((choice) => ({
          id: choice.id,
          category: "thought_level",
          reason: "unrecorded",
          expected: null,
          current: choice.value,
        })),
      protectedIds: Object.keys(values),
      current,
    };
    event(s, check);
    h.invoke.mockImplementation(async (command: string) => {
      if (command !== "session_confirm_config") return [];
      const ready = { ...check, status: "ready", issues: [] };
      event(s, ready);
      return {
        ...ready,
        configuration: {
          ...confirmed(s, s.configOptions),
          configOptionsModern: true,
          configCheck: ready,
        },
      };
    });
    await threads.confirmConfig(s.key);
    expect(h.invoke).toHaveBeenCalledWith(
      "session_confirm_config",
      expect.objectContaining({ displayed: current }),
    );
    expect(s.configOptions).toEqual(options());
    // This old synthetic v1 current contains two choices for four protected
    // options. A complete RPC cannot make that incomplete evidence trustworthy.
    expect(s.modelDrift).toBe(version === 1);
    expect(s.configError).toBe(
      version === 1 ? STRINGS.repair.confirmConfigFailed : null,
    );
    expect(s.queued[0][0]).toMatchObject({ text: "keep paused" });
    expect(s.queuePaused).toBe("unavailable");
    expect(
      h.invoke.mock.calls.some(([command]) =>
        ["session_prompt", "session_set_config"].includes(command),
      ),
    ).toBe(false);
  },
);

it("reads v2 and legacy model metadata by the exact ID rather than copying a category value", () => {
  const stored = {
    _farfoldConfig: 2,
    choices: choices(),
    _farfoldService: { kind: "existing" },
  };
  expect(storedModelValue(stored, "model")).toBe("original");
  expect(storedModelValue(stored, "inference_speed")).toBe("standard");
  expect(storedModelValue(stored, "missing")).toBeNull();
  expect(
    storedModelValue(
      { _farfoldConfig: 1, model: { id: "original-id", value: "old" } },
      "replacement-id",
    ),
  ).toBeNull();
  expect(
    storedModelValue(
      { _farfoldConfig: 1, model: { id: "original-id", value: "old" } },
      "original-id",
    ),
  ).toBe("old");
  expect(storedModelValue({ model: "flat" }, "model")).toBe("flat");
  expect(
    storedModelValue(
      { _farfoldConfig: 2, choices: [...choices(), choices()[0]] },
      "model",
    ),
  ).toBeNull();
  expect(
    storedModelValue(
      { _farfoldConfig: 2, choices: [{ ...choices()[0], type: "unknown" }] },
      "model",
    ),
  ).toBeNull();
});
