import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  frames: [] as (() => void)[],
  current: true,
  range: vi.fn(),
  release: vi.fn(),
  reveal: vi.fn(),
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
  loadedSearchHitIsCurrent: () => h.current,
}));
vi.mock("../runtime/loaded_search_dom", () => ({
  loadedSearchDOMRange: h.range,
}));
vi.mock("../runtime/transcript_search", () => ({
  revealSearchAncestors: h.reveal,
}));
import { LoadedSearchJump } from "./LoadedSearchJump";
import type { LoadedSearchHit } from "../runtime/loaded_search";

let cleanup: (() => void) | void;
beforeEach(() => {
  vi.clearAllMocks();
  h.effects = [];
  h.frames = [];
  h.current = true;
  h.reveal.mockReturnValue(h.release);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    h.frames.push(callback),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});
function view() {
  const make = () => ({
    range: {
      startContainer: {
        parentElement: { isConnected: true, scrollIntoView: vi.fn() },
      },
    },
    message: { focus: vi.fn(), classList: { add: vi.fn(), remove: vi.fn() } },
  });
  const first = make(),
    second = make();
  const root = { isConnected: true, contains: () => true };
  const registry = new Map();
  const add = vi.fn();
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal(
    "Highlight",
    class {
      add = add;
    },
  );
  h.range.mockReturnValueOnce(first).mockReturnValueOnce(second);
  LoadedSearchJump({
    host: { current: { querySelector: () => root } as unknown as HTMLElement },
    request: { hit: {} as LoadedSearchHit, token: {} },
    revision: 0,
    onClose: vi.fn(),
  });
  cleanup = h.effects[0]();
  h.frames.shift()!();
  return { first, second, add, registry };
}
it("uses the revalidated DOM range after a folded attachment rerenders its text nodes", () => {
  const { first, second, add } = view();
  h.frames.shift()!();
  expect(add).toHaveBeenCalledWith(second.range);
  expect(second.message.focus).toHaveBeenCalledOnce();
  expect(
    second.range.startContainer.parentElement.scrollIntoView,
  ).toHaveBeenCalledOnce();
  expect(first.message.focus).not.toHaveBeenCalled();
});
it("immediately releases temporary disclosure if the message disappears before the next frame", () => {
  const { add } = view();
  h.current = false;
  h.frames.shift()!();
  expect(add).not.toHaveBeenCalled();
  expect(h.release).toHaveBeenCalledOnce();
});
it("does not scroll after focusing synchronously invalidates the source", () => {
  const { second } = view();
  second.message.focus.mockImplementation(() => {
    h.current = false;
  });
  h.frames.shift()!();
  expect(
    second.range.startContainer.parentElement.scrollIntoView,
  ).not.toHaveBeenCalled();
});
