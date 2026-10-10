import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  groups: [{ id: "group", name: "调研资料" }],
  effects: [] as (() => void | (() => void))[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = initial;
    return [
      h.slots[index],
      (next: unknown) => {
        h.slots[index] =
          typeof next === "function" ? next(h.slots[index]) : next;
      },
    ];
  },
  useMemo: (read: () => unknown) => read(),
  useRef: () => ({ current: null }),
  useId: () => "search-test",
  useEffect: (effect: () => void | (() => void)) => h.effects.push(effect),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("../runtime/collections", () => ({
  useCollections: () => ({ groups: h.groups, assignments: { old: "group" } }),
}));
vi.mock("../runtime/sessions", () => ({
  basename: (value: string) => value.split("/").pop(),
  relativeTime: () => "刚刚",
  threads: {
    needsAttention: () => false,
  },
  useThreadsSnapshot: () => ({
    index: [
      {
        id: "new",
        title: "原型验收 0930 · 最近对话",
        agentId: "one",
        cwd: "/active",
        archived: false,
        updatedAt: 2,
      },
      {
        id: "old",
        title: "原型验收 0930 · 旧问题",
        agentId: "two",
        cwd: "/archive/notes",
        archived: true,
        updatedAt: 1,
      },
    ],
    threads: new Map(),
  }),
}));
import { CommandPalette } from "./CommandPalette";
import { STRINGS } from "../runtime/strings";

type Element = ReactElement<Record<string, unknown>>;
const props = {
  agents: [],
  onClose: vi.fn(),
  onSelect: vi.fn(),
  returnFocusRef: undefined as { current: HTMLElement | null } | undefined,
};
function render() {
  h.cursor = 0;
  const elements: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      elements.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(CommandPalette(props));
  return elements;
}
function query(text: string) {
  const input = render().find((node) => node.type === "input")!;
  (input.props.onChange as (event: unknown) => void)({
    target: { value: text },
  });
  return render();
}
beforeEach(() => {
  h.slots = [];
  h.groups = [{ id: "group", name: "调研资料" }];
  h.effects = [];
  props.returnFocusRef = undefined;
  vi.clearAllMocks();
});

it("focuses search after native modal opening and returns to the explicit mouse trigger after closing", () => {
  const events: string[] = [];
  class FocusTarget {
    isConnected = true;
    constructor(readonly name: string) {}
    closest() {
      return null;
    }
    getClientRects() {
      return [{}];
    }
    focus() {
      events.push(this.name);
    }
  }
  const trigger = new FocusTarget("search-trigger");
  props.returnFocusRef = { current: trigger as unknown as HTMLElement };
  vi.stubGlobal("document", { activeElement: new FocusTarget("body") });
  vi.stubGlobal("HTMLElement", FocusTarget);
  try {
    const tree = render();
    const dialog = tree.find((node) => node.type === "dialog")!;
    const input = tree.find((node) => node.type === "input")!;
    (dialog.props.ref as { current: unknown }).current = {
      showModal: () => events.push("showModal", "close-button"),
      close: () => events.push("closeDialog"),
    };
    (input.props.ref as { current: unknown }).current = new FocusTarget(
      "search-input",
    );
    // Search now owns cancellable work and a mounted guard as well as focus.
    const cleanups = h.effects.map((effect) => effect());
    expect(events).toEqual(["showModal", "close-button", "search-input"]);
    expect(cleanups.some((cleanup) => typeof cleanup === "function")).toBe(
      true,
    );
    cleanups.reverse().forEach((cleanup) => cleanup?.());
    expect(events.slice(-2)).toEqual(["closeDialog", "search-trigger"]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps the search surface focused on finding conversations and has an explicit close action", () => {
  const tree = render();
  expect(tree.find((node) => node.type === "h2")?.props.children).toBe(
    STRINGS.palette.title,
  );
  expect(tree.filter((node) => node.props.role === "option")).toHaveLength(2);
  const close = tree.find(
    (node) =>
      node.type === "button" &&
      node.props["aria-label"] === STRINGS.palette.close,
  )!;
  (close.props.onClick as () => void)();
  expect(props.onClose).toHaveBeenCalledOnce();
  expect(props.onSelect).not.toHaveBeenCalled();
});

it.each(["调研资料", "旧问题", "/archive/notes"])(
  "finds the archived conversation by %s and opens it without changing archive state",
  (term) => {
    const tree = query(term);
    expect(tree.filter((node) => node.props.role === "option")).toHaveLength(1);
    expect(
      tree.some(
        (node) =>
          node.type === "small" &&
          Children.toArray(node.props.children as ReactNode)
            .join("")
            .includes("two · 调研资料 · 已归档"),
      ),
    ).toBe(true);
    const option = tree.find((node) => node.props.role === "option")!;
    (option.props.onClick as () => void)();
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "old", archived: true }),
    );
    expect(props.onClose).toHaveBeenCalledOnce();
  },
);

it("uses the current saved group name after a rename", () => {
  expect(query("调研资料").some((node) => node.props.role === "option")).toBe(
    true,
  );
  h.groups = [{ id: "group", name: "产品想法" }];
  expect(render().some((node) => node.props.role === "option")).toBe(false);
  expect(query("产品想法").some((node) => node.props.role === "option")).toBe(
    true,
  );
});

it("searches across Agents and folders independently of the currently open conversation", () => {
  let tree = render();
  expect(
    tree.some((node) => node.props.children === "原型验收 0930 · 最近对话"),
  ).toBe(true);
  expect(
    tree.some((node) => node.props.children === "原型验收 0930 · 旧问题"),
  ).toBe(true);
  tree = query("原型验收 0930");
  expect(tree.filter((node) => node.props.role === "option")).toHaveLength(2);
  tree = query("two");
  const options = tree.filter((node) => node.props.role === "option");
  expect(options).toHaveLength(1);
  (options[0].props.onClick as () => void)();
  expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id: "old",
      agentId: "two",
      cwd: "/archive/notes",
      archived: true,
    }),
  );
});
