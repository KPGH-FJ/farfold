import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Credential } from "../runtime/credentials";
import { ErrorNotice } from "./ErrorNotice";
import { NEW_CONVERSATION_PICKER_STRINGS as S } from "../runtime/new_conversation_picker_strings";
import { STRINGS } from "../runtime/strings";
import { ConfigurationConfirmationError } from "../runtime/configuration_restore_feedback";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  list: vi.fn(),
  capability: vi.fn(),
  listeners: new Set<() => void>(),
  scroll: vi.fn(),
  attached: [] as { current: unknown }[],
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
}));
vi.mock("../runtime/credentials", async (original) => ({
  ...(await original<typeof import("../runtime/credentials")>()),
  listCredentials: h.list,
  getServiceCapabilities: h.capability,
  subscribeCredentialChanges: (listener: () => void) => {
    h.listeners.add(listener);
    return () => h.listeners.delete(listener);
  },
}));

import {
  NewConversationAgentDialog,
  NewConversationModelDialog,
  newConversationPreparationError,
} from "./NewConversationPickers";
import type { AgentCardModel } from "../runtime/agents";
type Element = ReactElement<Record<string, unknown>>;
let props: ComponentProps<typeof NewConversationModelDialog>;
const agent = {
  id: "A",
  name: "Agent A",
  status: "connected",
} as AgentCardModel;
const service: Credential = {
  id: "service",
  label: "Saved service",
  provider: "custom",
  endpoint: "https://example.test",
  apiType: "responses",
  models: ["api-one", "api-two"],
  revision: "r1",
  complete: true,
  deleting: false,
  grants: [],
};
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      result.push(
        child,
        ...nodes(child.props.children as ReactNode),
        ...nodes(child.props.footer as ReactNode),
        ...nodes(child.props.searchField as ReactNode),
      );
  });
  return result;
}
function text(tree: ReactNode): string {
  return Children.toArray(tree)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? text(child.props.children)
        : String(child),
    )
    .join("");
}
function render(component = () => NewConversationModelDialog(props)) {
  for (let pass = 0; pass < 8; pass++) {
    h.cursor = 0;
    const tree = nodes(component());
    for (const ref of h.attached.splice(0)) ref.current = null;
    for (const node of tree) {
      const ref = node.props.ref as { current: unknown } | undefined;
      if (node.type === "button" && ref) {
        ref.current = {
          scrollIntoView: (options: ScrollIntoViewOptions) =>
            h.scroll(node.key, options),
        };
        h.attached.push(ref);
      }
    }
    if (!h.effects.length) return tree;
    for (const effect of h.effects.splice(0)) effect();
  }
  throw new Error("Unexpected render loop");
}
function button(label: string) {
  return render().find(
    (node) =>
      node.type === "button" &&
      text(node.props.children as ReactNode) === label,
  )!;
}
function click(label: string) {
  (button(label).props.onClick as () => void)();
}
async function loaded() {
  render();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  return render();
}
function cleanup() {
  for (const slot of h.slots) slot.cleanup?.();
  h.slots = [];
  h.effects = [];
}
beforeEach(() => {
  cleanup();
  h.scroll.mockClear();
  h.attached = [];
  h.list.mockReset().mockResolvedValue([
    service,
    {
      ...service,
      id: "wrong-format",
      apiType: "messages",
      label: "Not compatible",
    },
  ]);
  h.capability
    .mockReset()
    .mockResolvedValue({ apiTypes: ["responses"], unavailableReason: null });
  props = {
    agent,
    value: { service: null, modelValue: "current" },
    existingOption: {
      id: "model",
      category: "model",
      type: "select",
      name: "Model",
      currentValue: "current",
      options: [
        { value: "current", name: "Current" },
        { value: "other", name: "Other" },
      ],
    },
    onApply: vi.fn().mockResolvedValue(undefined),
    onPrepare: vi.fn(),
    onManageServices: vi.fn(),
    onClose: vi.fn(),
  };
});
afterEach(cleanup);

it.each([false, true])(
  "shows the preparation failure instead of reading or accepting an unknown current model (reading: %s)",
  async (readingModels) => {
    props.existingOption = null;
    props.readingModels = readingModels;
    props.readError = {
      message: "创建会话失败：连接检查超时",
      detail: "AGENT_INITIALIZE_TIMEOUT",
    };
    const tree = await loaded();
    const notice = tree.find((node) => node.type === ErrorNotice);
    expect(notice?.props).toMatchObject(props.readError);
    expect(
      tree.some(
        (node) =>
          node.props.role === "status" &&
          text(node.props.children as ReactNode) === S.readingModels,
      ),
    ).toBe(false);
    expect(button(S.currentModel).props.disabled).toBe(true);
    click(S.currentModel);
    const search = render().find((node) => node.type === "input")!;
    (search.props.onKeyDown as (event: unknown) => void)({
      key: "Enter",
      nativeEvent: { isComposing: false },
      preventDefault: vi.fn(),
    });
    await Promise.resolve();
    expect(props.onApply).not.toHaveBeenCalled();
    click(S.prepare);
    expect(props.onPrepare).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
  },
);

it("blocks stale existing model choices after a preparation failure but keeps an explicit different saved service available", async () => {
  props.readError = { message: "创建会话失败：连接检查超时" };
  await loaded();
  expect(button("Other").props.disabled).toBe(true);
  click("Other");
  const search = render().find((node) => node.type === "input")!;
  (search.props.onKeyDown as (event: unknown) => void)({
    key: "Enter",
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
  });
  await Promise.resolve();
  expect(props.onApply).not.toHaveBeenCalled();
  click("api-two");
  await Promise.resolve();
  await Promise.resolve();
  expect(props.onApply).toHaveBeenCalledExactlyOnceWith({
    service: { id: "service", revision: "r1", model: "api-two" },
    modelValue: null,
  });
});

it("offers model settings when preparation cannot read a saved choice", async () => {
  const restoreNotice = {
    message: STRINGS.repair.savedConfigMissing,
    savedConfigurationRestore: true,
  };
  props.existingOption = null;
  props.readError = newConversationPreparationError(restoreNotice);
  await loaded();
  expect(button(S.currentModel).props.disabled).toBe(true);
  click(S.checkModelSettings);
  expect(props.onPrepare).toHaveBeenCalledOnce();
  expect(props.onApply).not.toHaveBeenCalled();
});

it("clearing a preparation error exposes confirmed options without applying or retrying anything until a click", async () => {
  props.existingOption = null;
  props.readingModels = true;
  props.readError = { message: "创建会话失败：连接检查超时" };
  await loaded();
  props.readError = null;
  props.readingModels = false;
  props.existingOption = {
    id: "model",
    category: "model",
    type: "select",
    name: "Model",
    currentValue: "confirmed",
    options: [{ value: "confirmed", name: "Confirmed" }],
  };
  const tree = render();
  expect(tree.some((node) => node.type === ErrorNotice)).toBe(false);
  expect(button("Confirmed").props.disabled).toBe(false);
  expect(props.onApply).not.toHaveBeenCalled();
  expect(props.onPrepare).not.toHaveBeenCalled();
  click("Confirmed");
  await Promise.resolve();
  expect(props.onApply).toHaveBeenCalledExactlyOnceWith({
    service: null,
    modelValue: "confirmed",
  });
});

it("applies an existing model pick on click and closes, while an unpicked close writes nothing", async () => {
  await loaded();
  click("Other");
  await Promise.resolve();
  await Promise.resolve();
  expect(props.onApply).toHaveBeenCalledExactlyOnceWith({
    service: null,
    modelValue: "other",
  });
  expect(props.onClose).toHaveBeenCalledTimes(1);
  cleanup();
  vi.mocked(props.onApply).mockClear();
  vi.mocked(props.onClose).mockClear();
  await loaded();
  expect(button("Current").props["aria-pressed"]).toBe(true);
  expect(button("Other").props["aria-pressed"]).toBe(false);
  (render()[0].props.onClose as () => void)();
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(props.onApply).not.toHaveBeenCalled();
});

it.each([
  [[], "尚未保存模型 API 服务"],
  [[{ ...service, apiType: "messages" }], "有接口格式不匹配的配置"],
  [[{ ...service, revision: "" }], "有已存服务待完善"],
] satisfies [Credential[], string][])(
  "explains an empty saved-service group without applying settings (%#)",
  async (records, reason) => {
    h.list.mockResolvedValue(records);
    const tree = await loaded();
    expect(
      tree.some(
        (node) =>
          node.type === "p" &&
          text(node.props.children as ReactNode).includes(reason) &&
          text(node.props.children as ReactNode).includes("Responses"),
      ),
    ).toBe(true);
    expect(button("Current")).toBeDefined();
    expect(button("api-one")).toBeUndefined();
    click(S.manageServices);
    expect(props.onManageServices).toHaveBeenCalledOnce();
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onPrepare).not.toHaveBeenCalled();
  },
);

it("groups compatible saved services and applies the clicked model", async () => {
  const tree = await loaded();
  expect(
    tree.some(
      (node) =>
        node.type === "h3" &&
        text(node.props.children as ReactNode) === "Agent A 的已有设置",
    ),
  ).toBe(true);
  expect(
    tree.some(
      (node) =>
        node.type === "small" &&
        text(node.props.children as ReactNode) === "Saved service",
    ),
  ).toBe(true);
  expect(
    tree.some(
      (node) => text(node.props.children as ReactNode) === "Not compatible",
    ),
  ).toBe(false);
  click("api-two");
  await Promise.resolve();
  await Promise.resolve();
  expect(props.onApply).toHaveBeenCalledExactlyOnceWith({
    service: { id: "service", revision: "r1", model: "api-two" },
    modelValue: null,
  });
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("shows one action for a repeated model value while retaining every declared label and group", async () => {
  props.value.modelValue = "auto";
  props.existingOption = {
    ...props.existingOption!,
    currentValue: "auto",
    options: [
      {
        value: "auto",
        name: "Auto",
        group: "First",
        description: "First detail",
      },
      {
        value: "auto",
        name: "Automatic",
        group: "Second",
        description: "Second detail",
      },
      { value: "auto", name: "Auto", group: "Third" },
      { value: "other", name: "Other" },
    ],
  };
  const original = JSON.stringify(props.existingOption);
  const tree = await loaded();
  const choices = tree.filter(
    (node) => node.props["aria-pressed"] !== undefined,
  );
  expect(choices.filter((node) => node.props["aria-pressed"])).toHaveLength(1);
  expect(new Set(choices.map((node) => node.props["data-idx"])).size).toBe(
    choices.length,
  );
  const selected = choices.find((node) => node.props["aria-pressed"])!;
  const visible = text(selected.props.children as ReactNode);
  for (const label of [
    "Auto",
    "Automatic",
    "First",
    "Second",
    "Third",
    "First detail",
    "Second detail",
  ])
    expect(visible).toContain(label);
  (selected.props.onClick as () => void)();
  await Promise.resolve();
  expect(props.onApply).toHaveBeenCalledExactlyOnceWith({
    service: null,
    modelValue: "auto",
  });
  expect(JSON.stringify(props.existingOption)).toBe(original);
});

it("keeps same-name distinct values and service sources separate with searchable identity details", async () => {
  props.value.modelValue = "auto-a";
  props.existingOption = {
    ...props.existingOption!,
    currentValue: "auto-a",
    options: [
      { value: "auto-a", name: "Auto", group: "First" },
      { value: "auto-b", name: "Auto", group: "Second" },
    ],
  };
  h.list.mockResolvedValue([
    { ...service, models: ["auto-a"] },
    { ...service, id: "service-other", revision: "r2", models: ["auto-a"] },
  ]);
  let tree = await loaded();
  const choices = tree.filter(
    (node) => node.props["aria-pressed"] !== undefined,
  );
  expect(choices).toHaveLength(4);
  expect(choices.filter((node) => node.props["aria-pressed"])).toHaveLength(1);
  expect(text(choices[0].props.children as ReactNode)).toContain("auto-a");
  expect(text(choices[1].props.children as ReactNode)).toContain("auto-b");
  const search = tree.find((node) => node.type === "input")!;
  (search.props.onChange as (event: unknown) => void)({
    target: { value: "Second" },
  });
  tree = render();
  expect(
    tree.filter((node) => node.props["aria-pressed"] !== undefined),
  ).toHaveLength(1);
  (
    tree.find((node) => node.type === "input")!.props.onKeyDown as (
      event: unknown,
    ) => void
  )({
    key: "Enter",
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
  });
  await Promise.resolve();
  expect(props.onApply).toHaveBeenCalledExactlyOnceWith({
    service: null,
    modelValue: "auto-b",
  });
});

it("keeps one selected source when two saved services and an existing setting share the model value", async () => {
  props.value = {
    service: { id: "service-other", revision: "r2", model: "current" },
    modelValue: null,
  };
  h.list.mockResolvedValue([
    { ...service, models: ["current", "current"] },
    { ...service, id: "service-other", revision: "r2", models: ["current"] },
  ]);
  const tree = await loaded();
  const choices = tree.filter(
    (node) => node.props["aria-pressed"] !== undefined,
  );
  expect(choices).toHaveLength(4);
  const selected = choices.filter((node) => node.props["aria-pressed"]);
  expect(selected).toHaveLength(1);
  expect(selected[0].props["data-idx"]).toBe(3);
  (selected[0].props.onClick as () => void)();
  await Promise.resolve();
  expect(props.onApply).toHaveBeenCalledExactlyOnceWith({
    service: { id: "service-other", revision: "r2", model: "current" },
    modelValue: null,
  });
});

it("never applies a stale saved selection; a fresh pick uses the current revision", async () => {
  props.value = {
    service: { id: "service", revision: "r1", model: "api-two" },
    modelValue: null,
  };
  await loaded();
  // The saved service changed while the dialog was open.
  h.list.mockResolvedValue([{ ...service, revision: "r2" }]);
  h.listeners.forEach((listener) => listener());
  await loaded();
  expect(
    render().some(
      (node) =>
        node.props.role === "alert" &&
        text(node.props.children as ReactNode) ===
          "所选服务已改变或不可用，请重新选择。",
    ),
  ).toBe(true);
  expect(props.onApply).not.toHaveBeenCalled();
  click("api-two");
  await Promise.resolve();
  await Promise.resolve();
  expect(props.onApply).toHaveBeenCalledExactlyOnceWith({
    service: { id: "service", revision: "r2", model: "api-two" },
    modelValue: null,
  });
  // A deleted service leaves the dialog without applying anything.
  cleanup();
  props.value = {
    service: { id: "service", revision: "r1", model: "api-one" },
    modelValue: null,
  };
  vi.mocked(props.onApply).mockClear();
  vi.mocked(props.onClose).mockClear();
  h.list.mockResolvedValue([{ ...service, deleting: true, revision: "r2" }]);
  await loaded();
  expect(
    render().some(
      (node) =>
        node.props.role === "alert" &&
        text(node.props.children as ReactNode) ===
          "所选服务已改变或不可用，请重新选择。",
    ),
  ).toBe(true);
  expect(props.onApply).not.toHaveBeenCalled();
});

it.each(["local", "private-string", "private-object"] as const)(
  "shows only safe apply feedback for %s failures in the common error surface",
  async (kind) => {
    await loaded();
    const privateCanary = "私密账号目录 PRIVATE_MODEL_KEY_CANARY";
    const failure =
      kind === "local"
        ? new ConfigurationConfirmationError(
            "FARFOLD_RESTORE_CONFIRM_IDENTITY_READ",
          )
        : kind === "private-string"
          ? privateCanary
          : { message: privateCanary, toString: () => privateCanary };
    props.onApply = vi.fn().mockRejectedValue(failure);
    click("Other");
    await Promise.resolve();
    await Promise.resolve();
    const tree = render();
    const notice = tree.find((node) => node.type === ErrorNotice);
    expect(notice?.props.message).toBe(
      kind === "local" ? STRINGS.repair.confirmConfigFailed : S.applyFailed,
    );
    expect(notice?.props.detail).toBe(
      kind === "local"
        ? STRINGS.repair.confirmConfigNativeReasons
            .FARFOLD_RESTORE_CONFIRM_IDENTITY_READ
        : undefined,
    );
    expect(JSON.stringify(notice?.props)).not.toContain(privateCanary);
    expect(button("Other").props.disabled).toBe(false);
    expect(props.onClose).not.toHaveBeenCalled();
    (tree[0].props.onClose as () => void)();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onApply).toHaveBeenCalledOnce();
  },
);

it("keeps an apply failure above the scrollable body with 353 model choices", async () => {
  h.list.mockResolvedValue([]);
  props.existingOption = {
    ...props.existingOption!,
    currentValue: "model-200",
    options: Array.from({ length: 353 }, (_, index) => ({
      value: `model-${index}`,
      name: `Model ${index}`,
    })),
  };
  await loaded();
  props.onApply = vi
    .fn()
    .mockRejectedValue(
      new ConfigurationConfirmationError(
        "FARFOLD_RESTORE_CONFIRM_DISPLAYED_CHANGED",
      ),
    );
  click("Model 200");
  await Promise.resolve();
  await Promise.resolve();
  const picker = render()[0];
  const body = nodes(picker.props.children as ReactNode);
  expect(body.filter((node) => node.type === "button")).toHaveLength(353);
  expect(body.some((node) => node.type === ErrorNotice)).toBe(false);
  const html = renderToStaticMarkup(picker);
  const search = html.indexOf('class="new-choice-search"');
  const error = html.indexOf('class="auth-note error-notice"');
  const scrollable = html.indexOf('class="new-choice-body"');
  expect(search).toBeGreaterThanOrEqual(0);
  expect(error).toBeGreaterThan(search);
  expect(scrollable).toBeGreaterThan(error);
  expect(html.match(/class="auth-note error-notice"/g)).toHaveLength(1);
  expect(html).toContain(
    STRINGS.repair.confirmConfigNativeReasons
      .FARFOLD_RESTORE_CONFIRM_DISPLAYED_CHANGED,
  );
  expect(props.onApply).toHaveBeenCalledOnce();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("keeps an apply failure visible and ignores repeat picks while saving", async () => {
  await loaded();
  let reject!: (reason: Error) => void;
  props.onApply = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  click("Other");
  click("Current");
  expect(props.onApply).toHaveBeenCalledTimes(1);
  (render()[0].props.onClose as () => void)();
  expect(props.onClose).not.toHaveBeenCalled();
  reject(new Error("设置未确认"));
  await Promise.resolve();
  await Promise.resolve();
  expect(
    render().some(
      (node) =>
        node.type === ErrorNotice && node.props.message === S.applyFailed,
    ),
  ).toBe(true);
  expect(props.onClose).not.toHaveBeenCalled();
  click("Other");
  await Promise.resolve();
  await Promise.resolve();
  expect(props.onApply).toHaveBeenCalledTimes(2);
});

it("keeps unprepared Agents out of choices and keeps adding in the discovery entry", () => {
  const pick = vi.fn(),
    prepare = vi.fn();
  const renderAgents = () =>
    render(() =>
      NewConversationAgentDialog({
        cards: [
          agent,
          { ...agent, id: "B", name: "Second", status: "installed" },
          { ...agent, id: "C", name: "Catalog only", status: "none" },
          {
            ...agent,
            id: "retired",
            name: "Retired",
            source: "registry",
            firstBatchVisible: false,
          },
          {
            ...agent,
            id: "custom",
            name: "Custom",
            source: "custom",
            custom: true,
            firstBatchVisible: false,
          },
          {
            ...agent,
            id: "local",
            name: "Local",
            source: "discovered",
            firstBatchVisible: false,
          },
        ],
        picked: "A",
        prepared: (id) => id === "A",
        onPick: pick,
        onPrepare: prepare,
        onClose: vi.fn(),
      }),
    );
  let tree = renderAgents();
  expect(tree.some((node) => node.key === "A")).toBe(true);
  expect(tree.some((node) => node.key === "B")).toBe(false);
  expect(tree.some((node) => node.key === "C")).toBe(false);
  expect(tree.some((node) => node.key === "retired")).toBe(false);
  expect(tree.some((node) => node.key === "custom")).toBe(false);
  expect(tree.some((node) => node.key === "local")).toBe(false);
  (tree.find((node) => node.key === "A")!.props.onClick as () => void)();
  expect(pick).toHaveBeenCalledWith("A");
  const search = tree.find((node) => node.type === "input")!;
  (search.props.onChange as (event: unknown) => void)({
    target: { value: "sec" },
  });
  tree = renderAgents();
  expect(tree.some((node) => node.key === "A")).toBe(false);
  expect(tree.some((node) => node.key === "B")).toBe(false);
  (
    tree.find((node) => node.props.className === "new-agent-discover")!.props
      .onClick as () => void
  )();
  expect(prepare).toHaveBeenCalledWith();
});

it("offers a prepared offline Agent through the same selection dialog", () => {
  const pick = vi.fn();
  const prepare = vi.fn();
  const tree = render(() =>
    NewConversationAgentDialog({
      cards: [{ ...agent, status: "installed" }],
      picked: null,
      prepared: () => true,
      onPick: pick,
      onPrepare: prepare,
      onClose: vi.fn(),
    }),
  );
  const row = tree.find((node) => node.key === "A");
  expect(row).toBeDefined();
  expect(text(row!.props.children as ReactNode)).toContain("可以使用");
  expect(text(row!.props.children as ReactNode)).not.toContain("待命");
  expect(pick).not.toHaveBeenCalled();
  (row!.props.onClick as () => void)();
  expect(pick).toHaveBeenCalledWith("A");
  expect(prepare).not.toHaveBeenCalled();
});

it("distinguishes live connections from saved preparation and retains a released choice", () => {
  const pick = vi.fn();
  const prepare = vi.fn();
  let cards = [
    agent,
    { ...agent, id: "B", name: "Agent B", status: "installed" as const },
  ];
  const renderAgents = () =>
    render(() =>
      NewConversationAgentDialog({
        cards,
        picked: "A",
        prepared: () => true,
        onPick: pick,
        onPrepare: prepare,
        onClose: vi.fn(),
      }),
    );
  let tree = renderAgents();
  const connected = tree.find((node) => node.key === "A")!;
  const standby = tree.find((node) => node.key === "B")!;
  // Connection state stays internal: both usable rows read as ready.
  expect(text(connected.props.children as ReactNode)).toContain("可以使用");
  expect(text(standby.props.children as ReactNode)).toContain("可以使用");
  expect(connected.props["aria-pressed"]).toBe(true);
  expect(standby.props["aria-pressed"]).toBe(false);

  cards = cards.map((card) => ({ ...card, status: "installed" as const }));
  tree = renderAgents();
  const released = tree.find((node) => node.key === "A")!;
  expect(text(released.props.children as ReactNode)).toContain("可以使用");
  expect(text(released.props.children as ReactNode)).not.toContain("待命");
  expect(released.props["aria-pressed"]).toBe(true);
  expect(pick).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  (released.props.onClick as () => void)();
  expect(pick).toHaveBeenCalledExactlyOnceWith("A");
});

it("rechecks preparation before selecting a row that just became unavailable", () => {
  let ready = true;
  const pick = vi.fn();
  const prepare = vi.fn();
  const tree = render(() =>
    NewConversationAgentDialog({
      cards: [agent],
      picked: null,
      prepared: () => ready,
      onPick: pick,
      onPrepare: prepare,
      onClose: vi.fn(),
    }),
  );
  const select = tree.find((node) => node.key === "A")!.props
    .onClick as () => void;
  ready = false;
  select();
  expect(pick).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});

it("filters a large real model list without changing its order, selection or draft application", async () => {
  props.existingOption!.options = Array.from({ length: 400 }, (_, i) => ({
    value: `model-${i}`,
    name: `Model ${i}`,
  }));
  props.existingOption!.currentValue = "model-399";
  props.value.modelValue = "model-399";
  const initial = await loaded();
  const labels = initial.filter(
    (node) => node.props["aria-pressed"] !== undefined,
  );
  expect(labels[0].key).toBe("model-0");
  expect(labels[399].key).toBe("model-399");
  const search = initial.find((node) => node.type === "input")!;
  expect(search).toBeDefined();
  (search.props.onChange as (event: unknown) => void)({
    target: { value: "MODEL 399" },
  });
  let choices = render().filter(
    (node) => node.props["aria-pressed"] !== undefined,
  );
  expect(choices.map((node) => node.key)).toEqual(["model-399"]);
  expect(choices[0].props["aria-pressed"]).toBe(true);
  (search.props.onChange as (event: unknown) => void)({
    target: { value: "unmatched-model" },
  });
  choices = render().filter((node) => node.props["aria-pressed"] !== undefined);
  expect(choices).toHaveLength(0);
  expect(
    render().some(
      (node) =>
        node.props.role === "status" &&
        text(node.props.children as ReactNode).includes("没有符合条件的模型"),
    ),
  ).toBe(true);
  (render()[0].props.onClose as () => void)();
  expect(props.onApply).not.toHaveBeenCalled();
  expect(props.value.modelValue).toBe("model-399");
  cleanup();
  await loaded();
  expect(render().find((node) => node.type === "input")!.props.value).toBe("");
  expect(button("Model 399").props["aria-pressed"]).toBe(true);
});

it("searches a saved service name and applies the clicked model", async () => {
  const initial = await loaded();
  const search = initial.find((node) => node.type === "input")!;
  expect(search).toBeDefined();
  (search.props.onChange as (event: unknown) => void)({
    target: { value: "SAVED SERVICE" },
  });
  expect(
    render()
      .filter((node) => node.props["aria-pressed"] !== undefined)
      .map((node) => node.key),
  ).toEqual(["api-one", "api-two"]);
  click("api-two");
  await Promise.resolve();
  await Promise.resolve();
  expect(props.onApply).toHaveBeenCalledExactlyOnceWith({
    service: { id: "service", revision: "r1", model: "api-two" },
    modelValue: null,
  });
});

it("reveals a late-loaded current model and reveals it again only after search is cleared", async () => {
  props.existingOption = null;
  props.readingModels = true;
  props.value.modelValue = "late-model";
  await loaded();
  expect(h.scroll).not.toHaveBeenCalled();
  props.existingOption = {
    id: "model",
    type: "select",
    category: "model",
    name: "Model",
    currentValue: "late-model",
    options: [
      { value: "first-model", name: "First model" },
      { value: "late-model", name: "Current model" },
    ],
  };
  props.readingModels = false;
  let tree = render();
  expect(h.scroll).toHaveBeenLastCalledWith("late-model", { block: "nearest" });
  h.scroll.mockClear();
  const search = tree.find((node) => node.type === "input")!;
  (search.props.onChange as (event: unknown) => void)({
    target: { value: "first" },
  });
  tree = render();
  expect(tree.some((node) => node.key === "late-model")).toBe(false);
  expect(h.scroll).not.toHaveBeenCalled();
  (search.props.onChange as (event: unknown) => void)({
    target: { value: "" },
  });
  render();
  expect(h.scroll).toHaveBeenLastCalledWith("late-model", { block: "nearest" });
  expect(props.onApply).not.toHaveBeenCalled();
});

it("reveals the current API model only once its saved source has loaded", async () => {
  props.value = {
    service: { id: "service", revision: "r1", model: "api-two" },
    modelValue: null,
  };
  render();
  expect(h.scroll).not.toHaveBeenCalled();
  await loaded();
  expect(h.scroll).toHaveBeenLastCalledWith("api-two", { block: "nearest" });
  expect(button("api-two").props["aria-pressed"]).toBe(true);
  expect(props.onApply).not.toHaveBeenCalled();
});
