import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { STRINGS } from "../runtime/strings";

vi.mock("../runtime/browser_surface", () => ({
  useBrowserSurfaceBarrier: (open: boolean) => open,
}));
const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  cursor: 0,
  nextId: 0,
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => {
  const effect = (run: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, i) => !Object.is(value, slot.deps?.[i]))
    ) {
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = run() || undefined;
      });
      slot.deps = deps;
    }
  };
  return {
    ...(await original<typeof import("react")>()),
    useState: (initial: unknown) => {
      const slot = (h.slots[h.cursor++] ??= { value: initial });
      return [
        slot.value,
        (value: unknown) => {
          slot.value =
            typeof value === "function"
              ? (value as (previous: unknown) => unknown)(slot.value)
              : value;
        },
      ];
    },
    useRef: (initial: unknown) =>
      (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
    useId: () =>
      (h.slots[h.cursor++] ??= { value: `picker-${++h.nextId}` }).value,
    useMemo: (read: () => unknown) => read(),
    useEffect: effect,
    useLayoutEffect: effect,
  };
});
vi.mock("react-dom", async (original) => ({
  ...(await original<typeof import("react-dom")>()),
  createPortal: (node: ReactNode) => node,
}));

import { ModelPicker } from "./ModelPicker";
import { WorkspacePopover } from "./WorkspacePopover";

type Element = ReactElement<Record<string, unknown>>;
const elements = (node: ReactNode): Element[] => {
  const result: Element[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    result.push(child, ...elements(child.props.children as ReactNode));
  });
  return result;
};
let active: Host | null;
class Host {
  children: Host[] = [];
  scrollHeight = 240;
  focus = vi.fn(() => {
    active = this;
  });
  scrollIntoView = vi.fn();
  contains(node: unknown): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }
  getBoundingClientRect() {
    return { top: 200, bottom: 240, left: 20, width: 300, height: 240 };
  }
  querySelector = vi.fn(
    (_selector: string): Host | null => this.children[0] ?? null,
  );
}
const listeners = new Map<string, Set<(event: unknown) => void>>();
function mount<P>(component: (props: P) => ReactNode, props: P) {
  const slots: typeof h.slots = [];
  const hosts = new Map<string, Host>();
  const host = (name: string) => {
    if (!hosts.has(name)) hosts.set(name, new Host());
    return hosts.get(name)!;
  };
  const render = () => {
    h.slots = slots;
    h.cursor = 0;
    const tree = elements(component(props));
    for (const node of tree) {
      if (node.props.ref)
        (node.props.ref as { current: Host }).current = host(
          String(node.props.className),
        );
    }
    host("mp").children = [host("mp-btn"), host("mp-search"), host("mp-list")];
    host("mp-list").children = [host("option")];
    for (const run of h.effects.splice(0)) run();
    return tree;
  };
  return {
    props,
    render,
    host,
    unmount: () => {
      for (const slot of slots) slot.cleanup?.();
    },
  };
}
const call = (node: Element, name: string, event?: unknown) =>
  (node.props[name] as (event?: unknown) => void)(event);
function keyboard(key: string, composing = false) {
  return {
    key,
    isComposing: composing,
    nativeEvent: { isComposing: composing },
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };
}
const button = (tree: Element[]) =>
  tree.find((node) => node.props.className === "mp-btn")!;
const search = (tree: Element[]) =>
  tree.find((node) => node.props.className === "mp-search")!;
const options = (tree: Element[]) =>
  tree.filter((node) =>
    String(node.props.className ?? "")
      .split(" ")
      .includes("mp-opt"),
  );
function picker() {
  const props: ComponentProps<typeof ModelPicker> = {
    option: {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "second",
      options: [
        { value: "first", name: "First", group: "Provider one" },
        { value: "second", name: "Second", group: "Provider two" },
        { value: "third", name: "Third", group: "Provider two" },
      ],
    },
    disabled: false,
    onPick: vi.fn(),
  };
  const view = mount(ModelPicker, props);
  call(button(view.render()), "onClick");
  view.render();
  return view;
}
beforeEach(() => {
  active = null;
  listeners.clear();
  h.effects.length = 0;
  vi.stubGlobal("document", { body: new Host() });
  vi.stubGlobal("window", {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener: (name: string, callback: (event: unknown) => void) => {
      const all = listeners.get(name) ?? new Set();
      all.add(callback);
      listeners.set(name, all);
    },
    removeEventListener: (name: string, callback: (event: unknown) => void) =>
      listeners.get(name)?.delete(callback),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("names the searchable list, exposes the committed choice and keeps focus separate from selection", () => {
  const view = picker(),
    tree = view.render();
  const input = search(tree),
    list = tree.find((node) => node.props.role === "listbox");
  expect(input.props["aria-label"]).toBe(STRINGS.switcher.modelSearch);
  expect(input.props.role).toBe("combobox");
  expect(input.props["aria-controls"]).toBe(list?.props.id);
  expect(button(tree).props["aria-expanded"]).toBe(true);
  expect(
    options(tree).map((node) => [node.props.role, node.props["aria-selected"]]),
  ).toEqual([
    ["option", false],
    ["option", true],
    ["option", false],
  ]);
  expect(input.props["aria-activedescendant"]).toBe(options(tree)[0].props.id);
  expect(active).toBe(view.host("mp-search"));
  expect(view.props.onPick).not.toHaveBeenCalled();
  call(button(tree), "onClick");
  const closed = view.render();
  expect(button(closed).props["aria-expanded"]).toBe(false);
  expect(button(closed).props["aria-label"]).toBe("Model: Second");
  view.props.label = "Common title";
  expect(button(view.render()).props["aria-label"]).toBe(
    "Common title: Second",
  );
  call(button(view.render()), "onClick");
  expect(
    view.render().find((node) => node.props.role === "listbox")?.props[
      "aria-label"
    ],
  ).toBe("Common title");
  expect(view.props.option?.name).toBe("Model");
  const another = picker();
  expect(search(another.render()).props["aria-controls"]).not.toBe(
    input.props["aria-controls"],
  );
});

it("moves the active option with arrows and commits only the actual Enter choice", () => {
  const view = picker();
  for (const key of ["ArrowDown", "ArrowDown", "ArrowUp"]) {
    const event = keyboard(key);
    call(search(view.render()), "onKeyDown", event);
    expect(event.defaultPrevented).toBe(true);
  }
  const tree = view.render();
  expect(search(tree).props["aria-activedescendant"]).toBe(
    options(tree)[1].props.id,
  );
  expect(active).toBe(view.host("mp-search"));
  expect(view.props.onPick).not.toHaveBeenCalled();
  call(search(tree), "onKeyDown", keyboard("Enter"));
  expect(view.props.onPick).toHaveBeenCalledExactlyOnceWith("second");
  expect(view.render().some((node) => node.props.role === "listbox")).toBe(
    false,
  );
  expect(active).toBe(view.host("mp-btn"));
});

it("filters to real options and never commits an empty search result", () => {
  const view = picker();
  call(search(view.render()), "onChange", { target: { value: "third" } });
  call(options(view.render())[0], "onClick");
  expect(view.props.onPick).toHaveBeenCalledExactlyOnceWith("third");
  call(button(view.render()), "onClick");
  call(search(view.render()), "onChange", { target: { value: "missing" } });
  const tree = view.render();
  expect(options(tree)).toHaveLength(0);
  expect(search(tree).props["aria-activedescendant"]).toBeUndefined();
  call(search(tree), "onKeyDown", keyboard("ArrowDown"));
  call(search(view.render()), "onKeyDown", keyboard("Enter"));
  expect(view.props.onPick).toHaveBeenCalledTimes(1);
});

it("uses one displayed and keyboard action for repeated values while preserving source descriptions", () => {
  const view = picker();
  view.props.option = {
    ...view.props.option!,
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
  const original = JSON.stringify(view.props.option);
  let tree = view.render();
  expect(options(tree)).toHaveLength(2);
  expect(
    options(tree).filter((node) => node.props["aria-selected"]),
  ).toHaveLength(1);
  const text = (node: ReactNode): string =>
    Children.toArray(node)
      .map((child) =>
        isValidElement<{ children?: ReactNode }>(child)
          ? text(child.props.children)
          : String(child),
      )
      .join("");
  const visible = text(options(tree)[0].props.children as ReactNode);
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
  call(search(tree), "onChange", { target: { value: "Second detail" } });
  tree = view.render();
  expect(options(tree)).toHaveLength(1);
  call(search(tree), "onKeyDown", keyboard("Enter"));
  expect(view.props.onPick).toHaveBeenCalledExactlyOnceWith("auto");
  expect(JSON.stringify(view.props.option)).toBe(original);
});

it("keeps same-name different model values distinguishable and never selects an unknown value", () => {
  const view = picker();
  view.props.option = {
    ...view.props.option!,
    currentValue: "unknown",
    options: [
      { value: "auto-a", name: "Auto" },
      { value: "auto-b", name: "Auto" },
    ],
  };
  const tree = view.render();
  expect(options(tree)).toHaveLength(2);
  expect(
    options(tree).every((node) => node.props["aria-selected"] === false),
  ).toBe(true);
  expect(options(tree)[0].props["aria-label"]).toContain("auto-a");
  expect(options(tree)[1].props["aria-label"]).toContain("auto-b");
  expect(view.props.onPick).not.toHaveBeenCalled();
  call(search(tree), "onKeyDown", keyboard("ArrowDown"));
  call(search(view.render()), "onKeyDown", keyboard("Enter"));
  expect(view.props.onPick).toHaveBeenCalledExactlyOnceWith("auto-b");
});

it("consumes one Escape before the real outer popover handler and restores the picker trigger", () => {
  const outer = mount(WorkspacePopover, {
    title: "Settings",
    label: "Settings",
    children: null,
  });
  call(
    outer.render().find((node) => node.type === "button")!,
    "onClick",
  );
  outer.render();
  const view = picker();
  const event = keyboard("Escape");
  call(search(view.render()), "onKeyDown", event);
  for (const run of listeners.get("keydown") ?? []) run(event);
  expect(outer.render().some((node) => node.props.role === "dialog")).toBe(
    true,
  );
  expect(event.defaultPrevented).toBe(true);
  expect(event.propagationStopped).toBe(true);
  expect(view.render().some((node) => node.props.role === "listbox")).toBe(
    false,
  );
  expect(active).toBe(view.host("mp-btn"));
  expect(view.props.onPick).not.toHaveBeenCalled();
  for (const run of listeners.get("keydown") ?? []) run(keyboard("Escape"));
  expect(outer.render().some((node) => node.props.role === "dialog")).toBe(
    false,
  );
  outer.unmount();
  view.unmount();
});

it("blocks both pointer and keyboard selection when the open picker becomes busy", () => {
  const view = picker();
  view.props.disabled = true;
  const tree = view.render();
  expect(button(tree).props.disabled).toBe(true);
  call(options(tree)[0], "onClick");
  call(search(tree), "onKeyDown", keyboard("Enter"));
  expect(view.props.onPick).not.toHaveBeenCalled();
  expect(options(tree)[0].props["aria-disabled"]).toBe(true);
});

it("leaves composition Enter and Escape to text input without choosing or closing", () => {
  const view = picker();
  for (const key of ["Enter", "Escape"]) {
    call(search(view.render()), "onKeyDown", keyboard(key, true));
    expect(view.props.onPick).not.toHaveBeenCalled();
    expect(search(view.render())).toBeDefined();
  }
});
