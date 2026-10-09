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
    closest: () => null,
    getClientRects: () => (visible ? [{}] : []),
    classList: { add: vi.fn(), remove: vi.fn() },
    scrollIntoView: vi.fn(),
  };
  const text = { textContent: "展开后的正文", parentElement: parent };
  const block = {};
  const root = {
    querySelectorAll: () => [block],
    addEventListener: (type: string, callback: () => void) =>
      listeners.set(type, callback),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
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
    createRange: () => ({
      startContainer: text,
      setStart: vi.fn(),
      setEnd: vi.fn(),
    }),
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
  };
}

it.each(["toggle", "mutate"] as const)(
  "refreshes visible search matches after %s without changing the query or thread revision",
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
    expect(count()).toBe(LIBRARY.findEmpty);
    fixture[kind](true);
    expect(count()).toBe(R.findPosition(1, 1));
    fixture[kind](false);
    expect(count()).toBe(LIBRARY.findEmpty);
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
