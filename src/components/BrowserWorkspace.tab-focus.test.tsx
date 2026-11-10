import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { BrowserTabs } from "../runtime/browser_tabs";
import {
  createBrowserWorkspaceClient,
  type BrowserWorkspaceTabsState,
} from "../runtime/browser_workspace";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as {
    deps?: readonly unknown[];
    value?: unknown;
    cleanup?: () => void;
  }[],
  pending: [] as (() => void)[],
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  function slot(deps?: readonly unknown[]) {
    const current = (hooks.slots[hooks.cursor++] ??= {});
    const changed =
      !current.deps || deps?.some((value, i) => value !== current.deps?.[i]);
    if (changed) current.deps = deps;
    return { current, changed };
  }
  function effect(callback: () => void | (() => void), deps: unknown[]) {
    const { current, changed } = slot(deps);
    if (changed)
      hooks.pending.push(() => {
        current.cleanup?.();
        current.cleanup = callback() || undefined;
      });
  }
  return {
    ...actual,
    useId: () => "tab-focus",
    useMemo: (create: () => unknown, deps: unknown[]) => {
      const { current, changed } = slot(deps);
      if (changed) current.value = create();
      return current.value;
    },
    useState: (initial: unknown) => [initial, vi.fn()],
    useRef: (value: unknown) => {
      const { current } = slot();
      return (current.value ??= { current: value });
    },
    useEffect: effect,
    useLayoutEffect: effect,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
      snapshot(),
  };
});

import { BrowserWorkspace } from "./BrowserWorkspace";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(node, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      result.push(child, ...elements(child.props.children as ReactNode));
  });
  return result;
}

class Button {
  disabled = false;
  isConnected = true;
  get ownerDocument() {
    return page;
  }
  focus() {
    if (this.disabled || !this.isConnected) return;
    page.activeElement = this;
    for (const listener of focusListeners) listener({ target: this });
  }
}

const body = new Button();
const documentElement = new Button();
const outside = new Button();
const focusListeners = new Set<(event: { target: Button }) => void>();
const page = {
  activeElement: body,
  body,
  documentElement,
  hasFocus: () => true,
  addEventListener: (
    name: string,
    listener: (event: { target: Button }) => void,
  ) => {
    if (name === "focusin") focusListeners.add(listener);
  },
  removeEventListener: (
    name: string,
    listener: (event: { target: Button }) => void,
  ) => {
    if (name === "focusin") focusListeners.delete(listener);
  },
};
const hosts = new Map<string, Button>();
function host(key: string) {
  let button = hosts.get(key);
  if (!button) hosts.set(key, (button = new Button()));
  return button;
}

function fixture(names = ["a.html", "b.html"]) {
  const taskKey = "test-owner";
  const state: BrowserWorkspaceTabsState = {
    taskKey,
    pages: [],
    selection: { label: null, revision: 0 },
  };
  let acknowledgeClose!: () => void;
  let rejectClose!: (error: Error) => void;
  const closeReply = new Promise<void>((resolve, reject) => {
    acknowledgeClose = resolve;
    rejectClose = reject;
  });
  const client = {
    ...createBrowserWorkspaceClient(vi.fn(), vi.fn(), vi.fn()),
    tabs: vi.fn(async () => structuredClone(state)),
    listenTabsChanged: vi.fn(async () => () => {}),
    select: vi.fn(async ({ label }: { label: string | null }) => {
      state.selection = { label, revision: state.selection.revision + 1 };
      return structuredClone(state);
    }),
    open: vi.fn(async ({ url: name }: { url: string }) => {
      const entry = {
        taskKey,
        label: name,
        localFileName: name,
        url: "",
        phase: "ready" as const,
        revision: 0,
      };
      state.pages.push(entry);
      return entry;
    }),
    close: vi.fn(async ({ label }: { label: string }) => {
      await closeReply;
      state.pages = state.pages.filter((entry) => entry.label !== label);
      if (state.selection.label === label)
        state.selection = {
          label: null,
          revision: state.selection.revision + 1,
        };
    }),
  };
  const props = { taskKey, active: true, client };
  const render = (
    patch: Partial<typeof props> & { visible?: boolean } = {},
  ) => {
    hooks.cursor = 0;
    const tree = elements(BrowserWorkspace({ ...props, ...patch }));
    const group = tree.find((node) => node.props.role === "tablist");
    const controls = new Map<string, { button: Button; node: Element }>();
    for (const node of tree) {
      if (node.type !== "button") continue;
      const key =
        node.props.role === "tab"
          ? String(node.props.title)
          : String(node.props["aria-label"]);
      const button = host(key);
      button.disabled = Boolean(node.props.disabled);
      button.isConnected = true;
      controls.set(key, { button, node });
    }
    for (const [key, button] of hosts) {
      button.isConnected = controls.has(key);
      // WebKit returns focus to the page if the focused control is removed or
      // disabled. Apply the same boundary before layout effects.
      if (
        page.activeElement === button &&
        (!button.isConnected || button.disabled)
      )
        page.activeElement = body;
    }
    const groupRef = group?.props.ref as
      | { current: { querySelector: () => Button | undefined } | null }
      | undefined;
    if (groupRef)
      groupRef.current = {
        querySelector: () =>
          [...controls.values()].find(
            ({ node }) =>
              node.props.role === "tab" && node.props["aria-selected"] === true,
          )?.button,
      };
    for (const effect of hooks.pending.splice(0)) effect();
    return controls;
  };
  const tabs = () => hooks.slots[0].value as BrowserTabs;
  async function start() {
    render();
    await vi.waitFor(() => expect(tabs().getSnapshot().ready).toBe(true));
    for (const [index, name] of names.entries()) {
      if (index) await tabs().add();
      await tabs()
        .pageClient(tabs().getSnapshot().selected)
        .open({
          taskKey,
          url: name,
          bounds: { x: 0, y: 0, width: 1, height: 1 },
        });
    }
    render();
  }
  function beginClose(focused = true) {
    const key = `关闭网页：${names.at(-1)}`;
    const control = render().get(key)!;
    if (focused) control.button.focus();
    const click = control.node.props.onClick as (event: {
      currentTarget: Button;
    }) => void;
    click({ currentTarget: control.button });
    render();
    return control.button;
  }
  async function settle(error = false) {
    if (error) rejectClose(Error("native close rejected"));
    else acknowledgeClose();
    await vi.waitFor(() => expect(tabs().getSnapshot().changing).toBe(false));
    return render();
  }
  return { start, beginClose, settle, render, client, acknowledgeClose };
}

beforeEach(() => {
  hooks.slots = [];
  hooks.pending = [];
  hosts.clear();
  focusListeners.clear();
  page.activeElement = body;
});
afterEach(() => {
  for (const slot of hooks.slots) slot.cleanup?.();
});

it("moves focus from an acknowledged tab close to the selected surviving tab", async () => {
  const f = fixture();
  await f.start();
  f.beginClose();
  const buttons = await f.settle();
  expect(buttons.has("b.html")).toBe(false);
  expect(buttons.get("a.html")?.node.props["aria-selected"]).toBe(true);
  expect(f.client.close).toHaveBeenCalledExactlyOnceWith({
    taskKey: "test-owner",
    label: "b.html",
  });
  expect(page.activeElement).toBe(buttons.get("a.html")?.button);
});

it("focuses the selected blank tab after closing the only page", async () => {
  const f = fixture(["a.html"]);
  await f.start();
  f.beginClose();
  const buttons = await f.settle();
  expect(buttons.has("a.html")).toBe(false);
  expect(buttons.get("新网页")?.node.props["aria-selected"]).toBe(true);
  expect(page.activeElement).toBe(buttons.get("新网页")?.button);
});

it("keeps a focused close operable if native close is rejected", async () => {
  const f = fixture();
  await f.start();
  const button = f.beginClose();
  expect(page.activeElement).toBe(button);
  expect(f.render().get("关闭网页：b.html")?.node.props["aria-disabled"]).toBe(
    true,
  );
  f.beginClose();
  const buttons = await f.settle(true);
  expect(f.client.close).toHaveBeenCalledOnce();
  expect(buttons.get("关闭网页：b.html")?.button).toBe(button);
  expect(
    buttons.get("关闭网页：b.html")?.node.props["aria-disabled"],
  ).toBeUndefined();
  expect(button.disabled).toBe(false);
  expect(page.activeElement).toBe(button);
});

it("does not take focus after the user moved away during the close", async () => {
  const f = fixture();
  await f.start();
  f.beginClose();
  outside.focus();
  page.activeElement = body;
  await f.settle();
  expect(page.activeElement).toBe(body);
});

it("does not restore focus after the workspace was hidden and reopened", async () => {
  const f = fixture();
  await f.start();
  f.beginClose();
  f.render({ visible: false });
  page.activeElement = body;
  await f.settle();
  expect(page.activeElement).toBe(body);
});

it("does not restore focus into a replacement workspace when the old close returns", async () => {
  const f = fixture();
  await f.start();
  f.beginClose();
  await vi.waitFor(() => expect(f.client.close).toHaveBeenCalledOnce());
  f.render({ taskKey: "next-owner" });
  page.activeElement = body;
  f.acknowledgeClose();
  await f.client.close.mock.results[0]?.value;
  f.render({ taskKey: "next-owner" });
  expect(page.activeElement).toBe(body);
});

it("does not move focus if closing a tab did not start from the focused control", async () => {
  const f = fixture();
  await f.start();
  f.beginClose(false);
  await f.settle();
  expect(page.activeElement).toBe(body);
});
