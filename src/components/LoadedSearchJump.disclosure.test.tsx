import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LoadedSearchHit } from "../runtime/loaded_search";
import {
  SearchExpansion,
  registerSearchExpansion,
} from "../runtime/transcript_search";

const h = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  frames: new Map<number, () => void>(),
  nextFrame: 0,
  mutations: new Set<() => void>(),
  statuses: [] as unknown[],
  current: true,
  range: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [
    value,
    (next: unknown) => h.statuses.push(next),
  ],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => void | (() => void)) => h.effects.push(effect),
}));
vi.mock("../runtime/sessions", () => ({
  threads: { getSnapshot: () => ({ threads: new Map() }) },
}));
vi.mock("../runtime/loaded_search", () => ({
  loadedSearchHitIsCurrent: () => h.current,
}));
vi.mock("../runtime/loaded_search_dom", () => ({
  loadedSearchDOMRange: h.range,
}));
import { LoadedSearchJump } from "./LoadedSearchJump";

let cleanup: void | (() => void);
let unregister: (() => void)[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  h.effects = [];
  h.frames.clear();
  h.nextFrame = 0;
  h.mutations.clear();
  h.statuses = [];
  h.current = true;
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    h.frames.set(++h.nextFrame, fn);
    return h.nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => h.frames.delete(id));
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(private notify: () => void) {}
      observe() {
        h.mutations.add(this.notify);
      }
      disconnect() {
        h.mutations.delete(this.notify);
      }
    },
  );
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  unregister.forEach((fn) => fn());
  unregister = [];
  vi.unstubAllGlobals();
});
function frame() {
  const next = h.frames.entries().next().value;
  expect(next).toBeDefined();
  const [id, fn] = next!;
  h.frames.delete(id);
  fn();
}
function notify() {
  for (const fn of h.mutations) fn();
}

/** Independent disclosure commits and cached geometry, with the real common
 * expansion ownership/readiness rules. No browser or installed-app claim. */
function subject(siblingPending = false) {
  type Node = {
    parentElement: Node | null;
    tagName: string;
    hidden: boolean;
    isConnected: boolean;
  };
  const root = {
    tagName: "DIV",
    hidden: false,
    isConnected: true,
    parentElement: null,
    clientHeight: 0,
    clientWidth: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    contains(node: Node | null) {
      for (let n = node; n; n = n.parentElement) if (n === this) return true;
      return false;
    },
    querySelectorAll: () => [details, sibling],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const summary = { contains: () => false };
  const details = {
    tagName: "DETAILS",
    hidden: false,
    isConnected: true,
    parentElement: root,
    open: false,
    children: [summary],
  };
  const sibling = { ...details, open: siblingPending };
  const parent = {
    tagName: "PRE",
    hidden: false,
    isConnected: true,
    parentElement: details,
    clientHeight: 0,
    clientWidth: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    getClientRects: () => [{ width: 80, height: 20 }],
    scrollIntoView: vi.fn(),
  };
  const model = new SearchExpansion();
  const previous = new SearchExpansion();
  unregister.push(
    registerSearchExpansion(details as unknown as HTMLElement, model),
    registerSearchExpansion(sibling as unknown as HTMLElement, previous),
  );
  const range = {
    startContainer: { parentElement: parent },
    endContainer: { parentElement: parent },
    getClientRects: () => parent.getClientRects(),
  };
  const message = {
    classList: { add: vi.fn(), remove: vi.fn() },
    focus: vi.fn(),
  };
  let activeRoot: typeof root | null = root;
  h.range.mockReturnValue({ range, message });
  LoadedSearchJump({
    host: {
      current: { querySelector: () => activeRoot } as unknown as HTMLElement,
    },
    request: { hit: {} as LoadedSearchHit, token: {} },
    revision: 0,
    onClose: vi.fn(),
  });
  cleanup = h.effects[0]();
  frame();
  frame();
  return {
    details,
    sibling,
    parent,
    message,
    model,
    retireHost: () => {
      activeRoot = null;
    },
  };
}
it("waits for the folded destination's actual open commit even when it has cached rectangles", () => {
  const s = subject();
  expect(s.model.open).toBe(true);
  expect(s.details.open).toBe(false);
  expect(s.message.focus).not.toHaveBeenCalled();
  expect(h.statuses).not.toContain("located");
  s.details.open = true;
  notify();
  frame();
  expect(s.message.focus).toHaveBeenCalledOnce();
  expect(s.parent.scrollIntoView).toHaveBeenCalledOnce();
  expect(h.statuses.at(-1)).toBe("located");
  notify();
  expect(h.frames.size).toBe(0);
});
it("waits for a previous sibling's pending close before final positioning", () => {
  const s = subject(true);
  s.details.open = true;
  notify();
  if (h.frames.size) frame();
  expect(s.message.focus).not.toHaveBeenCalled();
  expect(h.statuses).not.toContain("located");
  s.sibling.open = false;
  notify();
  frame();
  expect(s.message.focus).toHaveBeenCalledOnce();
});
it("retires a pending navigation if its source becomes stale before the disclosure commits", () => {
  const s = subject();
  h.current = false;
  s.details.open = true;
  notify();
  if (h.frames.size) frame();
  expect(s.message.focus).not.toHaveBeenCalled();
  expect(h.statuses.at(-1)).toBe("stale");
  expect(s.model.open).toBe(false);
});

it("does not navigate a still-connected transcript after it leaves the current host", () => {
  const s = subject();
  s.retireHost();
  s.details.open = true;
  notify();
  frame();
  expect(s.message.focus).not.toHaveBeenCalled();
  expect(h.statuses.at(-1)).toBe("stale");
});
it("does not revive a retired request through an already-delivered observer callback", () => {
  const s = subject();
  const late = [...h.mutations][0];
  h.current = false;
  notify();
  frame();
  expect(h.statuses.at(-1)).toBe("stale");
  h.current = true;
  s.details.open = true;
  late();
  expect(h.frames.size).toBe(0);
  expect(s.message.focus).not.toHaveBeenCalled();
});
