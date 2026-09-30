import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AgentSetupSelection } from "./AgentSetup";
import type { ThreadState, ConfigOptionView } from "../runtime/session_types";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  selections: new Map<string, AgentSetupSelection>(),
  open: vi.fn(),
  setConfig: vi.fn(),
  discardDraft: vi.fn(),
  credentials: vi.fn(),
  credentialListeners: new Set<() => void>(),
  live: null as ThreadState | null,
  enabled: false,
  canonical: null as string | null,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= {
      value: typeof initial === "function" ? initial() : initial,
    });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      },
    ];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, i) => !Object.is(value, slot.deps?.[i]))
    ) {
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
      slot.deps = deps;
    }
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string) => ({
    cwd: h.canonical ?? cwd,
    ready: true,
    enabled: () => h.enabled,
  }),
}));
vi.mock("../runtime/credentials", async (original) => ({
  ...(await original<typeof import("../runtime/credentials")>()),
  listCredentials: h.credentials,
  subscribeCredentialChanges: (listener: () => void) => {
    h.credentialListeners.add(listener);
    return () => h.credentialListeners.delete(listener);
  },
}));
vi.mock("../runtime/setup_storage", () => ({
  useSetupStorage: () => ({}),
  setupStorage: {
    completed: () => true,
    confirmedSelection: (id: string) =>
      h.selections.has(id) ? structuredClone(h.selections.get(id)) : undefined,
  },
}));
vi.mock("../runtime/sessions", async (original) => ({
  ...(await original<typeof import("../runtime/sessions")>()),
  useThread: (key: string) => (key === h.live?.key ? h.live : null),
  threads: {
    open: h.open,
    setConfig: h.setConfig,
    discardDraft: h.discardDraft,
    thread: (key: string) => (key === h.live?.key ? h.live : null),
  },
}));
import { EmptyState } from "./EmptyState";
import { Composer } from "./Composer";
import {
  NewConversationAgentDialog,
  NewConversationModelDialog,
} from "./NewConversationPickers";
import { composerDrafts, newConversationChoice } from "../runtime/drafts";
import type { AgentCardModel } from "../runtime/agents";
import { freshThreadState } from "../runtime/session_projection";
import { STRINGS } from "../runtime/strings";
import { preparationFor } from "../runtime/agent_preparation";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";
type Element = ReactElement<Record<string, unknown>>;
let props: ComponentProps<typeof EmptyState>;
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      result.push(child, ...nodes(child.props.children as ReactNode));
  });
  return result;
}
function render() {
  for (let pass = 0; pass < 8; pass++) {
    h.cursor = 0;
    const result = nodes(EmptyState(props));
    if (h.effects.length) {
      for (const effect of h.effects.splice(0)) effect();
      continue;
    }
    return result;
  }
  throw new Error("Unexpected render loop");
}
function composer() {
  return render().find((node) => node.type === Composer)!;
}
function picker() {
  const current = render().find(
    (node) => node.type === NewConversationAgentDialog,
  );
  if (current) return current;
  const trigger = nodes(composer().props.controls as ReactNode).find(
    (node) => node.props["aria-label"] === "选择 Agent",
  )!;
  (trigger.props.onClick as () => void)();
  return render().find((node) => node.type === NewConversationAgentDialog)!;
}
function modelPicker() {
  const current = render().find(
    (node) => node.type === NewConversationModelDialog,
  );
  if (current) return current;
  const trigger = nodes(composer().props.controls as ReactNode).find(
    (node) => node.props["aria-label"] === "模型与来源",
  )!;
  (trigger.props.onClick as () => void)();
  return render().find((node) => node.type === NewConversationModelDialog)!;
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.open.mockReset();
  h.setConfig.mockReset();
  h.discardDraft.mockReset();
  h.credentials.mockReset().mockResolvedValue([]);
  h.credentialListeners.clear();
  h.live = null;
  h.enabled = false;
  h.canonical = null;
  h.selections.clear();
  newConversationChoice.agentId = "A";
  newConversationChoice.cwd = "/work";
  newConversationChoice.service = null;
  newConversationChoice.config = { model: "current-A", reasoning: "ultra" };
  composerDrafts.update("new", () => ({
    text: "Keep my draft",
    attachments: [],
  }));
  props = {
    agents: ["A", "B"].map(
      (id) => ({ id, name: id, status: "connected" }) as AgentCardModel,
    ),
    defaultCwd: "/ordinary",
    onGoSettings: vi.fn(),
    onManageServices: vi.fn(),
    onStarted: vi.fn(),
    onProjectChange: vi.fn(),
  };
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  vi.useRealTimers();
  composerDrafts.clear("new");
});

it.each([
  ["选择 Agent", picker],
  ["模型与来源", modelPicker],
] as const)(
  "keeps the %s trigger as the dialog's explicit focus return target",
  (label, open) => {
    const trigger = nodes(composer().props.controls as ReactNode).find(
      (node) => node.props["aria-label"] === label,
    )!;
    expect(trigger.props.ref).toBeDefined();
    expect(open().props.returnFocusRef).toBe(trigger.props.ref);
  },
);

it("closes model selection before opening API management and keeps the draft and original choice", () => {
  const before = structuredClone(newConversationChoice.config);
  (modelPicker().props.onManageServices as () => void)();
  expect(
    render().some((node) => node.type === NewConversationModelDialog),
  ).toBe(false);
  expect(props.onManageServices).toHaveBeenCalledTimes(1);
  expect(newConversationChoice.config).toEqual(before);
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(props.onStarted).not.toHaveBeenCalled();
});

it("canceling the model dialog does not apply a setting or clear the input", () => {
  (modelPicker().props.onClose as () => void)();
  expect(
    render().some((node) => node.type === NewConversationModelDialog),
  ).toBe(false);
  expect(newConversationChoice.config).toEqual({
    model: "current-A",
    reasoning: "ultra",
  });
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
  expect(props.onStarted).not.toHaveBeenCalled();
});

it("reconfirming the same API choice preserves configuration regardless of property order", async () => {
  newConversationChoice.service = {
    id: "saved",
    model: "model",
    revision: "r1",
  };
  await (modelPicker().props.onApply as (value: unknown) => Promise<void>)({
    service: { id: "saved", revision: "r1", model: "model" },
    modelValue: null,
  });
  expect(newConversationChoice.config).toEqual({
    model: "current-A",
    reasoning: "ultra",
  });
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
});

it("identifies the selected API service even when two services use the same model", async () => {
  h.credentials.mockResolvedValue([
    { id: "one", label: "Personal service" },
    { id: "two", label: "Work service" },
  ]);
  newConversationChoice.service = {
    id: "one",
    model: "shared-model",
    revision: "r1",
  };
  composer();
  await Promise.resolve();
  expect(composer().props.caption).toContain("Personal service");
  await (modelPicker().props.onApply as (value: unknown) => Promise<void>)({
    service: { id: "two", model: "shared-model", revision: "r2" },
    modelValue: null,
  });
  expect(composer().props.caption).not.toContain("Personal service");
  await Promise.resolve();
  expect(composer().props.caption).toContain("Work service");
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(props.onStarted).not.toHaveBeenCalled();
});

it("ignores a stale source-label response and refreshes the label after a rename", async () => {
  let old!: (records: unknown[]) => void;
  h.credentials
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockResolvedValue([{ id: "two", label: "Current service" }]);
  newConversationChoice.service = {
    id: "one",
    model: "shared-model",
    revision: "r1",
  };
  composer();
  await (modelPicker().props.onApply as (value: unknown) => Promise<void>)({
    service: { id: "two", model: "shared-model", revision: "r2" },
    modelValue: null,
  });
  composer();
  await Promise.resolve();
  old([{ id: "one", label: "Wrong old service" }]);
  await Promise.resolve();
  expect(composer().props.caption).toContain("Current service");
  h.credentials.mockResolvedValue([{ id: "two", label: "Renamed service" }]);
  h.credentialListeners.forEach((listener) => listener());
  await Promise.resolve();
  expect(composer().props.caption).toContain("Renamed service");
  expect(newConversationChoice.service?.id).toBe("two");
});

it("keeps the current same-Agent draft choice instead of replacing it with its saved default", () => {
  h.selections.set("A", { service: null, config: { model: "default-A" } });
  (picker().props.onPick as (id: string) => void)("A");
  picker();
  expect(newConversationChoice.config).toEqual({
    model: "current-A",
    reasoning: "ultra",
  });
  expect(props.onGoSettings).not.toHaveBeenCalled();
});

it("restores the selected Agent's confirmed source revision, model and reasoning", () => {
  const selection = {
    service: { id: "api-B", model: "Nemotron", revision: "confirmed-revision" },
    config: { model: "Nemotron", reasoning: "ultra", mode: "build" },
  };
  h.selections.set("B", selection);
  (picker().props.onPick as (id: string) => void)("B");
  expect(picker().props.picked).toBe("B");
  expect(newConversationChoice.service).toEqual(selection.service);
  expect(newConversationChoice.config).toEqual(selection.config);
  expect(h.open).not.toHaveBeenCalled();
});

it("opens preparation when a different Agent has no confirmed choice and preserves the current draft", () => {
  (picker().props.onPick as (id: string) => void)("B");
  expect(props.onGoSettings).toHaveBeenCalledWith("B");
  expect(picker().props.picked).toBe("A");
  expect(newConversationChoice.config).toEqual({
    model: "current-A",
    reasoning: "ultra",
  });
  expect(h.open).not.toHaveBeenCalled();
});

const configOption = (
  id: string,
  currentValue: string,
  options: string[],
): ConfigOptionView => ({
  id,
  category: id === "model" ? "model" : undefined,
  type: "select",
  name: id,
  currentValue,
  options: options.map((value) => ({ value, name: value })),
});
async function startEditableDraft(cwd = "/work") {
  vi.useFakeTimers();
  newConversationChoice.cwd = cwd;
  h.live = freshThreadState("new-A", "A", cwd, "native");
  h.live.identity = "draft";
  h.live.configOptions = [
    configOption("model", "current-A", ["current-A", "other"]),
    configOption("reasoning", "ultra", ["low", "ultra"]),
  ];
  h.open.mockResolvedValue(h.live);
  h.enabled = true;
  composer();
  await vi.advanceTimersByTimeAsync(251);
  expect(composer().props.disabled).toBe(false);
  expect(h.setConfig).not.toHaveBeenCalled();
}

it("does not reopen a completed Agent's new draft after a configuration operation requires explicit reading", async () => {
  vi.useFakeTimers();
  const cwd = "/configuration-return-unread";
  h.canonical = "/canonical-configuration-return-unread";
  newConversationChoice.cwd = cwd;
  h.enabled = true;
  h.open.mockResolvedValue(freshThreadState("unused", "A", cwd, "native"));
  preparationFor("A").requireExplicitRead({ agentId: "A", cwd });
  const before = structuredClone(newConversationChoice.config);
  let view = composer();
  await vi.advanceTimersByTimeAsync(251);
  props.active = false;
  render();
  props.active = true;
  view = composer();
  await vi.advanceTimersByTimeAsync(251);
  expect(h.open).not.toHaveBeenCalled();
  expect(view.props.disabled).toBe(true);
  expect(view.props.note).toBe(C.readRequired);
  (view.props.prepareAction as () => void)();
  expect(props.onGoSettings).toHaveBeenCalledWith(
    "A",
    expect.objectContaining({ panel: "model" }),
  );
  expect(newConversationChoice.config).toEqual(before);
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
});

it("blocks stale send and model handlers as soon as configuration invalidates the original draft", async () => {
  const cwd = "/configuration-return-cached";
  await startEditableDraft(cwd);
  const send = composer().props.onSend as (...args: unknown[]) => Promise<void>;
  const apply = modelPicker().props.onApply as (
    value: unknown,
  ) => Promise<void>;
  const before = structuredClone(newConversationChoice.config);
  preparationFor("A").requireExplicitRead({ agentId: "A", cwd });
  await expect(send([], composerDrafts.read("new"))).rejects.toThrow(
    C.readRequired,
  );
  await expect(apply({ service: null, modelValue: "other" })).rejects.toThrow(
    C.readRequired,
  );
  expect(composer().props.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(251);
  expect(h.open).toHaveBeenCalledTimes(1);
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(newConversationChoice.config).toEqual(before);
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(props.onStarted).not.toHaveBeenCalled();
});

it.each(["other-directory", "api-source"])(
  "does not block a different preparation target (%s)",
  async (target) => {
    vi.useFakeTimers();
    const cwd = `/configuration-return-${target}`;
    preparationFor("A").requireExplicitRead({ agentId: "A", cwd });
    newConversationChoice.cwd =
      target === "other-directory" ? `${cwd}/other` : cwd;
    newConversationChoice.config = {};
    if (target === "api-source")
      newConversationChoice.service = {
        id: "api",
        model: "chosen",
        revision: "r1",
      };
    h.enabled = true;
    h.open.mockResolvedValue(
      freshThreadState("other", "A", newConversationChoice.cwd, "native"),
    );
    composer();
    await vi.advanceTimersByTimeAsync(251);
    expect(h.open).toHaveBeenCalledOnce();
    expect(preparationFor("A").getSnapshot().explicitReadTargets).toContain(
      JSON.stringify(["A", cwd, null]),
    );
  },
);

it("changes the confirmed model only on apply and preserves the user's reasoning choice", async () => {
  await startEditableDraft();
  h.setConfig.mockImplementation(async (_key, id, value) => {
    h.live!.configOptions =
      id === "model"
        ? [
            configOption("model", value, ["current-A", "other"]),
            configOption("reasoning", "low", ["low", "ultra"]),
          ]
        : h.live!.configOptions.map((option) =>
            option.id === id ? { ...option, currentValue: value } : option,
          );
  });
  const apply = modelPicker().props.onApply as (
    value: unknown,
  ) => Promise<void>;
  expect(h.setConfig).not.toHaveBeenCalled();
  await apply({ service: null, modelValue: "other" });
  expect(h.setConfig.mock.calls.map(([, id, value]) => [id, value])).toEqual([
    ["model", "other"],
    ["reasoning", "ultra"],
  ]);
  expect(newConversationChoice.config).toEqual({
    model: "other",
    reasoning: "ultra",
  });
  expect(composer().props.disabled).toBe(false);
  expect(composerDrafts.read("new").text).toBe("Keep my draft");
  expect(props.onStarted).not.toHaveBeenCalled();
});

it.each([
  "model-not-confirmed",
  "reasoning-unavailable",
  "reasoning-not-confirmed",
  "later-model-drift",
])(
  "keeps the original choice and disables sending when model apply is not fully confirmed (%s)",
  async (failure) => {
    await startEditableDraft();
    h.setConfig.mockImplementation(async (_key, id, value) => {
      if (id === "model")
        h.live!.configOptions = [
          configOption(
            "model",
            failure === "model-not-confirmed" ? "current-A" : value,
            ["current-A", "other"],
          ),
          configOption(
            "reasoning",
            "low",
            failure === "reasoning-unavailable" ? ["low"] : ["low", "ultra"],
          ),
        ];
      else if (failure === "later-model-drift")
        h.live!.configOptions = [
          configOption("model", "current-A", ["current-A", "other"]),
          configOption("reasoning", value, ["low", "ultra"]),
        ];
    });
    await expect(
      (modelPicker().props.onApply as (value: unknown) => Promise<void>)({
        service: null,
        modelValue: "other",
      }),
    ).rejects.toThrow(STRINGS.repair.configFailed);
    const view = composer();
    expect(newConversationChoice.config).toEqual({
      model: "current-A",
      reasoning: "ultra",
    });
    expect(view.props.disabled).toBe(true);
    expect(view.props.note).toContain(STRINGS.repair.configFailed);
    expect(composerDrafts.read("new").text).toBe("Keep my draft");
    expect(props.onStarted).not.toHaveBeenCalled();
    expect(
      h.setConfig.mock.calls.filter(([, id]) => id === "model"),
    ).toHaveLength(1);
  },
);

it("does not overwrite a different Agent's choice when an older model application finishes", async () => {
  await startEditableDraft();
  let finish!: () => void;
  h.setConfig.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = (
    modelPicker().props.onApply as (value: unknown) => Promise<void>
  )({ service: null, modelValue: "other" });
  const oldDraft = h.live!;
  h.selections.set("B", {
    service: null,
    config: { model: "Nemotron", reasoning: "ultra" },
  });
  (picker().props.onPick as (id: string) => void)("B");
  render();
  oldDraft.configOptions = [
    configOption("model", "other", ["current-A", "other"]),
    configOption("reasoning", "low", ["low", "ultra"]),
  ];
  finish();
  await pending;
  expect(newConversationChoice.agentId).toBe("B");
  expect(newConversationChoice.config).toEqual({
    model: "Nemotron",
    reasoning: "ultra",
  });
  expect(h.setConfig).toHaveBeenCalledTimes(1);
});

it("does not overwrite a newer explicit same-Agent selection when an older application finishes", async () => {
  await startEditableDraft();
  let finish!: () => void;
  h.setConfig.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = (
    modelPicker().props.onApply as (value: unknown) => Promise<void>
  )({ service: null, modelValue: "other" });
  props.initialAgentId = "A";
  props.initialAgentRevision = 1;
  props.initialSelection = {
    service: null,
    config: { model: "newer-A", reasoning: "ultra" },
  };
  render();
  finish();
  await pending;
  expect(newConversationChoice.config).toEqual({
    model: "newer-A",
    reasoning: "ultra",
  });
  expect(h.setConfig).toHaveBeenCalledTimes(1);
});

function startDynamicDraft() {
  vi.useFakeTimers();
  h.live = freshThreadState("new-B", "B", "/work", "native");
  h.live.identity = "draft";
  h.live.configOptions = [
    configOption("reasoning", "low", ["low"]),
    configOption("model", "default", ["default", "Nemotron"]),
    configOption("mode", "build", ["build"]),
  ];
  h.open.mockResolvedValue(h.live);
  h.selections.set("B", {
    service: null,
    config: { reasoning: "ultra", model: "Nemotron", mode: "build" },
  });
  (picker().props.onPick as (id: string) => void)("B");
  h.enabled = true;
  composer();
}

it("applies the model first and reads the newly returned reasoning choices before restoring Ultra", async () => {
  startDynamicDraft();
  h.setConfig.mockImplementation(
    async (_key: string, id: string, value: string) => {
      if (id === "model")
        h.live!.configOptions = [
          configOption("model", value, ["default", "Nemotron"]),
          configOption("reasoning", "low", ["low", "ultra"]),
          configOption("mode", "build", ["build"]),
        ];
      else
        h.live!.configOptions = h.live!.configOptions.map((option) =>
          option.id === id ? { ...option, currentValue: value } : option,
        );
    },
  );
  await vi.advanceTimersByTimeAsync(251);
  expect(h.setConfig.mock.calls.map(([, id, value]) => [id, value])).toEqual([
    ["model", "Nemotron"],
    ["reasoning", "ultra"],
  ]);
  expect(composer().props.disabled).toBe(false);
  expect(newConversationChoice.config).toEqual({
    model: "Nemotron",
    reasoning: "ultra",
    mode: "build",
  });
});

it.each([
  "unavailable-model",
  "unavailable-reasoning",
  "unconfirmed-reasoning",
  "later-model-drift",
])(
  "preserves the selected configuration and offers model repair instead of downgrading (%s)",
  async (failure) => {
    startDynamicDraft();
    if (failure === "unavailable-model")
      h.live!.configOptions = [configOption("model", "default", ["default"])];
    h.setConfig.mockImplementation(
      async (_key: string, id: string, value: string) => {
        if (id === "model")
          h.live!.configOptions = [
            configOption("model", value, ["default", "Nemotron"]),
            configOption(
              "reasoning",
              "low",
              failure === "unavailable-reasoning" ? ["low"] : ["low", "ultra"],
            ),
            configOption("mode", "build", ["build"]),
          ];
        if (id === "reasoning" && failure === "later-model-drift")
          h.live!.configOptions = [
            configOption("model", "default", ["default", "Nemotron"]),
            configOption("reasoning", value, ["low", "ultra"]),
            configOption("mode", "build", ["build"]),
          ];
      },
    );
    await vi.advanceTimersByTimeAsync(251);
    const view = composer();
    expect(view.props.disabled).toBe(true);
    expect(newConversationChoice.config).toEqual({
      model: "Nemotron",
      reasoning: "ultra",
      mode: "build",
    });
    expect(view.props.thread).toBeNull();
    (view.props.onGoSettings as () => void)();
    expect(props.onGoSettings).toHaveBeenCalledWith(
      "B",
      expect.objectContaining({ panel: "model" }),
    );
    expect(view.props.note).toContain(STRINGS.repair.configFailed);
  },
);
