import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadState } from "../runtime/session_types";
import { freshThreadState } from "../runtime/session_projection";
import { attachmentSearchCandidates } from "../runtime/attachment_search_source";
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
  threads: new Map<string, ThreadState>(),
  index: [] as {
    id: string;
    agentId: string;
    cwd: string;
    nativeSessionId: string;
  }[],
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
  threads: { getSnapshot: () => ({ threads: h.threads, index: h.index }) },
}));
import { AttachmentSearchJump } from "./AttachmentSearchJump";

let cleanup: void | (() => void);
let unregister: (() => void)[] = [];
beforeEach(() => {
  h.effects = [];
  h.frames.clear();
  h.nextFrame = 0;
  h.mutations.clear();
  h.statuses = [];
  h.threads.clear();
  h.index = [];
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
  const entry = h.frames.entries().next().value;
  expect(entry).toBeDefined();
  const [id, fn] = entry!;
  h.frames.delete(id);
  fn();
}
function notify() {
  for (const fn of h.mutations) fn();
}

/** The actual file-source grant and common expansion model, with independently
 * controlled DOM commits. This is not a browser layout or installed UI test. */
function subject(hidden = true, siblingPending = false) {
  const state = freshThreadState("saved", "fixture", "/fixture", "native");
  state.items = [
    {
      kind: "user",
      id: "message",
      text: "fixture message",
      time: 1,
      streaming: false,
      attachments: Array.from({ length: 4 }, (_, index) => ({
        name: `file${index}.txt`,
        uri: `file:///fixture/file${index}.txt`,
      })),
    },
  ];
  h.threads.set(state.key, state);
  h.index = [
    {
      id: state.key,
      agentId: state.agentId,
      cwd: state.cwd,
      nativeSessionId: state.nativeSessionId,
    },
  ];
  const source = attachmentSearchCandidates([state.key], h.threads)
    .candidates[3];
  type Node = { parentElement: Node | null };
  const root = {
    tagName: "DIV",
    hidden: false,
    isConnected: true,
    parentElement: null,
    contains(node: Node | null) {
      for (let n = node; n; n = n.parentElement) if (n === this) return true;
      return false;
    },
    querySelectorAll: (selector: string) =>
      selector === "details" ? [sibling] : [message],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const message = {
    tagName: "ARTICLE",
    hidden: false,
    parentElement: root,
    dataset: { loadedMessage: "message" },
    isConnected: true,
    focus: vi.fn(),
    classList: { add: vi.fn(), remove: vi.fn() },
    querySelectorAll: () => [attachment],
  };
  const group = { tagName: "DIV", hidden: false, parentElement: message };
  const attachment = {
    tagName: "DIV",
    parentElement: group,
    dataset: { loadedAttachment: "3" },
    hidden,
    isConnected: true,
    getClientRects: () => [{ width: 80, height: 20 }],
    scrollIntoView: vi.fn(),
  };
  const sibling = {
    tagName: "DETAILS",
    hidden: false,
    parentElement: root,
    open: siblingPending,
    children: [],
  };
  const groupModel = new SearchExpansion(!hidden);
  unregister.push(
    registerSearchExpansion(group as unknown as HTMLElement, groupModel),
    registerSearchExpansion(
      sibling as unknown as HTMLElement,
      new SearchExpansion(false),
    ),
  );
  let activeRoot: typeof root | null = root;
  AttachmentSearchJump({
    host: {
      current: { querySelector: () => activeRoot } as unknown as HTMLElement,
    },
    request: { source, token: {} },
    revision: 0,
    onClose: vi.fn(),
  });
  cleanup = h.effects[0]();
  frame();
  return {
    state,
    message,
    attachment,
    sibling,
    groupModel,
    leave: () => {
      activeRoot = null;
    },
  };
}

it.each(["fourth attachment", "previous disclosure"])(
  "waits for the %s DOM commit before declaring the file source located",
  (pending) => {
    const s = subject(
      pending === "fourth attachment",
      pending !== "fourth attachment",
    );
    frame();
    expect(s.groupModel.open).toBe(true);
    expect(s.message.focus).not.toHaveBeenCalled();
    expect(s.attachment.scrollIntoView).not.toHaveBeenCalled();
    expect(h.statuses).not.toContain("located");
    expect(h.frames.size).toBe(0);

    s.attachment.hidden = false;
    s.sibling.open = false;
    notify();
    frame();
    expect(s.message.focus).toHaveBeenCalledOnce();
    expect(s.attachment.scrollIntoView).toHaveBeenCalledOnce();
    expect(h.statuses.at(-1)).toBe("located");
    notify();
    expect(h.frames.size).toBe(0);
  },
);
it("locates an already visible current file source", () => {
  const s = subject(false);
  frame();
  expect(s.message.focus).toHaveBeenCalledOnce();
  expect(s.attachment.scrollIntoView).toHaveBeenCalledOnce();
  expect(h.statuses.at(-1)).toBe("located");
});
it("rejects the actual source grant if its attachment is removed before positioning", () => {
  const s = subject();
  s.state.items = [];
  frame();
  expect(s.message.focus).not.toHaveBeenCalled();
  expect(h.statuses.at(-1)).toBe("stale");
  expect(s.groupModel.open).toBe(false);
});
it("releases the pending reveal and cancels its own frame on cleanup", () => {
  const s = subject();
  const late = [...h.mutations][0];
  cleanup?.();
  cleanup = undefined;
  expect(h.frames.size).toBe(0);
  expect(s.groupModel.open).toBe(false);
  late?.();
  expect(h.frames.size).toBe(0);
  expect(s.message.focus).not.toHaveBeenCalled();
});
it("retires a still-connected waiting transcript after navigation changes its host", () => {
  const s = subject();
  frame();
  expect(s.message.focus).not.toHaveBeenCalled();
  s.leave();
  s.attachment.hidden = false;
  notify();
  frame();
  expect(s.message.focus).not.toHaveBeenCalled();
  expect(s.groupModel.open).toBe(false);
  expect(h.statuses.at(-1)).toBe("stale");
});
it("does not revive a retired locator through a delivered callback if the grant later returns", () => {
  const s = subject();
  frame();
  expect(s.message.focus).not.toHaveBeenCalled();
  const late = [...h.mutations][0];
  const items = s.state.items;
  s.state.items = [];
  notify();
  frame();
  expect(h.statuses.at(-1)).toBe("stale");
  expect(s.groupModel.open).toBe(false);

  s.state.items = items;
  s.attachment.hidden = false;
  late();
  expect(h.frames.size).toBe(0);
  expect(s.message.focus).not.toHaveBeenCalled();
});
