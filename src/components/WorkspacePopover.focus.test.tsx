import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";

// These focus cases have no native page; the real close barrier has separate tests.
vi.mock("../runtime/browser_surface", () => ({
  useBrowserSurfaceBarrier: (requested: boolean) => requested,
}));

const h = vi.hoisted(() => ({
  slots: [] as {
    value?: unknown;
    deps?: unknown[];
    cleanup?: () => void;
  }[],
  cursor: 0,
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [
      slot.value,
      (next: unknown) => {
        slot.value =
          typeof next === "function"
            ? (next as (previous: unknown) => unknown)(slot.value)
            : next;
      },
    ];
  },
  useMemo: (read: () => unknown, deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, i) => !Object.is(value, slot.deps?.[i]))
    ) {
      slot.value = read();
      slot.deps = deps;
    }
    return slot.value;
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
  useLayoutEffect: (effect: () => void | (() => void), deps: unknown[]) => {
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
vi.mock("react-dom", async (original) => ({
  ...(await original<typeof import("react-dom")>()),
  createPortal: (node: ReactNode) => node,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));

import { WorkspacePopover } from "./WorkspacePopover";
import { WorkspacePopoverScope } from "./WorkspacePopoverScope";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { PermissionControl } from "./PermissionControl";
import { freshThreadState } from "../runtime/session_projection";

type Element = ReactElement<Record<string, unknown>>;
const elements = (tree: ReactNode): Element[] => {
  const result: Element[] = [];
  Children.forEach(tree, (node) => {
    if (!isValidElement<Record<string, unknown>>(node)) return;
    result.push(node, ...elements(node.props.children as ReactNode));
  });
  return result;
};
function instance<P>(component: (props: P) => ReactNode) {
  const slots: typeof h.slots = [];
  return {
    render(props: P, commit: (tree: Element[]) => void = () => {}) {
      h.slots = slots;
      h.cursor = 0;
      const tree = elements(component(props));
      commit(tree);
      for (const effect of h.effects.splice(0)) effect();
      return tree;
    },
    unmount() {
      for (const slot of slots) slot.cleanup?.();
    },
  };
}

// Minimal host surfaces, not a replacement for browser focus navigation. The
// actual popover/permission/dialog handlers and effects run against these hosts.
class Host {
  isConnected = true;
  child?: Host;
  focus = vi.fn(() => {
    hostDocument.activeElement = this;
  });
  contains(node: unknown): boolean {
    return node === this || Boolean(this.child?.contains(node));
  }
  closest() {
    return null;
  }
  getClientRects() {
    return [{}];
  }
  rect = { top: 100, bottom: 130, left: 100, width: 34, height: 30 };
  scrollHeight = 120;
  getBoundingClientRect() {
    return this.rect;
  }
  querySelector() {
    return this.child;
  }
  querySelectorAll() {
    return [];
  }
}
const body = new Host();
const hostDocument = { body, activeElement: body };
let listeners: Map<string, (event: unknown) => void>;
const click = (element: Element) => (element.props.onClick as () => void)();

function popup(
  props: ComponentProps<typeof WorkspacePopover>,
  geometry?: { trigger?: Partial<Host["rect"]>; panel?: Partial<Host["rect"]> },
) {
  const view = instance(WorkspacePopover);
  const trigger = new Host();
  const option = new Host();
  const panel = new Host();
  trigger.rect = { ...trigger.rect, ...geometry?.trigger };
  panel.rect = { ...panel.rect, width: 344, height: 120, ...geometry?.panel };
  panel.scrollHeight = panel.rect.height;
  panel.child = option;
  let previouslyOpen = false;
  const render = () =>
    view.render(props, (tree) => {
      const button = tree.find((e) => e.type === "button")!;
      (button.props.ref as { current: Host | null }).current = trigger;
      const popup = tree.find((e) => e.props.role === "dialog");
      if (popup) (popup.props.ref as { current: Host | null }).current = panel;
      else if (previouslyOpen && panel.contains(hostDocument.activeElement))
        hostDocument.activeElement = body;
      previouslyOpen = Boolean(popup);
    });
  click(render().find((e) => e.type === "button")!);
  render();
  hostDocument.activeElement = option;
  trigger.focus.mockClear();
  return { ...view, render, trigger, option, panel };
}

beforeEach(() => {
  h.effects.length = 0;
  hostDocument.activeElement = body;
  listeners = new Map();
  vi.stubGlobal("document", hostDocument);
  vi.stubGlobal("HTMLElement", Host);
  vi.stubGlobal("window", {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener: (name: string, callback: (event: unknown) => void) =>
      listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("returns to the explicit opener after a pointer opened a dialog without focusing the button", () => {
  const opener = new Host();
  const cancel = new Host();
  const modal = Object.assign(new Host(), {
    showModal: () => cancel.focus(),
    close: () => {
      hostDocument.activeElement = body;
    },
  });
  const dialog = instance(WorkspaceDialog);
  const props = {
    title: "Shortcuts",
    children: null,
    onClose: vi.fn(),
    returnFocusRef: { current: opener as unknown as HTMLElement },
  };
  dialog.render(props, (nodes) => {
    (nodes[0].props.ref as { current: Host }).current = modal;
  });
  expect(hostDocument.activeElement === cancel).toBe(true);
  dialog.unmount();
  expect(hostDocument.activeElement === opener).toBe(true);
});

it("hands permission selection back to its trigger before the confirmation dialog captures focus", () => {
  const thread = freshThreadState("permission-focus", "a", "/fixture", "own");
  thread.permissionConfigId = "permission";
  thread.configOptions = [
    {
      id: "permission",
      name: "Permission",
      type: "select",
      currentValue: "ask",
      options: [{ value: "ask", name: "Ask" }],
    },
  ];
  const permission = instance(PermissionControl);
  const props = { thread };
  const control = permission
    .render(props)
    .find((e) => e.type === WorkspacePopover)!;
  const menu = popup(control.props as ComponentProps<typeof WorkspacePopover>);
  click(menu.render().find((e) => e.props.className === "permission-choice")!);
  // The option still exists here. Restoration must happen before its unmount,
  // not in a later frame that would steal focus from the new modal.
  expect(hostDocument.activeElement === menu.trigger).toBe(true);
  menu.render();
  const confirmation = permission
    .render(props)
    .find((e) => e.type === WorkspaceDialog)!;
  const cancel = new Host();
  const modal = Object.assign(new Host(), {
    showModal: () => cancel.focus(),
    close: () => {
      hostDocument.activeElement = body;
    },
  });
  const dialog = instance(WorkspaceDialog);
  const tree = dialog.render(
    confirmation.props as ComponentProps<typeof WorkspaceDialog>,
    (nodes) => {
      (nodes[0].props.ref as { current: Host }).current = modal;
    },
  );
  expect(hostDocument.activeElement === cancel).toBe(true);
  const preventDefault = vi.fn(),
    stopPropagation = vi.fn();
  (tree[0].props.onCancel as (event: unknown) => void)({
    target: modal,
    currentTarget: modal,
    preventDefault,
    stopPropagation,
  });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(stopPropagation).toHaveBeenCalledOnce();
  expect(permission.render(props).some((e) => e.type === WorkspaceDialog)).toBe(
    false,
  );
  dialog.unmount();
  expect(hostDocument.activeElement === menu.trigger).toBe(true);
  menu.unmount();
});

it.each(["mousedown", "resize", "focusin"])(
  "does not take focus from the current target on %s dismissal",
  (kind) => {
    const menu = popup({ title: "Options", label: "Options", children: null });
    const outside = new Host();
    outside.focus();
    listeners.get(kind)!({ target: outside });
    expect(menu.render().some((e) => e.props.role === "dialog")).toBe(false);
    menu.unmount();
    expect(hostDocument.activeElement === outside).toBe(true);
    expect(menu.trigger.focus).not.toHaveBeenCalled();
  },
);

it("preserves a later explicit navigation focus after close and unmount", () => {
  const nextPage = new Host();
  const menu = popup({
    title: "Options",
    label: "Options",
    children: (close) => (
      <button
        onClick={() => {
          close();
          nextPage.focus();
        }}
      >
        Open settings
      </button>
    ),
  });
  click(menu.render().find((e) => e.props.children === "Open settings")!);
  menu.render();
  menu.unmount();
  expect(hostDocument.activeElement === nextPage).toBe(true);
});

it("keeps Escape restoring the trigger without a later focus task", () => {
  const menu = popup({ title: "Options", label: "Options", children: null });
  const event = { key: "Escape", preventDefault: vi.fn() };
  listeners.get("keydown")!(event);
  menu.render();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(hostDocument.activeElement === menu.trigger).toBe(true);
  menu.unmount();
  expect(hostDocument.activeElement === menu.trigger).toBe(true);
});

function position(menu: ReturnType<typeof popup>) {
  return menu.render().find((node) => node.props.role === "dialog")!.props
    .style;
}

it("places a short panel directly above a low trigger using its actual height", () => {
  const menu = popup(
    { title: "Options", label: "Options", children: null },
    { trigger: { top: 700, bottom: 734 }, panel: { height: 112 } },
  );
  expect(position(menu)).toEqual({ top: 580, left: 100, maxHeight: 360 });
  menu.unmount();
});

it("places a short panel below its trigger when it fits, including in the lower half", () => {
  const menu = popup(
    { title: "Options", label: "Options", children: null },
    { trigger: { top: 460, bottom: 494 } },
  );
  expect(position(menu)).toEqual({ top: 502, left: 100, maxHeight: 286 });
  menu.unmount();
});

it("keeps tall content within a short viewport and clamps the right edge", () => {
  window.innerHeight = 320;
  const menu = popup(
    { title: "Options", label: "Options", children: null },
    { trigger: { top: 170, bottom: 204, left: 960 }, panel: { height: 600 } },
  );
  expect(position(menu)).toEqual({ top: 12, left: 644, maxHeight: 150 });
  menu.unmount();
});

it("keeps scrolling inside the options open and dismisses when the underlying page moves", () => {
  const menu = popup({ title: "Options", label: "Options", children: null });
  listeners.get("scroll")!({ target: menu.panel });
  expect(menu.render().some((node) => node.props.role === "dialog")).toBe(true);
  listeners.get("scroll")!({ target: body });
  expect(menu.render().some((node) => node.props.role === "dialog")).toBe(
    false,
  );
  menu.unmount();
});

it("does not dismiss an in-progress input composition on Escape", () => {
  const menu = popup({ title: "Options", label: "Options", children: null });
  const event = { key: "Escape", isComposing: true, preventDefault: vi.fn() };
  listeners.get("keydown")!(event);
  expect(menu.render().some((node) => node.props.role === "dialog")).toBe(true);
  expect(event.preventDefault).not.toHaveBeenCalled();
  menu.unmount();
});

it("keeps registered child menu events inside the parent until that child unregisters", () => {
  const view = popup({ title: "Parent", label: "Open", children: null });
  const provider = () =>
    view.render().find((node) => node.type === WorkspacePopoverScope.Provider)!;
  const scope = provider().props.value as {
    register: (element: HTMLElement) => () => void;
  };
  const child = new Host();
  const input = new Host();
  child.child = input;
  expect(view.panel.contains(input)).toBe(false);
  const unregister = scope.register(child as unknown as HTMLElement);
  expect((provider().props.value as typeof scope).register).toBe(
    scope.register,
  );
  for (const kind of ["mousedown", "focusin", "scroll"]) {
    listeners.get(kind)?.({ target: input });
    expect(view.render().some((node) => node.props.role === "dialog")).toBe(
      true,
    );
  }
  unregister();
  listeners.get("focusin")?.({ target: input });
  expect(view.render().some((node) => node.props.role === "dialog")).toBe(
    false,
  );
  view.unmount();
});
