import { renderToStaticMarkup } from "react-dom/server";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

vi.mock("../runtime/sessions", () => ({
  basename: (path: string) => path.split("/").pop(),
  relativeTime: () => "刚刚",
  threads: { needsAttention: () => false, archiveBlockReason: () => null },
  useThreadsSnapshot: () => ({
    index: [
      {
        id: "saved",
        title: "Saved conversation",
        agentId: "one",
        cwd: "/folder",
        nativeSessionId: "saved-native",
        pinned: false,
        archived: false,
        updatedAt: 1,
      },
      {
        id: "archived",
        title: "Archived conversation",
        agentId: "one",
        cwd: "/archive-folder",
        nativeSessionId: "archived-native",
        pinned: false,
        archived: true,
        updatedAt: 0,
      },
    ],
    agentRows: [
      {
        key: "unregistered",
        title: "Unregistered external draft",
        agentId: "one",
        cwd: "/folder",
        nativeSessionId: "external",
        updatedAt: 1,
      },
    ],
    threads: new Map(),
  }),
}));
vi.mock("../runtime/collections", () => ({
  useCollections: () => ({
    groups: [{ id: "research", name: "调研资料" }],
    assignments: { archived: "research" },
  }),
}));

describe("command palette admission and focus surface", () => {
  it("searches admitted conversations without bypassing explicit history import", () => {
    const html = renderToStaticMarkup(
      <CommandPalette agents={[]} onClose={() => {}} onSelect={() => {}} />,
    );
    expect(html).toContain("Saved conversation");
    expect(html).toContain("Archived conversation");
    expect(html).toContain("调研资料");
    expect(html).toContain("已归档");
    expect(html).not.toContain("Unregistered external draft");
    expect(html).toContain("找回一段对话");
    expect(html).toContain("one · 未分组");
    expect(html).toContain('aria-label="关闭"');
    expect(html).not.toContain("归档当前");
    expect(html).not.toContain("打开设置");
    expect(html).toContain("<dialog");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('role="listbox"');
  });
});

// Capture the real search input caller without replacing production hooks or
// opening a browser. Keyboard events are the only simulated boundary.
function searchInput() {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  let tree: ReactNode;
  function Capture() {
    tree = CommandPalette({
      agents: [],
      onClose,
      onSelect,
    });
    return tree;
  }
  renderToStaticMarkup(<Capture />);
  let input: ReactElement<ComponentProps<"input">> | undefined;
  let dialog: ReactElement<ComponentProps<"dialog">> | undefined;
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      if (child.type === "input")
        input = child as ReactElement<ComponentProps<"input">>;
      if (child.type === "dialog")
        dialog = child as ReactElement<ComponentProps<"dialog">>;
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return {
    input: input!.props,
    dialog: dialog!.props,
    onClose,
    onSelect,
  };
}

it("keeps focus inside the global search dialog at both Tab edges", () => {
  class Control {
    tabIndex = 0;
    focus = vi.fn();
    parentElement: Control | null = null;
    closest = (selector: string) =>
      selector === "dialog" ? this.parentElement : null;
    matches = () => false;
    getClientRects = () => [{}];
  }
  const first = new Control();
  const last = new Control();
  const dialog = Object.assign(new Control(), {
    querySelectorAll: () => [first, last],
    contains: (control: Control) => control === first || control === last,
  });
  first.parentElement = last.parentElement = dialog;
  vi.stubGlobal("HTMLElement", Control);
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
  try {
    const view = searchInput();
    const tab = (target: Control, shiftKey: boolean) => {
      const preventDefault = vi.fn();
      view.dialog.onKeyDown?.({
        key: "Tab",
        shiftKey,
        target,
        currentTarget: dialog,
        nativeEvent: { isComposing: false },
        preventDefault,
      } as unknown as KeyboardEvent<HTMLDialogElement>);
      expect(preventDefault).toHaveBeenCalledOnce();
    };
    tab(last, false);
    expect(first.focus).toHaveBeenCalledOnce();
    tab(first, true);
    expect(last.focus).toHaveBeenCalledOnce();
    expect(view.onClose).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

function keyboard(key: string, isComposing: boolean, keyCode: number) {
  return {
    key,
    nativeEvent: { isComposing, keyCode },
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent<HTMLInputElement>;
}

describe("command palette composition confirmation", () => {
  it.each([
    [true, 13],
    [false, 229],
  ])(
    "leaves composing=%s keyCode=%s to the input method",
    (composing, code) => {
      const view = searchInput();
      for (const key of ["Enter", "Escape", "ArrowDown", "ArrowUp"]) {
        const event = keyboard(key, composing as boolean, code as number);
        view.input.onKeyDown!(event);
        expect(event.preventDefault).not.toHaveBeenCalled();
      }
      for (const callback of [view.onClose, view.onSelect])
        expect(callback).not.toHaveBeenCalled();
    },
  );

  it("opens the selected conversation on the next ordinary Enter", () => {
    const view = searchInput();
    view.input.onKeyDown!(keyboard("Enter", false, 229));
    expect(view.onSelect).not.toHaveBeenCalled();
    const event = keyboard("Enter", false, 13);
    view.input.onKeyDown!(event);
    expect(view.onSelect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "saved" }),
    );
    expect(view.onClose).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});
