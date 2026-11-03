import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LoadedSearchHit } from "../runtime/loaded_search";

const h = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  frames: [] as (() => void)[],
  range: vi.fn(),
  release: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => void | (() => void)) => h.effects.push(effect),
}));
vi.mock("../runtime/sessions", () => ({
  threads: { getSnapshot: () => ({ threads: new Map() }) },
}));
vi.mock("../runtime/loaded_search", () => ({
  loadedSearchHitIsCurrent: () => true,
}));
vi.mock("../runtime/loaded_search_dom", () => ({
  loadedSearchDOMRange: h.range,
}));
vi.mock("../runtime/transcript_search", () => ({
  revealSearchAncestors: () => h.release,
  hasOpenSearchAncestors: () => true,
  searchDetailsCommitted: () => true,
}));
import { LoadedSearchJump } from "./LoadedSearchJump";

let cleanup: (() => void) | void;
beforeEach(() => {
  vi.clearAllMocks();
  h.effects = [];
  h.frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    h.frames.push(callback),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});

/** The environment supplies independent geometry for a long rendered reply.
 * Centering its paragraph loses the selected line offset. These component
 * controls do not claim real browser layout or installed-app verification. */
function fixture(line: number) {
  const contentTop = 40;
  const lineHeight = 20;
  const contentHeight = 120 * lineHeight;
  const outer = { scrollTop: 37, scrollLeft: 19 };
  const root = {
    isConnected: true,
    parentElement: outer,
    clientTop: 0,
    clientLeft: 0,
    clientHeight: 320,
    clientWidth: 640,
    scrollHeight: contentHeight + 80,
    scrollWidth: 640,
    scrollTop: 0,
    scrollLeft: 0,
    contains: (node: unknown) => node === parent,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ top: 0, bottom: 320, left: 0 }),
    scrollTo(options: ScrollToOptions) {
      this.scrollTop = Math.max(
        0,
        Math.min(
          this.scrollHeight - this.clientHeight,
          options.top ?? this.scrollTop,
        ),
      );
      this.scrollLeft = options.left ?? this.scrollLeft;
    },
  };
  const parent = {
    isConnected: true,
    parentElement: root,
    clientTop: 0,
    clientLeft: 0,
    clientHeight: contentHeight,
    clientWidth: 640,
    scrollHeight: contentHeight,
    scrollWidth: 640,
    scrollTop: 0,
    scrollLeft: 0,
    getClientRects: () => [{ width: 640, height: contentHeight }],
    scrollIntoView() {
      root.scrollTo({
        top: contentTop + (contentHeight - root.clientHeight) / 2,
      });
    },
  };
  const range = {
    startContainer: { parentElement: parent },
    endContainer: { parentElement: parent },
    getBoundingClientRect() {
      const top = contentTop + line * lineHeight - root.scrollTop;
      return {
        top,
        bottom: top + lineHeight,
        left: 0,
        right: 100,
        width: 100,
        height: lineHeight,
      };
    },
    getClientRects() {
      return [this.getBoundingClientRect()];
    },
  };
  const message = {
    focus: vi.fn(),
    classList: { add: vi.fn(), remove: vi.fn() },
  };
  h.range.mockReturnValue({ range, message });
  vi.stubGlobal("getComputedStyle", (node: unknown) => ({
    overflowY: node === root ? "auto" : "visible",
    overflowX: "visible",
  }));
  LoadedSearchJump({
    host: { current: { querySelector: () => root } as unknown as HTMLElement },
    request: { hit: {} as LoadedSearchHit, token: {} },
    revision: 0,
    onClose: vi.fn(),
  });
  cleanup = h.effects[0]();
  h.frames.shift()!();
  h.frames.shift()!();
  return { root, outer, range, message };
}

it.each([
  ["first", 0],
  ["last", 119],
] as const)(
  "positions the exact %s loaded-search match inside a reply taller than the transcript",
  (_name, line) => {
    const { root, outer, range, message } = fixture(line);
    const hit = range.getBoundingClientRect();
    expect.soft(hit.top).toBeGreaterThanOrEqual(0);
    expect.soft(hit.bottom).toBeLessThanOrEqual(root.clientHeight);
    expect(message.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(outer).toEqual({ scrollTop: 37, scrollLeft: 19 });
  },
);
