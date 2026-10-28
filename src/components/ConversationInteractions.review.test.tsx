import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  pick: vi.fn(),
  write: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      },
    ];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = h.cursor++;
    const prior = h.slots[index];
    if (!prior || deps.some((value, i) => !Object.is(value, prior.deps?.[i]))) {
      const slot = { deps, cleanup: prior?.cleanup };
      h.slots[index] = slot;
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
    }
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: h.pick }));
vi.mock("../runtime/file_delivery", () => ({
  fileDelivery: { exportText: h.write },
}));
import { ConversationFind } from "./ConversationFind";
import { ConversationExportDialog } from "./ConversationExportDialog";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
import { LIBRARY } from "../runtime/library_strings";

type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...nodes(child.props.children as ReactNode)]
      : [],
  );
}
function render(read: () => ReactNode): Element[] {
  h.cursor = 0;
  const tree = read();
  const effects = h.effects.splice(0);
  if (effects.length) {
    effects.forEach((effect) => effect());
    return render(read);
  }
  return nodes(tree);
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.pick.mockReset();
  h.write.mockReset();
});
afterEach(() => {
  h.slots.forEach((slot) => slot.cleanup?.());
  vi.unstubAllGlobals();
});

function transcript() {
  let visible = false;
  let changed: (() => void) | undefined;
  const listeners = new Map<string, () => void>();
  const parent = {
    isConnected: true,
    closest: () => null,
    getClientRects: () => (visible ? [{}] : []),
    classList: { add: vi.fn(), remove: vi.fn() },
    scrollIntoView: vi.fn(),
  };
  const text = {
    nodeType: 3,
    textContent: "展开后的正文",
    data: "展开后的正文",
    parentElement: parent,
  };
  const block = {
    nodeType: 1,
    tagName: "P",
    matches: () => false,
    hasAttribute: (name: string) => name === "data-find-block",
    childNodes: [text],
  };
  const root = {
    nodeType: 1,
    tagName: "DIV",
    matches: () => false,
    hasAttribute: () => false,
    childNodes: [block],
    isConnected: true,
    contains: () => true,
    querySelectorAll: () => [block],
    addEventListener: (type: string, callback: () => void) =>
      listeners.set(type, callback),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    callback();
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
  const rangeCreated = vi.fn(() => ({
    startContainer: text,
    startOffset: 0,
    endContainer: text,
    endOffset: 0,
    setStart(node: typeof text, offset: number) {
      this.startContainer = node;
      this.startOffset = offset;
    },
    setEnd(node: typeof text, offset: number) {
      this.endContainer = node;
      this.endOffset = offset;
    },
  }));
  vi.stubGlobal("document", {
    createTreeWalker: () => {
      let visited = false;
      return {
        currentNode: text,
        nextNode: () => {
          if (visited) return false;
          visited = true;
          return true;
        },
      };
    },
    createRange: rangeCreated,
  });
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        changed = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  return {
    host: { current: { querySelector: () => root } as unknown as HTMLElement },
    toggle: (next: boolean) => {
      visible = next;
      listeners.get("toggle")?.();
    },
    mutate: (next: boolean) => {
      visible = next;
      changed?.();
    },
    observe,
    disconnect,
    rangeCreated,
    parent,
  };
}

it.each(["toggle", "mutate"] as const)(
  "keeps loaded text searchable through %s without changing the query or thread revision",
  (kind) => {
    const fixture = transcript();
    const read = () =>
      ConversationFind({ host: fixture.host, revision: 1, onClose: vi.fn() });
    const input = render(read).find((node) => node.type === "input")!;
    (input.props.onChange as (event: unknown) => void)({
      target: { value: "正文" },
    });
    const count = () =>
      render(read).find((node) => node.props.role === "status")!.props.children;
    expect(count()).toBe(R.findPosition(1, 1));
    fixture[kind](true);
    expect(count()).toBe(R.findPosition(1, 1));
    fixture[kind](false);
    expect(count()).toBe(R.findPosition(1, 1));
    expect(fixture.observe).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        childList: true,
        characterData: true,
        subtree: true,
        attributeFilter: expect.not.arrayContaining(["class"]),
      }),
    );
    h.slots.forEach((slot) => slot.cleanup?.());
    expect(fixture.disconnect).toHaveBeenCalled();
  },
);

it.each(["saved", "failed"] as const)(
  "keeps the export dialog open during the write and shows the %s receipt",
  async (outcome) => {
    let finish: () => void = () => {};
    h.pick.mockResolvedValue("/output/conversation.md");
    h.write.mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          finish = () =>
            outcome === "saved" ? resolve() : reject(new Error("write failed"));
        }),
    );
    const close = vi.fn();
    const read = () =>
      ConversationExportDialog({
        text: "Reviewed text",
        name: "conversation.md",
        onClose: close,
        returnFocusRef: { current: null },
      });
    const save = render(read).find(
      (node) => node.props.children === R.exportSave,
    )!;
    (save.props.onClick as () => void)();
    await vi.waitFor(() =>
      expect(h.write).toHaveBeenCalledWith(
        "Reviewed text",
        "/output/conversation.md",
      ),
    );
    let view = render(read);
    expect(view.find((node) => node.type === WorkspaceDialog)!.props.busy).toBe(
      true,
    );
    expect(
      view.find((node) => node.props.children === R.exportClose)!.props
        .disabled,
    ).toBe(true);
    (
      view.find((node) => node.type === WorkspaceDialog)!.props
        .onClose as () => void
    )();
    expect(close).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => {
      view = render(read);
      expect(
        view.find((node) => node.type === WorkspaceDialog)!.props.busy,
      ).toBe(false);
    });
    expect(close).not.toHaveBeenCalled();
    expect(
      view.some((node) =>
        outcome === "saved"
          ? node.props.children === R.exportSaved
          : node.props.role === "alert",
      ),
    ).toBe(true);
  },
);

it.each([
  { key: "Enter", nativeEvent: { isComposing: true, keyCode: 13 } },
  { key: "Enter", nativeEvent: { isComposing: false, keyCode: 229 } },
  { key: "Escape", nativeEvent: { isComposing: true, keyCode: 27 } },
])("leaves $key to the composing input method", (inputEvent) => {
  const fixture = transcript();
  const close = vi.fn();
  const view = render(() =>
    ConversationFind({ host: fixture.host, revision: 1, onClose: close }),
  );
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  (
    view.find((node) => node.props.className === "thread-find")!.props
      .onKeyDown as (event: unknown) => void
  )({ ...inputEvent, preventDefault, stopPropagation });
  expect(preventDefault).not.toHaveBeenCalled();
  expect(stopPropagation).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it("releases the export close guard after cancelling the location picker and never writes a file", async () => {
  let cancel: (path: null) => void = () => {};
  h.pick.mockImplementation(
    () =>
      new Promise<null>((resolve) => {
        cancel = resolve;
      }),
  );
  const close = vi.fn();
  const read = () =>
    ConversationExportDialog({
      text: "Reviewed text",
      name: "conversation.md",
      onClose: close,
      returnFocusRef: { current: null },
    });
  const view = render(read);
  const save = view.find((node) => node.props.children === R.exportSave)!;
  (save.props.onClick as () => void)();
  (save.props.onClick as () => void)();
  expect(h.pick).toHaveBeenCalledOnce();
  (
    view.find((node) => node.type === WorkspaceDialog)!.props
      .onClose as () => void
  )();
  expect(close).not.toHaveBeenCalled();
  cancel(null);
  await vi.waitFor(() =>
    expect(
      render(read).find((node) => node.type === WorkspaceDialog)!.props.busy,
    ).toBe(false),
  );
  expect(h.write).not.toHaveBeenCalled();
  (
    render(read).find((node) => node.type === WorkspaceDialog)!.props
      .onClose as () => void
  )();
  expect(close).toHaveBeenCalledOnce();
});

it("coalesces streamed revisions and DOM mutations into one pending frame", () => {
  const fixture = transcript();
  const frames = new Map<number, () => void>();
  let id = 0,
    revision = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) =>
    frames.delete(frame),
  );
  const nextFrame = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback());
  };
  const read = () =>
    ConversationFind({ host: fixture.host, revision, onClose: vi.fn() });
  const input = render(read).find((node) => node.type === "input")!;
  (input.props.onChange as (event: unknown) => void)({
    target: { value: "正文" },
  });
  render(read);
  for (let i = 0; i < 20; i++) {
    fixture.mutate(true);
    revision++;
    render(read);
  }
  expect(frames.size).toBe(1);
  expect(fixture.rangeCreated).not.toHaveBeenCalled();
  nextFrame();
  expect(fixture.rangeCreated).toHaveBeenCalledOnce();
  expect(
    render(read).find((node) => node.props.role === "status")!.props.children,
  ).toBe(R.findPosition(1, 1));
  h.slots.forEach((slot) => slot.cleanup?.());
  expect(frames.size).toBe(0);
});

it("adds highlights incrementally instead of passing every match as an argument", () => {
  const fixture = transcript();
  const highlights = new Map<string, { ranges: Range[] }>();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal(
    "Highlight",
    class {
      ranges: Range[] = [];
      constructor(...args: unknown[]) {
        expect(args).toHaveLength(0);
      }
      add(range: Range) {
        this.ranges.push(range);
      }
    },
  );
  const read = () =>
    ConversationFind({ host: fixture.host, revision: 1, onClose: vi.fn() });
  const input = render(read).find((node) => node.type === "input")!;
  (input.props.onChange as (event: unknown) => void)({
    target: { value: "正文" },
  });
  render(read);
  expect(highlights.get("conversation-find")!.ranges).toHaveLength(1);
  h.slots.forEach((slot) => slot.cleanup?.());
  expect(highlights.size).toBe(0);
});

it("finishes pending navigation when the same folded hit gains layout after its first frame", () => {
  const fixture = transcript();
  const frames = new Map<number, () => void>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) =>
    frames.delete(frame),
  );
  const nextFrame = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback());
  };
  const read = () =>
    ConversationFind({ host: fixture.host, revision: 1, onClose: vi.fn() });
  const input = render(read).find((node) => node.type === "input")!;
  (input.props.onChange as (event: unknown) => void)({
    target: { value: "正文" },
  });
  render(read);
  nextFrame(); // scan folded, materialized text
  render(read);
  nextFrame(); // reveal has not committed a visible layout yet
  expect(fixture.parent.scrollIntoView).not.toHaveBeenCalled();
  fixture.mutate(true); // the reveal's open/hidden commit; same text and offsets
  nextFrame();
  render(read);
  nextFrame();
  render(read);
  expect(fixture.parent.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
    block: "center",
  });
  fixture.mutate(true);
  nextFrame();
  render(read);
  nextFrame();
  expect(fixture.parent.scrollIntoView).toHaveBeenCalledOnce(); // no scroll stealing on later scans
});

it("discards a hidden pending location on unmount instead of scrolling a later reveal", () => {
  const fixture = transcript();
  const frames = new Map<number, () => void>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) =>
    frames.delete(frame),
  );
  const nextFrame = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback());
  };
  const read = () =>
    ConversationFind({ host: fixture.host, revision: 1, onClose: vi.fn() });
  const input = render(read).find((node) => node.type === "input")!;
  (input.props.onChange as (event: unknown) => void)({
    target: { value: "正文" },
  });
  render(read);
  nextFrame();
  render(read);
  nextFrame();
  h.slots.forEach((slot) => slot.cleanup?.());
  fixture.mutate(true);
  nextFrame();
  expect(fixture.parent.scrollIntoView).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
});

it.each(["", "展开"])(
  "retires queued old-hit navigation before scanning a changed query %j",
  (query) => {
    const fixture = transcript();
    const frames = new Map<number, () => void>();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frames.set(++id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) =>
      frames.delete(frame),
    );
    const nextFrame = () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback());
    };
    const read = () =>
      ConversationFind({ host: fixture.host, revision: 1, onClose: vi.fn() });
    const input = render(read).find((node) => node.type === "input")!;
    const change = input.props.onChange as (event: unknown) => void;
    change({ target: { value: "正文" } });
    render(read);
    nextFrame();
    render(read);
    nextFrame();
    fixture.mutate(true);
    nextFrame(); // old-hit position is queued, but has not run
    change({ target: { value: query } });
    render(read);
    nextFrame();
    expect(fixture.parent.scrollIntoView).not.toHaveBeenCalled();
    render(read);
    nextFrame();
    render(read);
    expect(fixture.parent.scrollIntoView).toHaveBeenCalledTimes(query ? 1 : 0);
  },
);
