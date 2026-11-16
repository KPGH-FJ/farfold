import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AgentCardModel } from "../runtime/agents";
import type { ConfigOptionView, ThreadState } from "../runtime/session_types";
import {
  ConfigurationConfirmationError,
  configurationApplyNotice,
  confirmationFeedback,
  isConfigurationRestoreNotice,
} from "../runtime/configuration_restore_feedback";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: () => void;
  }[],
  effects: [] as (() => void)[],
  open: vi.fn(),
  setConfig: vi.fn(),
  confirmRestored: vi.fn(),
  live: null as ThreadState | null,
  credentials: vi.fn(),
  capabilities: vi.fn(),
}));
vi.mock("react-dom", () => ({
  createPortal: (children: ReactNode) => children,
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
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !deps ||
      !slot.deps ||
      deps.some((v, i) => !Object.is(v, slot.deps?.[i]))
    ) {
      slot.deps = deps;
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
    }
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string | null) => ({
    cwd,
    ready: true,
    enabled: () => true,
  }),
}));
vi.mock("../runtime/connection_hold", () => ({ useConnectionHold: vi.fn() }));
vi.mock("../runtime/credentials", async (original) => ({
  ...(await original<typeof import("../runtime/credentials")>()),
  listCredentials: h.credentials,
  getServiceCapabilities: h.capabilities,
  subscribeCredentialChanges: () => () => {},
}));
vi.mock("../runtime/setup_storage", () => ({
  useSetupStorage: () => ({}),
  setupStorage: {
    completed: () => true,
    confirmedSelection: (id: string) => ({
      service: null,
      config: id === "A" ? { model: "kept-choice" } : {},
    }),
  },
}));
vi.mock("../runtime/sessions", async (original) => ({
  ...(await original<typeof import("../runtime/sessions")>()),
  useThread: (key: string) => (key === h.live?.key ? h.live : null),
  threads: {
    open: h.open,
    setConfig: h.setConfig,
    confirmRestoredConfig: h.confirmRestored,
    discardDraft: vi.fn(),
    thread: (key: string) => (key === h.live?.key ? h.live : null),
  },
}));
vi.mock(
  "../runtime/worktrees",
  () => import("../runtime/worktree_catalogue.test-fixture"),
);

import { EmptyState } from "./EmptyState";
import { Composer } from "./Composer";
import { ReasoningControl } from "./ReasoningControl";
import {
  NewConversationAgentDialog,
  NewConversationModelDialog,
} from "./NewConversationPickers";
import { ErrorNotice } from "./ErrorNotice";
import { composerDrafts, newConversationChoice } from "../runtime/drafts";
import { allowAutomaticConnection } from "../runtime/connection_intent";
import { freshThreadState } from "../runtime/session_projection";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { NEW_CONVERSATION_PICKER_STRINGS as S } from "../runtime/new_conversation_picker_strings";
import { ERROR_STRINGS as E } from "../runtime/error_strings";
import { STRINGS } from "../runtime/strings";
import { ACCESS_STRINGS as A } from "../runtime/access_strings";
import { observeAuthentication } from "../runtime/authentication";

type Element = ReactElement<Record<string, unknown>>;
let props: ComponentProps<typeof EmptyState>;
const authObservations: { cwd: string; source?: string }[] = [];
function requireAuthentication(cwd: string, source?: string) {
  authObservations.push({ cwd, source });
  observeAuthentication("A", cwd, "AUTH_REQUIRED", source);
}
function walk(tree: ReactNode): Element[] {
  const out: Element[] = [];
  Children.forEach(tree, (node) => {
    if (isValidElement<Record<string, unknown>>(node))
      out.push(
        node,
        ...walk(node.props.children as ReactNode),
        ...walk(node.props.controls as ReactNode),
        ...walk(node.props.footer as ReactNode),
        ...walk(node.props.searchField as ReactNode),
      );
  });
  return out;
}
function text(node: ReactNode): string {
  return Children.toArray(node)
    .map((v) =>
      isValidElement<{ children?: ReactNode }>(v)
        ? text(v.props.children)
        : String(v),
    )
    .join("");
}
function render() {
  for (let pass = 0; pass < 10; pass++) {
    h.cursor = 0;
    const root = walk(EmptyState(props));
    const dialog = root.find((n) => n.type === NewConversationModelDialog);
    const popup = dialog
      ? walk(
          NewConversationModelDialog(
            dialog.props as ComponentProps<typeof NewConversationModelDialog>,
          ),
        )
      : [];
    if (!h.effects.length)
      return {
        root,
        dialog,
        popup,
        composer: root.find((n) => n.type === Composer)!,
      };
    for (const effect of h.effects.splice(0)) effect();
  }
  throw new Error("controlled render did not settle");
}
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return render();
}
function button(nodes: Element[], label: string) {
  return nodes.find(
    (n) => n.type === "button" && text(n.props.children as ReactNode) === label,
  )!;
}
beforeEach(() => {
  vi.useFakeTimers();
  h.slots = [];
  h.effects = [];
  h.live = null;
  h.open.mockReset();
  h.setConfig.mockReset();
  h.confirmRestored.mockReset().mockResolvedValue(undefined);
  h.credentials.mockReset().mockResolvedValue([]);
  h.capabilities
    .mockReset()
    .mockResolvedValue({ apiTypes: [], unavailableReason: null });
  for (const id of ["A", "B"]) allowAutomaticConnection(id);
  Object.assign(newConversationChoice, {
    cwd: "/owned-fixture",
    agentId: "A",
    service: null,
    config: { model: "kept-choice" },
    reviewRequired: false,
  });
  composerDrafts.update("new", () => ({
    text: "Keep this draft",
    attachments: [
      {
        id: "owned-attachment",
        kind: "file",
        uri: "file:///owned-fixture/input.txt",
        name: "input.txt",
        deliveryMode: "location",
      },
    ],
  }));
  props = {
    agents: ["A", "B"].map(
      (id) => ({ id, name: id, status: "connected" }) as AgentCardModel,
    ),
    onGoSettings: vi.fn(),
    onProjectChange: vi.fn(),
    onStarted: vi.fn(),
  };
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  for (const { cwd, source } of authObservations.splice(0))
    observeAuthentication("A", cwd, undefined, source);
  composerDrafts.clear("new");
  vi.useRealTimers();
});

it("keeps a same-owner authentication recovery exit when auth publication cancels the opening error callback", async () => {
  let reject!: (error: Error) => void;
  h.open.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const before = composerDrafts.read("new");
  const choice = structuredClone(newConversationChoice.config);
  (
    render().root.find((n) => n.props["aria-label"] === W.modelChoice)!.props
      .onClick as () => void
  )();
  render();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).toHaveBeenCalledTimes(1);
  // sessions.open publishes auth before rejecting; a subscribed render may
  // clean up this effect before its guarded error callback receives the error.
  requireAuthentication("/owned-fixture");
  render();
  reject(new Error("AUTH_REQUIRED"));
  const failed = await settle();
  expect(failed.composer.props.disabled).toBe(true);
  expect(failed.composer.props.note).toBe(A.authRequired);
  expect(failed.composer.props.prepareAction).toBeTypeOf("function");
  (failed.composer.props.prepareAction as () => void)();
  expect(props.onGoSettings).toHaveBeenCalledWith("A", {
    panel: "account",
    needsAuthentication: true,
    sourceContext: undefined,
  });
  await vi.advanceTimersByTimeAsync(1000);
  render();
  expect(h.open).toHaveBeenCalledTimes(1);
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(props.onStarted).not.toHaveBeenCalled();
  expect(failed.composer.props.sendRequest).toBe(0);
  expect(newConversationChoice.agentId).toBe("A");
  expect(newConversationChoice.config).toEqual(choice);
  expect(composerDrafts.read("new")).toBe(before);
});

it.each([false, true])(
  "keeps the existing %s source authentication repair available without a selected folder",
  async (api) => {
    const service = api
      ? { id: "owned-api", model: "kept-model", revision: "one" }
      : null;
    newConversationChoice.cwd = null;
    newConversationChoice.service = service;
    const before = composerDrafts.read("new");
    const choice = structuredClone(newConversationChoice.config);
    const source = service ? JSON.stringify(service) : undefined;
    requireAuthentication("/owned-fixture", source);
    const failed = render();
    expect(failed.composer.props.disabled).toBe(true);
    expect(failed.composer.props.note).toBe(
      api ? A.apiAuthRequired : A.authRequired,
    );
    expect(failed.composer.props.prepareAction).toBeTypeOf("function");
    (failed.composer.props.prepareAction as () => void)();
    expect(props.onGoSettings).toHaveBeenCalledWith("A", {
      panel: "account",
      needsAuthentication: true,
      sourceContext: source,
    });
    await vi.advanceTimersByTimeAsync(1000);
    render();
    expect(h.open).not.toHaveBeenCalled();
    expect(h.setConfig).not.toHaveBeenCalled();
    expect(props.onStarted).not.toHaveBeenCalled();
    expect(failed.composer.props.sendRequest).toBe(0);
    expect(newConversationChoice.agentId).toBe("A");
    expect(newConversationChoice.service).toEqual(service);
    expect(newConversationChoice.config).toEqual(choice);
    expect(composerDrafts.read("new")).toBe(before);
  },
);

it.each(["source", "cwd"])(
  "does not apply a foreign %s authentication failure to the current preparation",
  async (foreign) => {
    let resolve!: (value: ThreadState) => void;
    h.open.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const before = composerDrafts.read("new");
    (
      render().root.find((n) => n.props["aria-label"] === W.modelChoice)!.props
        .onClick as () => void
    )();
    render();
    await vi.advanceTimersByTimeAsync(300);
    requireAuthentication(
      foreign === "cwd" ? "/foreign-fixture" : "/owned-fixture",
      foreign === "source" ? "foreign-source" : undefined,
    );
    render();
    h.live = freshThreadState("prepared-a", "A", "/owned-fixture", "owned-a");
    h.live.configOptions = [
      configOption("model", "kept-choice", ["kept-choice"]),
    ];
    resolve(h.live);
    const current = await settle();
    expect(current.composer.props.disabled).toBe(false);
    expect(current.composer.props.note).toBeNull();
    expect(current.composer.props.prepareAction).toBeUndefined();
    expect(current.composer.props.thread).toBe(h.live);
    expect(props.onGoSettings).not.toHaveBeenCalled();
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.setConfig).not.toHaveBeenCalled();
    expect(newConversationChoice.agentId).toBe("A");
    expect(composerDrafts.read("new")).toBe(before);
  },
);

it("keeps an old Agent authentication publication and rejection out of a newly selected B draft", async () => {
  let reject!: (error: Error) => void;
  h.open.mockImplementation((input: { agentId: string }) =>
    input.agentId === "A"
      ? new Promise((_resolve, fail) => {
          reject = fail;
        })
      : Promise.resolve(h.live),
  );
  const before = composerDrafts.read("new");
  (
    render().root.find((n) => n.props["aria-label"] === W.modelChoice)!.props
      .onClick as () => void
  )();
  render();
  await vi.advanceTimersByTimeAsync(300);
  (
    render().root.find((n) => n.props["aria-label"] === W.agentChoice)!.props
      .onClick as () => void
  )();
  const picker = render().root.find(
    (n) => n.type === NewConversationAgentDialog,
  )!;
  h.live = freshThreadState("prepared-b", "B", "/owned-fixture", "owned-b");
  (picker.props.onPick as (id: string) => void)("B");
  render();
  await vi.advanceTimersByTimeAsync(300);
  await settle();
  requireAuthentication("/owned-fixture");
  render();
  reject(new Error("AUTH_REQUIRED"));
  const current = await settle();
  expect(current.composer.props.note).toBeNull();
  expect(current.composer.props.disabled).toBe(false);
  expect(current.composer.props.prepareAction).toBeUndefined();
  expect(newConversationChoice.agentId).toBe("B");
  expect(current.composer.props.thread).toBe(h.live);
  expect(h.open).toHaveBeenCalledTimes(2);
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(props.onGoSettings).not.toHaveBeenCalled();
  expect(props.onStarted).not.toHaveBeenCalled();
  expect(composerDrafts.read("new")).toBe(before);
});

it("bridges a real preparation rejection into the already open model dialog without retrying, sending or changing the draft choice", async () => {
  let reject!: (error: Error) => void;
  h.open.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const before = composerDrafts.read("new");
  const choice = structuredClone(newConversationChoice.config);
  const trigger = render().root.find(
    (n) => n.props["aria-label"] === W.modelChoice,
  )!;
  (trigger.props.onClick as () => void)();
  render();
  await vi.advanceTimersByTimeAsync(300);
  expect(render().dialog?.props.readingModels).toBe(true);
  expect(h.open).toHaveBeenCalledTimes(1);
  reject(new Error("AGENT_INITIALIZE_TIMEOUT"));
  const failed = await settle();
  expect(failed.composer.props.note).toMatchObject({
    message: expect.stringContaining(E.agentInitializeTimeout),
  });
  expect(failed.dialog?.props.readingModels).toBe(false);
  expect(failed.dialog?.props.readError).toEqual(failed.composer.props.note);
  expect(failed.popup.find((n) => n.type === ErrorNotice)?.props.message).toBe(
    (failed.composer.props.note as { message: string }).message,
  );
  expect(button(failed.popup, S.currentModel).props.disabled).toBe(true);
  expect(
    failed.popup.some(
      (n) =>
        n.props.role === "status" &&
        text(n.props.children as ReactNode) === S.readingModels,
    ),
  ).toBe(false);
  expect(failed.composer.props.disabled).toBe(true);
  expect(failed.composer.props.sendRequest).toBe(0);
  await vi.advanceTimersByTimeAsync(1000);
  render();
  expect(h.open).toHaveBeenCalledTimes(1);
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(props.onStarted).not.toHaveBeenCalled();
  expect(newConversationChoice.config).toEqual(choice);
  expect(composerDrafts.read("new")).toBe(before);
  (button(failed.popup, S.prepare).props.onClick as () => void)();
  expect(props.onGoSettings).toHaveBeenCalledTimes(1);
});

it("does not let a rejected old Agent preparation contaminate a newly selected prepared draft", async () => {
  let reject!: (error: Error) => void;
  h.open.mockImplementation((value: { agentId: string }) =>
    value.agentId === "A"
      ? new Promise((_resolve, fail) => {
          reject = fail;
        })
      : Promise.resolve(h.live),
  );
  (
    render().root.find((n) => n.props["aria-label"] === W.modelChoice)!.props
      .onClick as () => void
  )();
  render();
  await vi.advanceTimersByTimeAsync(300);
  (
    render().root.find((n) => n.props["aria-label"] === W.agentChoice)!.props
      .onClick as () => void
  )();
  const picker = render().root.find(
    (n) => n.type === NewConversationAgentDialog,
  )!;
  h.live = freshThreadState(
    "prepared-b",
    "B",
    "/owned-fixture",
    "synthetic-native-id",
  );
  (picker.props.onPick as (id: string) => void)("B");
  render();
  await vi.advanceTimersByTimeAsync(300);
  await settle();
  (
    render().root.find((n) => n.props["aria-label"] === W.modelChoice)!.props
      .onClick as () => void
  )();
  render();
  reject(new Error("AGENT_INITIALIZE_TIMEOUT"));
  const current = await settle();
  expect(current.composer.props.note).toBeNull();
  expect(current.dialog?.props.readError ?? null).toBeNull();
  expect(current.popup.some((n) => n.type === ErrorNotice)).toBe(false);
  expect(newConversationChoice.agentId).toBe("B");
  expect(h.open).toHaveBeenCalledTimes(2);
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(composerDrafts.read("new").text).toBe("Keep this draft");
});

const restoreCopy = {
  missing: "设置尚未确认，请检查后重试。Agent 当前未提供某项已保存设置。",
  unavailable: "设置尚未确认，请检查后重试。已保存的选择当前不可用。",
  readback: "设置尚未确认，请检查后重试。读回结果与已保存的选择不一致。",
};
function configOption(
  id: string,
  currentValue: string,
  values: string[],
): ConfigOptionView {
  return {
    id,
    name: id === "model" ? "Model" : "Thinking",
    category: id === "model" ? "model" : "thought_level",
    type: "select",
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  };
}
function startRestore(config: Record<string, unknown>) {
  newConversationChoice.config = config;
  h.live = freshThreadState("prepared-a", "A", "/owned-fixture", "owned-a");
  h.live.configOptions = [
    configOption("model", "initial", ["initial", "kept-choice"]),
    configOption("thought_level", "low", ["low"]),
  ];
  h.open.mockResolvedValue(h.live);
  h.setConfig.mockImplementation(async (_key, id, value) => {
    if (id === "model")
      h.live!.configOptions = [
        configOption("model", value, ["initial", "kept-choice"]),
        configOption("thought_level", "low", ["low", "medium"]),
      ];
    else
      h.live!.configOptions.find((option) => option.id === id)!.currentValue =
        value;
  });
  (
    render().root.find((node) => node.props["aria-label"] === W.modelChoice)!
      .props.onClick as () => void
  )();
  render();
}

it("confirms the original saved baseline after zero-setter equal restoration before exposing the draft", async () => {
  const before = composerDrafts.read("new");
  startRestore({ model: "kept-choice", thought_level: "low" });
  h.live!.configOptions[0].currentValue = "kept-choice";
  let release!: () => void;
  h.confirmRestored.mockImplementation(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  await vi.advanceTimersByTimeAsync(300);
  expect(h.confirmRestored).toHaveBeenCalledWith("prepared-a", {
    model: "kept-choice",
    thought_level: "low",
  });
  expect(render().composer.props.disabled).toBe(true);
  expect(render().composer.props.thread).toBeNull();
  release();
  const ready = await settle();
  expect(ready.composer.props.disabled).toBe(false);
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(composerDrafts.read("new")).toBe(before);
});

it("confirms only after model-first setters and the final saved thought readback", async () => {
  const saved = { thought_level: "medium", model: "kept-choice" };
  startRestore(saved);
  h.confirmRestored.mockImplementation(async (_key, selection) => {
    expect(h.setConfig.mock.calls.map((call) => call[1])).toEqual([
      "model",
      "thought_level",
    ]);
    expect(selection).toEqual(saved);
    expect(
      h.live!.configOptions.find((item) => item.id === "thought_level")
        ?.currentValue,
    ).toBe("medium");
  });
  await vi.advanceTimersByTimeAsync(300);
  expect((await settle()).composer.props.disabled).toBe(false);
  expect(h.confirmRestored).toHaveBeenCalledOnce();
});

it.each([{}, { mode: "safe" }])(
  "does not confirm defaults or only ordinary saved settings: %j",
  async (saved) => {
    startRestore(saved);
    h.live!.configOptions.push({
      ...configOption("mode", "safe", ["safe"]),
      category: "mode",
    });
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(h.confirmRestored).not.toHaveBeenCalled();
  },
);

it("confirms an original thought-only selection without requiring a declared model", async () => {
  startRestore({ thought_level: "low" });
  h.live!.configOptions = h.live!.configOptions.filter(
    (option) => option.id !== "model",
  );
  await vi.advanceTimersByTimeAsync(300);
  expect((await settle()).composer.props.disabled).toBe(false);
  expect(h.confirmRestored).toHaveBeenCalledWith("prepared-a", {
    thought_level: "low",
  });
});
it("does not manufacture protected saved choices from default or later blocked notifications", async () => {
  startRestore({});
  await vi.advanceTimersByTimeAsync(300);
  await settle();
  expect(newConversationChoice.config).toEqual({});
  newConversationChoice.config = { model: "kept-choice" };
  h.live!.configOptions = [
    configOption("model", "initial", ["initial", "kept-choice"]),
    { ...configOption("mode", "safe", ["safe"]), category: "mode" },
  ];
  h.live!.configCheck = {
    status: "blocked",
    issues: [],
    protectedIds: ["model"],
    current: {},
  };
  h.live!.modelDrift = true;
  render();
  expect(newConversationChoice.config).toEqual({
    model: "kept-choice",
    mode: "safe",
  });
});
it("confirms an explicit same-value model click without a setter or converting inherited thought into intent", async () => {
  startRestore({});
  h.live!.configOptions[0].currentValue = "kept-choice";
  await vi.advanceTimersByTimeAsync(300);
  const view = await settle();
  await (view.dialog!.props.onApply as (choice: unknown) => Promise<void>)({
    service: null,
    modelValue: "kept-choice",
  });
  expect(h.confirmRestored).toHaveBeenCalledWith("prepared-a", {
    model: "kept-choice",
  });
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(newConversationChoice.config).toEqual({ model: "kept-choice" });
});

it("enriches only a matching local confirmation notice without trusting a copied or conflicting notice", () => {
  const notice = configurationApplyNotice(
    new ConfigurationConfirmationError(
      "FARFOLD_RESTORE_CONFIRM_DISPLAYED_CHANGED",
    ),
  );
  const guard = STRINGS.repair.confirmConfigFailed;
  expect(confirmationFeedback(notice, guard)).toBe(notice);
  expect(confirmationFeedback({ ...notice }, guard)).toBe(guard);
  expect(
    confirmationFeedback(
      { message: guard, detail: "私密 PRIVATE_NOTICE_CANARY" },
      guard,
    ),
  ).toBe(guard);
  expect(confirmationFeedback(notice, STRINGS.repair.configFailed)).toBe(
    STRINGS.repair.configFailed,
  );
  expect(
    configurationApplyNotice({ message: guard, detail: "PRIVATE_RAW_CANARY" }),
  ).toEqual({
    message: STRINGS.repair.configFailed,
  });
});

it("keeps model repair navigation when confirmation fails before the thread has a config error", async () => {
  startRestore({});
  await vi.advanceTimersByTimeAsync(300);
  const prepared = await settle();
  h.confirmRestored.mockImplementation(async () => {
    h.live!.connectionOutcomeUnknown = true;
    throw new ConfigurationConfirmationError(
      "busy-before",
      "connectionOutcomeUnknown",
    );
  });
  await expect(
    (prepared.dialog!.props.onApply as (choice: unknown) => Promise<void>)({
      service: null,
      modelValue: "kept-choice",
    }),
  ).rejects.toThrow(STRINGS.repair.confirmConfigFailed);
  const failed = await settle();
  expect(h.live!.configError).toBeNull();
  expect(h.live!.modelDrift).toBe(false);
  (failed.composer.props.onGoSettings as () => void)();
  expect(props.onGoSettings).toHaveBeenCalledWith(
    "A",
    expect.objectContaining({ panel: "model", needsAuthentication: false }),
  );
  expect(h.live!.connectionOutcomeUnknown).toBe(true);
  expect(h.confirmRestored).toHaveBeenCalledOnce();
  expect(props.onStarted).not.toHaveBeenCalled();
});

it("keeps a manual model confirmation's safe detail visible without releasing its failure guard when the picker closes", async () => {
  const before = composerDrafts.read("new");
  startRestore({});
  await vi.advanceTimersByTimeAsync(300);
  const prepared = await settle();
  h.live!.queuePaused = "unavailable";
  h.confirmRestored.mockImplementation(async () => {
    h.live!.configError = STRINGS.repair.confirmConfigFailed;
    h.live!.modelDrift = true;
    throw new ConfigurationConfirmationError(
      "FARFOLD_RESTORE_CONFIRM_IDENTITY_READ",
    );
  });
  await expect(
    (prepared.dialog!.props.onApply as (choice: unknown) => Promise<void>)({
      service: null,
      modelValue: "kept-choice",
    }),
  ).rejects.toThrow(STRINGS.repair.confirmConfigFailed);
  const failed = await settle();
  const detail =
    STRINGS.repair.confirmConfigNativeReasons
      .FARFOLD_RESTORE_CONFIRM_IDENTITY_READ;
  expect(failed.composer.props.note).toEqual({
    message: STRINGS.repair.confirmConfigFailed,
    detail,
  });
  expect(failed.dialog!.props.readError).toEqual({
    message: `${STRINGS.empty.openFailed}：${STRINGS.repair.confirmConfigFailed}`,
    detail,
  });
  (failed.dialog!.props.onClose as () => void)();
  const closed = await settle();
  expect(closed.dialog).toBeUndefined();
  expect(closed.composer.props.note).toEqual(failed.composer.props.note);
  expect(closed.composer.props.disabled).toBe(true);
  expect(h.live!.configError).toBe(STRINGS.repair.confirmConfigFailed);
  expect(h.live!.modelDrift).toBe(true);
  expect(h.live!.queuePaused).toBe("unavailable");
  expect(newConversationChoice.config).toEqual({});
  expect(composerDrafts.read("new")).toBe(before);
  expect(h.confirmRestored).toHaveBeenCalledOnce();
  expect(props.onStarted).not.toHaveBeenCalled();
});

it("keeps the input and saved choice blocked when restored-baseline confirmation fails", async () => {
  const before = composerDrafts.read("new");
  startRestore({ model: "kept-choice" });
  h.confirmRestored.mockRejectedValue(
    new Error(STRINGS.repair.confirmConfigFailed),
  );
  await vi.advanceTimersByTimeAsync(300);
  const failed = await settle();
  expect(h.confirmRestored).toHaveBeenCalledOnce();
  expect(failed.composer.props.disabled).toBe(true);
  expect(failed.composer.props.thread).toBeNull();
  expect(newConversationChoice.config).toEqual({ model: "kept-choice" });
  expect(composerDrafts.read("new")).toBe(before);
  expect(props.onStarted).not.toHaveBeenCalled();
});
it("shows only the fixed local confirmation detail without changing the draft or retry classification", async () => {
  const before = composerDrafts.read("new");
  startRestore({ model: "kept-choice" });
  h.confirmRestored.mockRejectedValue(
    new ConfigurationConfirmationError(
      "busy-before",
      "connectionOutcomeUnknown",
    ),
  );
  await vi.advanceTimersByTimeAsync(300);
  const failed = await settle();
  const notice = failed.composer.props.note as {
    message: string;
    detail: string;
  };
  expect(notice).toEqual({
    message: `${STRINGS.empty.openFailed}：${STRINGS.repair.confirmConfigFailed}`,
    detail: `${STRINGS.repair.confirmConfigReasons["busy-before"]}：${STRINGS.repair.confirmConfigBusyReasons.connectionOutcomeUnknown}。`,
  });
  expect(isConfigurationRestoreNotice(notice)).toBe(false);
  expect(failed.composer.props.disabled).toBe(true);
  expect(failed.composer.props.thread).toBeNull();
  expect(composerDrafts.read("new")).toBe(before);
  expect(newConversationChoice.config).toEqual({ model: "kept-choice" });
  expect(h.confirmRestored).toHaveBeenCalledOnce();
  expect(props.onStarted).not.toHaveBeenCalled();
});
async function expectRestoreFailure(
  copy: string,
  before: ReturnType<typeof composerDrafts.read>,
  choice: Record<string, unknown>,
) {
  await vi.advanceTimersByTimeAsync(300);
  const failed = await settle();
  expect((failed.composer.props.note as { message: string }).message).toContain(
    copy,
  );
  expect(failed.composer.props.disabled).toBe(true);
  expect(failed.composer.props.thread).toBeNull();
  expect(failed.composer.props.sendRequest).toBe(0);
  expect(props.onStarted).not.toHaveBeenCalled();
  expect(newConversationChoice.config).toEqual(choice);
  expect(composerDrafts.read("new")).toBe(before);
  await vi.advanceTimersByTimeAsync(1000);
  render();
  expect(h.open).toHaveBeenCalledTimes(1);
  (failed.composer.props.onGoSettings as () => void)();
  expect(props.onGoSettings).toHaveBeenCalledWith(
    "A",
    expect.objectContaining({ panel: "model" }),
  );
  return failed;
}

it("explains a missing saved mode after restoring modern model and thinking without dropping any key", async () => {
  const choice = {
    model: "kept-choice",
    thought_level: "medium",
    mode: "medium",
  };
  const before = composerDrafts.read("new");
  startRestore({ ...choice });
  await expectRestoreFailure(restoreCopy.missing, before, choice);
  expect(h.setConfig.mock.calls.map((call) => call[1])).toEqual([
    "model",
    "thought_level",
  ]);
});

it("opens model settings from a blocked picker without applying an obsolete saved model", async () => {
  const choice = { __farfold_legacy_model: "qfmodel", mode: "default" };
  const before = composerDrafts.read("new");
  startRestore(choice);
  h.live!.configOptions = [
    { ...configOption("mode", "default", ["default"]), category: "mode" },
  ];
  await vi.advanceTimersByTimeAsync(300);
  const failed = await settle();
  expect(failed.dialog!.props.readError).toMatchObject({
    savedConfigurationRestore: true,
  });
  expect(failed.dialog!.props.existingOption).toBeNull();
  (failed.dialog!.props.onPrepare as () => void)();
  expect(props.onGoSettings).toHaveBeenCalledExactlyOnceWith("A", {
    panel: "model",
    needsAuthentication: false,
    sourceContext: undefined,
  });
  const closed = render();
  expect(closed.dialog).toBeUndefined();
  expect(closed.composer.props.disabled).toBe(true);
  expect(closed.composer.props.sendRequest).toBe(0);
  expect(h.open).toHaveBeenCalledOnce();
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(h.confirmRestored).not.toHaveBeenCalled();
  expect(newConversationChoice.config).toEqual(choice);
  expect(composerDrafts.read("new")).toBe(before);
});

it("explains an unavailable saved select value before calling its setter", async () => {
  const choice = { model: "kept-choice" };
  const before = composerDrafts.read("new");
  startRestore({ ...choice });
  h.live!.configOptions[0].options = [{ value: "initial", name: "Initial" }];
  await expectRestoreFailure(restoreCopy.unavailable, before, choice);
  expect(h.setConfig).not.toHaveBeenCalled();
});

it("explains a setter acknowledgement whose current value does not match the saved choice", async () => {
  const choice = { model: "kept-choice" };
  const before = composerDrafts.read("new");
  startRestore({ ...choice });
  h.setConfig.mockResolvedValue(undefined);
  await expectRestoreFailure(restoreCopy.readback, before, choice);
  expect(h.setConfig).toHaveBeenCalledTimes(1);
});

it("explains a final saved-model mismatch after a later thinking setting", async () => {
  const choice = { model: "kept-choice", thought_level: "medium" };
  const before = composerDrafts.read("new");
  startRestore({ ...choice });
  const restore = h.setConfig.getMockImplementation()!;
  h.setConfig.mockImplementation(async (...args) => {
    await restore(...args);
    if (args[1] === "thought_level")
      h.live!.configOptions[0].currentValue = "initial";
  });
  await expectRestoreFailure(restoreCopy.readback, before, choice);
  expect(h.setConfig).toHaveBeenCalledTimes(2);
});

it("keeps source-unknown setter failure generic and preserves the existing repair route", async () => {
  const choice = { model: "kept-choice" };
  const before = composerDrafts.read("new");
  startRestore({ ...choice });
  h.setConfig.mockRejectedValue(new Error(STRINGS.repair.configFailed));
  const failed = await expectRestoreFailure(
    STRINGS.repair.configFailed,
    before,
    choice,
  );
  expect(
    (failed.composer.props.note as { message: string }).message,
  ).not.toContain("某项已保存设置");
  expect(
    (failed.composer.props.note as { message: string }).message,
  ).not.toContain("选择当前不可用");
  expect(h.setConfig).toHaveBeenCalledTimes(1);
});

it("keeps an opaque setter error behind the existing safe fallback without classifying it", async () => {
  startRestore({ model: "kept-choice" });
  h.setConfig.mockRejectedValue(new Error("CONTROLLED_OPAQUE_SETTER_FAILURE"));
  await vi.advanceTimersByTimeAsync(300);
  const failed = await settle();
  expect((failed.composer.props.note as { message: string }).message).toContain(
    STRINGS.repair.requestFailed,
  );
  expect(
    (failed.composer.props.note as { message: string }).message,
  ).not.toContain("CONTROLLED_OPAQUE_SETTER_FAILURE");
  (failed.composer.props.onGoSettings as () => void)();
  expect(props.onGoSettings).toHaveBeenCalledWith(
    "A",
    expect.objectContaining({ panel: "program" }),
  );
  expect(failed.composer.props.sendRequest).toBe(0);
});

it("restores model first and re-reads its changed thinking options before exposing the unsent draft", async () => {
  const choice = { thought_level: "medium", model: "kept-choice" };
  const before = composerDrafts.read("new");
  startRestore({ ...choice });
  await vi.advanceTimersByTimeAsync(300);
  const prepared = await settle();
  expect(h.setConfig.mock.calls.map((call) => call[1])).toEqual([
    "model",
    "thought_level",
  ]);
  expect(prepared.composer.props.thread).toBe(h.live);
  expect(prepared.composer.props.disabled).toBe(false);
  expect(prepared.composer.props.note).toBeNull();
  expect(prepared.composer.props.sendRequest).toBe(0);
  expect(props.onStarted).not.toHaveBeenCalled();
  expect(newConversationChoice.config).toEqual(choice);
  expect(composerDrafts.read("new")).toBe(before);
});

it("does not expose a late old-pair restore failure on the newly selected prepared draft", async () => {
  let reject!: (error: Error) => void;
  const before = composerDrafts.read("new");
  startRestore({ model: "kept-choice" });
  h.setConfig.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await vi.advanceTimersByTimeAsync(300);
  (
    render().root.find((n) => n.props["aria-label"] === W.agentChoice)!.props
      .onClick as () => void
  )();
  const picker = render().root.find(
    (n) => n.type === NewConversationAgentDialog,
  )!;
  h.live = freshThreadState("prepared-b", "B", "/owned-fixture", "owned-b");
  h.open.mockResolvedValue(h.live);
  (picker.props.onPick as (id: string) => void)("B");
  render();
  await vi.advanceTimersByTimeAsync(300);
  await settle();
  reject(new Error(STRINGS.repair.configFailed));
  const current = await settle();
  expect(current.composer.props.note).toBeNull();
  expect(current.composer.props.thread).toBe(h.live);
  expect(newConversationChoice.agentId).toBe("B");
  expect(composerDrafts.read("new")).toBe(before);
  expect(current.composer.props.sendRequest).toBe(0);
  expect(h.open).toHaveBeenCalledTimes(2);
  expect(h.setConfig).toHaveBeenCalledTimes(1);
});

it("confirms an explicit thought-only action from the actual new-draft control without synthesizing model intent", async () => {
  const before = composerDrafts.read("new");
  startRestore({});
  await vi.advanceTimersByTimeAsync(300);
  const view = await settle();
  const control = view.root.find((node) => node.type === ReasoningControl)!;
  await (
    control.props.onApply as (id: string, value: unknown) => Promise<void>
  )("thought_level", "low");
  expect(h.confirmRestored).toHaveBeenCalledWith("prepared-a", {
    thought_level: "low",
  });
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(newConversationChoice.config).toEqual({ thought_level: "low" });
  expect(composerDrafts.read("new")).toBe(before);
});
it.each(["owner", "source"])(
  "does not publish an explicit choice after late %s change",
  async (reason) => {
    const before = composerDrafts.read("new");
    startRestore({});
    await vi.advanceTimersByTimeAsync(300);
    const view = await settle();
    let release!: () => void;
    h.confirmRestored.mockImplementation(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const control = view.root.find((node) => node.type === ReasoningControl)!;
    const pending = (
      control.props.onApply as (id: string, value: unknown) => Promise<void>
    )("thought_level", "low");
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(h.confirmRestored).toHaveBeenCalledOnce();
    if (reason === "owner")
      h.live = freshThreadState("replacement", "B", "/other", "other-native");
    else h.live!.serviceContext = "changed-source";
    release();
    await expect(pending).rejects.toThrow();
    expect(newConversationChoice.config).toEqual({});
    expect(composerDrafts.read("new")).toBe(before);
    expect(props.onStarted).not.toHaveBeenCalled();
  },
);
