import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  layouts: [] as (() => void)[],
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => {
  const effect = (
    queue: (() => void)[],
    setup: () => void | (() => void),
    deps: unknown[],
  ) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (!slot.deps || deps.some((v, i) => v !== slot.deps?.[i])) {
      queue.push(() => {
        slot.cleanup?.();
        slot.cleanup = setup() || undefined;
      });
      slot.deps = deps;
    }
  };
  return {
    ...(await original<typeof import("react")>()),
    useRef: (value: unknown) =>
      (h.slots[h.cursor++] ??= { value: { current: value } }).value,
    useState: (value: unknown) => {
      const slot = (h.slots[h.cursor++] ??= { value });
      return [
        slot.value,
        (next: unknown) => {
          slot.value = next;
        },
      ];
    },
    useLayoutEffect: (setup: () => void | (() => void), deps: unknown[]) =>
      effect(h.layouts, setup, deps),
    useEffect: (setup: () => void | (() => void), deps: unknown[]) =>
      effect(h.effects, setup, deps),
  };
});
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));
import { WorkspaceActionMenu } from "./WorkspaceActionMenu";

class Host {
  isConnected = true;
  hidden = false;
  disabled = false;
  tabIndex = 0;
  parent: Host | null = null;
  children: Host[] = [];
  rect = { top: 60, bottom: 90, right: 300, width: 224, height: 100 };
  focus = vi.fn(() => {
    doc.activeElement = this;
  });
  closest() {
    return this.hidden || this.parent?.hidden ? this : null;
  }
  getClientRects() {
    return this.hidden ? [] : [this.rect];
  }
  getBoundingClientRect() {
    return this.rect;
  }
  matches() {
    return this.disabled;
  }
  contains(node: unknown): boolean {
    return (
      node instanceof Host &&
      (node === this || (node.parent !== null && this.contains(node.parent)))
    );
  }
  querySelectorAll() {
    return this.children;
  }
}
let doc: { activeElement: Host; body: Host };
let anchor: Host, panel: Host, first: Host, last: Host;
const close = vi.fn();
const listeners = new Map<string, Set<(event: unknown) => void>>();
function render(next = anchor) {
  h.cursor = 0;
  const tree = WorkspaceActionMenu({
    anchor: next as unknown as HTMLElement,
    title: "Actions",
    children: null,
    onClose: close,
  }) as ReactElement<{ ref: { current: unknown }; style: unknown }>;
  tree.props.ref.current = panel;
  for (const effect of h.layouts.splice(0)) effect();
  for (const effect of h.effects.splice(0)) effect();
  return tree;
}
function key(key: string, options = {}) {
  const event = {
    key,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...options,
  };
  for (const listener of listeners.get("keydown") ?? []) listener(event);
  return event;
}
function unmount() {
  for (const slot of h.slots) slot.cleanup?.();
}
beforeEach(() => {
  h.slots = [];
  h.layouts = [];
  h.effects = [];
  listeners.clear();
  close.mockClear();
  anchor = new Host();
  panel = new Host();
  first = new Host();
  last = new Host();
  panel.tabIndex = -1;
  panel.children = [first, last];
  first.parent = last.parent = panel;
  doc = { activeElement: anchor, body: new Host() };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: (type: string, callback: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(callback);
    },
    removeEventListener: (type: string, callback: (event: unknown) => void) =>
      listeners.get(type)?.delete(callback),
  });
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

it("focuses visible enabled controls and wraps Tab only inside the menu", () => {
  first.hidden = true;
  render();
  expect(doc.activeElement).toBe(last);
  expect(key("Tab").preventDefault).toHaveBeenCalledOnce();
  first.hidden = false;
  last.focus();
  key("Tab");
  expect(doc.activeElement).toBe(first);
  key("Tab", { shiftKey: true });
  expect(doc.activeElement).toBe(last);
  doc.activeElement = new Host();
  expect(key("Tab").preventDefault).not.toHaveBeenCalled();
  expect(key("Escape").preventDefault).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it("keeps focus contained when all actions are disabled", () => {
  first.disabled = last.disabled = true;
  render();
  expect(doc.activeElement).toBe(panel);
  expect(key("Tab").preventDefault).toHaveBeenCalledOnce();
  expect(doc.activeElement).toBe(panel);
  key("Escape");
  expect(close).toHaveBeenCalledOnce();
});

it("does not dismiss composition and restores only a visible invoking control", () => {
  render();
  key("Escape", { isComposing: true });
  expect(close).not.toHaveBeenCalled();
  key("Escape");
  expect(close).toHaveBeenCalledOnce();
  unmount();
  expect(doc.activeElement).toBe(anchor);
  first.focus();
  anchor.hidden = true;
  unmount();
  expect(doc.activeElement).toBe(first);
});

it("dismisses when its scrolled anchor moves but permits scrolling within the menu", () => {
  render();
  for (const listener of listeners.get("scroll") ?? [])
    listener({ target: panel });
  expect(close).not.toHaveBeenCalled();
  for (const listener of listeners.get("scroll") ?? [])
    listener({ target: doc.body });
  expect(close).toHaveBeenCalledOnce();
});

it("keeps menu and trigger clicks inside, and dismisses on an outside click", () => {
  render();
  const click = (target: Host) => {
    for (const listener of listeners.get("mousedown") ?? [])
      listener({ target });
  };
  click(first);
  click(anchor);
  expect(close).not.toHaveBeenCalled();
  click(doc.body);
  expect(close).toHaveBeenCalledOnce();
});

it("does not restore the previous anchor over a newly focused menu", () => {
  render();
  const next = new Host();
  render(next);
  expect(doc.activeElement).toBe(first);
  expect(anchor.focus).not.toHaveBeenCalled();
  unmount();
  expect(doc.activeElement).toBe(next);
});

it("dismisses a missing or hidden anchor without taking focus", () => {
  anchor.hidden = true;
  render();
  expect(close).toHaveBeenCalledOnce();
  expect(first.focus).not.toHaveBeenCalled();
});

it("repositions a growing command list without moving the user's current focus", () => {
  let resize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  anchor.rect = { ...anchor.rect, top: 430, bottom: 460 };
  render();
  expect(render().props.style).toEqual({ top: 468, left: 76 });
  last.focus();
  panel.rect.height = 300;
  resize();
  expect(render().props.style).toEqual({ top: 122, left: 76 });
  expect(doc.activeElement).toBe(last);
  unmount();
  expect(disconnect).toHaveBeenCalled();
});
