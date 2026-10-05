import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Credential } from "../runtime/credentials";

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

it("stages an existing model and discards it when closed without confirmation", async () => {
  await loaded();
  click("Other");
  expect(props.onApply).not.toHaveBeenCalled();
  expect(props.value.modelValue).toBe("current");
  (render()[0].props.onClose as () => void)();
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(props.onApply).not.toHaveBeenCalled();
  cleanup();
  await loaded();
  expect(button("Current").props["aria-pressed"]).toBe(true);
  expect(button("Other").props["aria-pressed"]).toBe(false);
});

it("groups compatible saved services and only applies the explicitly confirmed model", async () => {
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
  expect(props.onApply).not.toHaveBeenCalled();
  click("使用这个模型");
  await Promise.resolve();
  expect(props.onApply).toHaveBeenCalledWith({
    service: { id: "service", revision: "r1", model: "api-two" },
    modelValue: null,
  });
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("rejects a staged API selection after its service is changed or deleted", async () => {
  await loaded();
  click("api-one");
  h.list.mockResolvedValue([{ ...service, revision: "r2" }]);
  h.listeners.forEach((listener) => listener());
  await loaded();
  expect(button("使用这个模型").props.disabled).toBe(true);
  click("使用这个模型");
  expect(props.onApply).not.toHaveBeenCalled();
  click("api-one");
  expect(button("使用这个模型").props.disabled).toBe(false);
  h.list.mockResolvedValue([{ ...service, deleting: true, revision: "r2" }]);
  h.listeners.forEach((listener) => listener());
  await loaded();
  expect(button("使用这个模型").props.disabled).toBe(true);
  expect(props.onApply).not.toHaveBeenCalled();
});

it("keeps an apply failure visible and prevents duplicate confirmation while saving", async () => {
  await loaded();
  let reject!: (reason: Error) => void;
  props.onApply = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  click("Other");
  const confirm = button("使用这个模型").props.onClick as () => void;
  confirm();
  confirm();
  expect(props.onApply).toHaveBeenCalledTimes(1);
  expect(button("正在应用…").props.disabled).toBe(true);
  (render()[0].props.onClose as () => void)();
  expect(props.onClose).not.toHaveBeenCalled();
  reject(new Error("设置未确认"));
  await Promise.resolve();
  await Promise.resolve();
  expect(
    render().some(
      (node) =>
        node.props.role === "alert" &&
        text(node.props.children as ReactNode) === "设置未确认",
    ),
  ).toBe(true);
  expect(props.onClose).not.toHaveBeenCalled();
  expect(button("使用这个模型").props.disabled).toBe(false);
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
  expect(pick).not.toHaveBeenCalled();
  (row!.props.onClick as () => void)();
  expect(pick).toHaveBeenCalledWith("A");
  expect(prepare).not.toHaveBeenCalled();
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

it("searches a saved service name while keeping the explicit model confirmation", async () => {
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
  expect(props.onApply).not.toHaveBeenCalled();
  click("使用这个模型");
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
