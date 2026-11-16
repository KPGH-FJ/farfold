import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

const hooks = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  cursor: 0,
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => {
    const slot = (hooks.slots[hooks.cursor++] ??= { value });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = next;
      },
    ];
  },
  useRef: (value: unknown) =>
    (hooks.slots[hooks.cursor++] ??= { value: { current: value } }).value,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (hooks.slots[hooks.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, i) => !Object.is(value, slot.deps?.[i]))
    ) {
      hooks.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
      slot.deps = deps;
    }
  },
}));
vi.mock("../runtime/sessions", () => ({
  threads: { closeArtifactPane: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

import { ArtifactPane } from "./ArtifactPane";
import { invoke } from "@tauri-apps/api/core";
import { threads } from "../runtime/sessions";
import { freshThreadState } from "../runtime/session_projection";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    result.push(child, ...elements(child.props.children as ReactNode));
  });
  return result;
}

// Run the real effects against bounded DOM hosts. Installation checks still
// need to exercise actual WebKit focus and the responsive CSS together.
class Host {
  inert = false;
  hidden = false;
  isConnected = true;
  parent: Host | null = null;
  focus = vi.fn(() => {
    doc.activeElement = this;
  });
  contains(target: unknown): boolean {
    return (
      target instanceof Host &&
      (target === this || this.contains(target.parent))
    );
  }
  closest(selector: string) {
    if (selector === ".conversation-workspace") return layout;
    return this.hidden || this.parent?.hidden ? this : null;
  }
  getClientRects() {
    return this.hidden || this.parent?.hidden ? [] : [{}];
  }
  querySelector(selector: string) {
    return selector === ".thread-main" ? main : close;
  }
}
let body: Host, layout: Host, main: Host, pane: Host, opener: Host, close: Host;
let doc: {
  activeElement: Host;
  body: Host;
  querySelector: ReturnType<typeof vi.fn>;
};
let narrow: boolean;
let mediaChange: (() => void) | undefined;
let keydown: ((event: unknown) => void) | undefined;
const thread = freshThreadState("artifact-focus", "agent", "/notes", "native");

function render(
  active = true,
  returnFocusRef?: { current: HTMLElement | null },
  open = true,
) {
  hooks.cursor = 0;
  const tree = elements(ArtifactPane({ thread, active, returnFocusRef, open }));
  for (const node of tree) {
    const ref = node.props.ref as { current: Host | null } | undefined;
    if (ref && node.type === "aside") ref.current = pane;
    if (ref && node.props.className === "a-close") ref.current = close;
  }
  for (const effect of hooks.effects.splice(0)) effect();
  return tree;
}
function unmount() {
  for (const slot of hooks.slots) slot.cleanup?.();
}

beforeEach(() => {
  hooks.slots = [];
  hooks.effects = [];
  body = new Host();
  layout = new Host();
  main = new Host();
  pane = new Host();
  opener = new Host();
  close = new Host();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "settings_get" ? 560 : undefined,
  );
  main.parent = pane.parent = layout;
  opener.parent = main;
  close.parent = pane;
  doc = {
    body,
    activeElement: opener,
    querySelector: vi.fn().mockReturnValue(null),
  };
  narrow = true;
  mediaChange = keydown = undefined;
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", Host);
  vi.stubGlobal("HTMLInputElement", class {});
  vi.stubGlobal("HTMLTextAreaElement", class {});
  vi.stubGlobal("window", {
    matchMedia: () => ({
      get matches() {
        return narrow;
      },
      addEventListener: (_: string, listener: () => void) => {
        mediaChange = listener;
      },
      removeEventListener: vi.fn(),
    }),
    addEventListener: (name: string, listener: (event: unknown) => void) => {
      if (name === "keydown") keydown = listener;
    },
    removeEventListener: vi.fn(),
  });
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(threads.closeArtifactPane).mockClear();
});

it("moves focus into narrow content and makes the covered conversation inert until close", () => {
  render();
  expect(main.inert).toBe(true);
  expect(doc.activeElement === close).toBe(true);
  unmount();
  expect(main.inert).toBe(false);
  expect(doc.activeElement === opener).toBe(true);
});

it("keeps wide content nonmodal and restores the invoking control after using the pane", () => {
  narrow = false;
  render();
  expect(main.inert).toBe(false);
  expect(doc.activeElement === opener).toBe(true);
  close.focus();
  unmount();
  expect(doc.activeElement === opener).toBe(true);
});

it("returns Escape to the explicit pointer opener even when the browser left focus on body", () => {
  doc.activeElement = body;
  const returnFocusRef = { current: opener as unknown as HTMLElement };
  render(true, returnFocusRef);
  expect(doc.activeElement === close).toBe(true);
  keydown?.({ key: "Escape", target: close });
  expect(threads.closeArtifactPane).toHaveBeenCalledWith(thread.key);
  unmount();
  expect(doc.activeElement === opener).toBe(true);
});

it("returns focus after a narrow pane hides and the covered control can receive focus", () => {
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  const returnFocusRef = { current: opener as unknown as HTMLElement };
  render(true, returnFocusRef);
  pane.hidden = true;
  doc.activeElement = body;
  // A covered control can remain unfocusable until WebKit updates the layout.
  opener.focus.mockImplementation(() => {});
  render(true, returnFocusRef, false);
  expect(main.inert).toBe(false);
  expect(frame).toBeDefined();
  opener.focus.mockImplementation(() => {
    doc.activeElement = opener;
  });
  frame?.(0);
  expect(doc.activeElement).toBe(opener);
});

it("keeps the explicit opener across breakpoint and in-pane scope changes", () => {
  narrow = false;
  const returnFocusRef = { current: opener as unknown as HTMLElement };
  render(true, returnFocusRef);
  const other = new Host();
  other.parent = main;
  other.focus();
  narrow = true;
  mediaChange?.();
  thread.artifactPaneTarget = { roundId: "round", selected: null };
  render(true, returnFocusRef);
  unmount();
  expect(doc.activeElement === opener).toBe(true);
  thread.artifactPaneTarget = null;
});

it.each(["hidden", "disconnected"])(
  "does not restore an explicit opener that is %s",
  (state) => {
    doc.activeElement = body;
    render(true, { current: opener as unknown as HTMLElement });
    if (state === "hidden") main.hidden = true;
    else opener.isConnected = false;
    unmount();
    expect(opener.focus).not.toHaveBeenCalled();
  },
);

it("tracks width changes while open without leaving a wide conversation inert", () => {
  narrow = false;
  render();
  narrow = true;
  mediaChange?.();
  expect(main.inert).toBe(true);
  expect(doc.activeElement === close).toBe(true);
  narrow = false;
  mediaChange?.();
  expect(main.inert).toBe(false);
});

it("restores the saved width and persists keyboard or completed pointer resizing", async () => {
  narrow = false;
  const separator = () =>
    render().find((node) => node.props.role === "separator")!;
  await vi.waitFor(() => expect(separator().props["aria-valuenow"]).toBe(560));
  (separator().props.onKeyDown as (event: unknown) => void)({
    key: "ArrowLeft",
    preventDefault: vi.fn(),
  });
  const writes = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "settings_set");
  await vi.waitFor(() =>
    expect(writes().at(-1)).toEqual([
      "settings_set",
      { key: "artifactPaneWidth", value: 584 },
    ]),
  );

  const pointer = (name: string, clientX: number) =>
    (separator().props[name] as (event: unknown) => void)({
      button: 0,
      pointerId: 1,
      clientX,
      preventDefault: vi.fn(),
      currentTarget: { setPointerCapture: vi.fn() },
    });
  const previousWrites = writes().length;
  pointer("onPointerDown", 250);
  pointer("onPointerMove", 220);
  expect(separator().props["aria-valuenow"]).toBe(614);
  expect(writes()).toHaveLength(previousWrites);
  pointer("onPointerCancel", 220);
  expect(separator().props["aria-valuenow"]).toBe(584);
  expect(writes()).toHaveLength(previousWrites);
  pointer("onPointerDown", 250);
  pointer("onPointerMove", 200);
  pointer("onPointerUp", 200);
  await vi.waitFor(() =>
    expect(writes().at(-1)).toEqual([
      "settings_set",
      { key: "artifactPaneWidth", value: 634 },
    ]),
  );

  unmount();
  hooks.slots = [];
  expect(separator().props["aria-valuenow"]).toBe(634);
});

it("releases the covered conversation without restoring focus into a hidden route", () => {
  render();
  main.hidden = true;
  render(false);
  expect(main.inert).toBe(false);
  expect(opener.focus).not.toHaveBeenCalled();
});

it("does not steal focus from a different visible route on close", () => {
  render();
  const other = new Host();
  other.focus();
  unmount();
  expect(doc.activeElement === other).toBe(true);
});

it("does not dismiss content while Escape belongs to Chinese composition or a native dialog", () => {
  render();
  keydown?.({ key: "Escape", isComposing: true, target: close });
  expect(threads.closeArtifactPane).not.toHaveBeenCalled();
  doc.querySelector.mockImplementation((selector: string) =>
    selector.includes("dialog[open]") ? {} : null,
  );
  keydown?.({ key: "Escape", target: close });
  expect(threads.closeArtifactPane).not.toHaveBeenCalled();
});
