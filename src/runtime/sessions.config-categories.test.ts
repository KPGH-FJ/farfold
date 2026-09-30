import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  return s;
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
  "locks every declared protected option %s in an established conversation",
  async (id) => {
    const s = seed(`established-${id}`);
    s.identity = "established";
    const original = structuredClone(s.configOptions);
    await expect(threads.setConfig(s.key, id, "other")).rejects.toThrow(
      STRINGS.repair.modelLocked,
    );
    expect(h.invoke).not.toHaveBeenCalled();
    expect(s.configOptions).toEqual(original);
  },
);

it("locks a restored protected option even before its identity display catches up", async () => {
  const s = seed("resumed");
  s.resumed = true;
  await expect(
    threads.setConfig(s.key, "inference_speed", "other"),
  ).rejects.toThrow(STRINGS.repair.modelLocked);
  expect(h.invoke).not.toHaveBeenCalled();
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
    ).rejects.toThrow(STRINGS.repair.modelLocked);
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
  ).rejects.toThrow(STRINGS.repair.modelLocked);
  expect(h.invoke).not.toHaveBeenCalled();
});

it.each(Object.keys(values))(
  "lets a new draft select %s without dropping its other choices",
  async (id) => {
    const s = seed(`draft-${id}`);
    s.identity = "draft";
    h.invoke.mockImplementation(async (command: string, args) => {
      if (command !== "session_set_config") return [];
      return s.configOptions.map((option) => ({
        ...option,
        currentValue:
          option.id === args.configId ? args.value : option.currentValue,
      }));
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
    s.configOptions.map((o) => ({
      ...o,
      currentValue: o.id === args.configId ? args.value : o.currentValue,
    })),
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
  h.invoke.mockImplementation(async (command: string) =>
    command === "session_open"
      ? {
          nativeSessionId: "prepared",
          cwd: "/categories",
          resumed: false,
          configOptions: options(),
          configCheck: {
            status: "ready",
            issues: [],
            protectedIds: Object.keys(values),
            current: { choices: choices() },
          },
        }
      : [],
  );
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
  "confirms a complete v%s current snapshot verbatim without sending or draining paused input",
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
      return ready;
    });
    await threads.confirmConfig(s.key);
    expect(h.invoke).toHaveBeenCalledWith(
      "session_confirm_config",
      expect.objectContaining({ displayed: current }),
    );
    expect(s.configOptions).toEqual(options());
    expect(s.modelDrift).toBe(false);
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
