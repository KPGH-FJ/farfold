import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  frames: [] as (() => void)[],
  current: true,
  status: vi.fn(),
  release: vi.fn(),
  reveal: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (v: unknown) => [v, h.status],
  useRef: (v: unknown) => ({ current: v }),
  useEffect: (f: () => void | (() => void)) => h.effects.push(f),
}));
vi.mock("../runtime/sessions", () => ({
  threads: { getSnapshot: () => ({ threads: new Map(), index: [] }) },
}));
vi.mock("../runtime/attachment_search_source", () => ({
  attachmentSearchSourceCurrent: () => h.current,
}));
vi.mock("../runtime/transcript_search", () => ({
  revealSearchAncestors: h.reveal,
}));
import { AttachmentSearchJump } from "./AttachmentSearchJump";
import type { AttachmentSearchLocation } from "../runtime/attachment_search_source";
let cleanup: (() => void) | void;
beforeEach(() => {
  vi.clearAllMocks();
  h.effects = [];
  h.frames = [];
  h.current = true;
  h.reveal.mockReturnValue(h.release);
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => h.frames.push(f));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});
function view() {
  const make = () => {
    const attachment = {
      dataset: { loadedAttachment: "4" },
      isConnected: true,
      scrollIntoView: vi.fn(),
    };
    return {
      attachment,
      message: {
        dataset: { loadedMessage: "message" },
        isConnected: true,
        focus: vi.fn(),
        classList: { add: vi.fn(), remove: vi.fn() },
        querySelectorAll: () => [attachment],
      },
    };
  };
  const first = make(),
    second = make();
  let visible = first;
  const root = { isConnected: true, querySelectorAll: () => [visible.message] };
  const host = {
    current: { querySelector: () => root } as unknown as HTMLElement,
  };
  AttachmentSearchJump({
    host,
    request: {
      source: {
        itemId: "message",
        attachmentIndex: 4,
      } as AttachmentSearchLocation,
      token: {},
    },
    revision: 0,
    onClose: vi.fn(),
  });
  cleanup = h.effects[0]();
  h.frames.shift()!();
  return {
    first,
    second,
    host,
    root,
    replace: () => {
      visible = second;
    },
  };
}
it("resets locating and uses fresh attachment nodes after disclosure rerenders", () => {
  const v = view();
  v.replace();
  h.frames.shift()!();
  expect(h.status).toHaveBeenNthCalledWith(1, "locating");
  expect(v.first.message.focus).not.toHaveBeenCalled();
  expect(v.second.message.focus).toHaveBeenCalledOnce();
  expect(v.second.attachment.scrollIntoView).toHaveBeenCalledOnce();
});
it("does not reuse a previous transcript root", () => {
  const v = view();
  v.host.current = { querySelector: () => ({}) } as unknown as HTMLElement;
  h.frames.shift()!();
  expect(v.first.message.focus).not.toHaveBeenCalled();
  expect(h.release).toHaveBeenCalledOnce();
});
it("does not scroll a source invalidated by synchronous focus", () => {
  const v = view();
  v.replace();
  v.second.message.focus.mockImplementation(() => {
    h.current = false;
  });
  h.frames.shift()!();
  expect(v.second.attachment.scrollIntoView).not.toHaveBeenCalled();
});
it("rejects missing source while waiting for second frame", () => {
  const v = view();
  h.current = false;
  h.frames.shift()!();
  expect(v.first.message.focus).not.toHaveBeenCalled();
  expect(h.status).toHaveBeenLastCalledWith("stale");
});
