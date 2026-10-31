import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (hooks.slots[hooks.cursor++] ??= { value: initial });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      },
    ];
  },
  useRef: (initial: unknown) =>
    (hooks.slots[hooks.cursor++] ??= { value: { current: initial } }).value,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.cursor++;
    const prior = hooks.slots[index];
    if (!prior || deps.some((value, i) => !Object.is(value, prior.deps?.[i]))) {
      const slot = { deps, cleanup: prior?.cleanup };
      hooks.slots[index] = slot;
      hooks.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
    }
  },
}));

import { ConversationFind } from "./ConversationFind";
import {
  SearchExpansion,
  registerSearchExpansion,
} from "../runtime/transcript_search";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...elements(child.props.children as ReactNode)]
      : [],
  );
}
function render(read: () => ReactNode): Element[] {
  hooks.cursor = 0;
  const tree = read();
  const pending = hooks.effects.splice(0);
  if (pending.length) {
    pending.forEach((effect) => effect());
    return render(read);
  }
  return elements(tree);
}
beforeEach(() => {
  hooks.cursor = 0;
  hooks.slots = [];
  hooks.effects = [];
});
afterEach(() => {
  hooks.slots.forEach((slot) => slot.cleanup?.());
  vi.unstubAllGlobals();
});

function rect(top: number, height: number) {
  return {
    x: 0,
    y: top,
    left: 0,
    right: 640,
    width: 640,
    top,
    bottom: top + height,
    height,
    toJSON() {
      return { top, height };
    },
  };
}

/** Geometry is supplied by the environment, never by the search code. A tall
 * paragraph scrolls with the transcript; a tool pre additionally has its own
 * 240px scrolling viewport, matching styles-thread.css. Calling scrollIntoView
 * on the containing element cannot change that element's own scrollTop.
 * These are component/geometry controls, not a real WebKit layout experiment. */
function geometryFixture(kind: "paragraph" | "tool") {
  const lines = Array.from({ length: 120 }, (_, index) =>
    index === 0 || index === 119 ? "needle" : `ordinary line ${index}`,
  );
  const body = lines.join("\n");
  const lineHeight = 20;
  const contentHeight = lines.length * lineHeight;
  const frames = new Map<number, () => void>();
  const details: HTMLDetailsElement[] = [];
  let mutation: MutationCallback | undefined;
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: MutationCallback) {
        mutation = callback;
      }
      observe() {}
      disconnect() {}
    },
  );

  const root = {
    nodeType: 1,
    tagName: "DIV",
    isConnected: true,
    hidden: false,
    parentElement: null,
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: contentHeight + 80,
    scrollWidth: 640,
    clientHeight: 320,
    clientWidth: 640,
    clientTop: 0,
    clientLeft: 0,
    matches: () => false,
    hasAttribute: () => false,
    classList: { add: vi.fn(), remove: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelectorAll: () => details,
    getBoundingClientRect: () => rect(0, 320),
    getClientRects: () => [rect(0, 320)],
    scrollBy(options: ScrollToOptions) {
      this.scrollTop += options.top ?? 0;
      this.scrollLeft += options.left ?? 0;
    },
    scrollTo(options: ScrollToOptions) {
      this.scrollTop = Math.max(
        0,
        Math.min(
          this.scrollHeight - this.clientHeight,
          options.top ?? this.scrollTop,
        ),
      );
      this.scrollLeft = Math.max(
        0,
        Math.min(
          this.scrollWidth - this.clientWidth,
          options.left ?? this.scrollLeft,
        ),
      );
    },
    contains(node: unknown): boolean {
      return node === root || node === parent || node === text;
    },
    childNodes: [] as unknown[],
  };
  let contentTop = kind === "tool" ? 800 : 40;
  const parent = {
    nodeType: 1,
    tagName: kind === "tool" ? "PRE" : "P",
    isConnected: true,
    hidden: false,
    parentElement: root,
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: contentHeight,
    scrollWidth: 640,
    clientHeight: kind === "tool" ? 240 : contentHeight,
    clientWidth: 640,
    clientTop: 0,
    clientLeft: 0,
    matches: () => false,
    hasAttribute: (name: string) => name === "data-find-block",
    classList: { add: vi.fn(), remove: vi.fn(), contains: () => false },
    childNodes: [] as unknown[],
    getBoundingClientRect() {
      return rect(contentTop - root.scrollTop, this.clientHeight);
    },
    getClientRects() {
      return [this.getBoundingClientRect()];
    },
    scrollBy(options: ScrollToOptions) {
      this.scrollTop += options.top ?? 0;
      this.scrollLeft += options.left ?? 0;
    },
    scrollTo(options: ScrollToOptions) {
      this.scrollTop = Math.max(
        0,
        Math.min(
          this.scrollHeight - this.clientHeight,
          options.top ?? this.scrollTop,
        ),
      );
      this.scrollLeft = Math.max(
        0,
        Math.min(
          this.scrollWidth - this.clientWidth,
          options.left ?? this.scrollLeft,
        ),
      );
    },
    scrollIntoView() {
      root.scrollTop = Math.max(
        0,
        contentTop + (this.clientHeight - root.clientHeight) / 2,
      );
    },
    contains(node: unknown) {
      return node === parent || node === text;
    },
  };
  const text = {
    nodeType: 3,
    data: body,
    textContent: body,
    parentElement: parent,
  };
  parent.childNodes = [text];
  root.childNodes = [parent];
  const ranges: Range[] = [];
  const document = {
    createRange: () => {
      const range = {
        startContainer: text,
        endContainer: text,
        startOffset: 0,
        endOffset: 0,
        commonAncestorContainer: text,
        setStart(node: typeof text, offset: number) {
          this.startContainer = node;
          this.startOffset = offset;
        },
        setEnd(node: typeof text, offset: number) {
          this.endContainer = node;
          this.endOffset = offset;
        },
        getBoundingClientRect() {
          const line = body.slice(0, this.startOffset).split("\n").length - 1;
          return rect(
            contentTop + line * lineHeight - root.scrollTop - parent.scrollTop,
            lineHeight,
          );
        },
        getClientRects() {
          return [this.getBoundingClientRect()];
        },
      };
      ranges.push(range as unknown as Range);
      return range;
    },
  };
  const getComputedStyle = (node: unknown) => ({
    overflowY:
      node === root || (kind === "tool" && node === parent)
        ? "auto"
        : "visible",
    overflowX: "visible",
    scrollBehavior: "auto",
  });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { getComputedStyle });
  vi.stubGlobal("getComputedStyle", getComputedStyle);
  Object.assign(root, { ownerDocument: document });
  Object.assign(parent, { ownerDocument: document });
  const host = {
    current: { querySelector: () => root } as unknown as HTMLElement,
  };
  const read = () => ConversationFind({ host, revision: 1, onClose: vi.fn() });
  const flush = () => {
    for (let guard = 0; guard < 10; guard++) {
      render(read);
      if (!frames.size) return;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback());
    }
    throw new Error("Unexpected nonsettling search frames");
  };
  const start = () => {
    const input = render(read).find((node) => node.type === "input")!;
    (input.props.onChange as (event: unknown) => void)({
      target: { value: "needle" },
    });
    flush();
  };
  const next = () => {
    const button = render(read).find(
      (node) => node.type === "button" && node.props["aria-label"] === "下一处",
    )!;
    (button.props.onClick as () => void)();
    flush();
  };
  return {
    root,
    parent,
    ranges,
    start,
    next,
    read,
    flush,
    details,
    shiftContent: (delta: number) => {
      contentTop += delta;
    },
    mutate: () => mutation?.([], {} as MutationObserver),
  };
}

it("positions the actual first and last match inside a paragraph taller than the transcript", () => {
  const fixture = geometryFixture("paragraph");
  fixture.start();
  expect(fixture.ranges).toHaveLength(2);
  const visible = (range: Range) => {
    const hit = range.getBoundingClientRect();
    const viewport = fixture.root.getBoundingClientRect();
    expect.soft(hit.top).toBeGreaterThanOrEqual(viewport.top);
    expect.soft(hit.bottom).toBeLessThanOrEqual(viewport.bottom);
  };
  visible(fixture.ranges[0]);
  fixture.next();
  visible(fixture.ranges[1]);
});

it("reveals a tail match inside the tool result's own scrolling viewport", () => {
  const fixture = geometryFixture("tool");
  fixture.start();
  expect(fixture.ranges).toHaveLength(2);
  fixture.next();
  const hit = fixture.ranges[1].getBoundingClientRect();
  const viewport = fixture.parent.getBoundingClientRect();
  expect(hit.top).toBeGreaterThanOrEqual(viewport.top);
  expect(hit.bottom).toBeLessThanOrEqual(viewport.bottom);
});

it("waits for a released sibling disclosure to close before positioning, then leaves later scans alone", () => {
  const fixture = geometryFixture("paragraph");
  const sibling = { open: true } as HTMLDetailsElement;
  const model = new SearchExpansion();
  const release = model.reveal();
  const unregister = registerSearchExpansion(sibling, model);
  fixture.details.push(sibling);
  fixture.shiftContent(300);
  const scroll = vi.spyOn(fixture.parent, "scrollIntoView");
  release(); // Requested close, but the preceding React DOM is still open.
  fixture.start();
  expect.soft(scroll).not.toHaveBeenCalled();

  sibling.open = false;
  fixture.shiftContent(-300);
  fixture.mutate();
  fixture.flush();
  expect.soft(scroll).toHaveBeenCalledOnce();
  const hit = fixture.ranges.at(-2)!.getBoundingClientRect();
  const viewport = fixture.root.getBoundingClientRect();
  expect.soft(hit.top).toBeGreaterThanOrEqual(viewport.top);
  expect.soft(hit.bottom).toBeLessThanOrEqual(viewport.bottom);

  fixture.mutate(); // A later revision does not start another navigation.
  fixture.flush();
  expect(scroll).toHaveBeenCalledOnce();
  unregister();
});
