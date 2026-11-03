vi.mock("../runtime/browser_surface", () => ({
  useBrowserSurfaceBarrier: () => true,
}));
import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useRef: (current: unknown) => ({ current }),
}));
import { WorkspaceDialog } from "./WorkspaceDialog";
it("consumes only its own native cancel event before React can close an enclosing dialog", () => {
  const close = vi.fn();
  const node = WorkspaceDialog({
    title: "Account guide",
    onClose: close,
    children: null,
  }) as ReactElement<{ onCancel(event: unknown): void }>;
  const parent = {},
    child = {},
    preventDefault = vi.fn(),
    stopPropagation = vi.fn();
  node.props.onCancel({
    target: child,
    currentTarget: parent,
    preventDefault,
    stopPropagation,
  });
  expect(close).not.toHaveBeenCalled();
  node.props.onCancel({
    target: child,
    currentTarget: child,
    preventDefault,
    stopPropagation,
  });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(stopPropagation).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it("wraps Tab in both directions without focusing disabled or collapsed controls", () => {
  class Control {
    children: Control[] = [];
    parentElement: Control | null = null;
    hidden = false;
    tabIndex = 0;
    focus = vi.fn();
    constructor(
      readonly tagName: string,
      readonly open = true,
      readonly disabled = false,
    ) {}
    add(...children: Control[]) {
      this.children.push(...children);
      for (const child of children) child.parentElement = this;
    }
    contains(node: Control): boolean {
      return (
        this === node || this.children.some((child) => child.contains(node))
      );
    }
    closest(selector: string): Control | null {
      if (selector !== "dialog") return null;
      return this.tagName === "DIALOG"
        ? this
        : (this.parentElement?.closest(selector) ?? null);
    }
    matches() {
      return this.disabled;
    }
    getClientRects() {
      // WebKit can report geometry for descendants of closed disclosures.
      return [{}];
    }
    querySelectorAll(): Control[] {
      return this.children.flatMap((child) => [
        child,
        ...child.querySelectorAll(),
      ]);
    }
  }
  vi.stubGlobal("HTMLElement", Control);
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
  try {
    const dialog = new Control("DIALOG");
    const first = new Control("BUTTON");
    const last = new Control("BUTTON");
    const disabled = new Control("BUTTON", true, true);
    const collapsed = new Control("DETAILS", false);
    collapsed.tabIndex = -1;
    const summary = new Control("SUMMARY");
    const hiddenContent = new Control("BUTTON");
    collapsed.add(summary, hiddenContent);
    dialog.add(first, last, disabled, collapsed);
    const node = WorkspaceDialog({
      title: "Export",
      onClose: vi.fn(),
      children: null,
    }) as ReactElement<{ onKeyDown?(event: unknown): void }>;
    const tab = (target: Control, shiftKey = false) => {
      const preventDefault = vi.fn();
      node.props.onKeyDown?.({
        key: "Tab",
        shiftKey,
        target,
        currentTarget: dialog,
        nativeEvent: { isComposing: false },
        preventDefault,
      });
      return preventDefault;
    };
    expect(tab(last)).not.toHaveBeenCalled();
    expect(tab(summary)).toHaveBeenCalledOnce();
    expect(first.focus).toHaveBeenCalledOnce();
    expect(tab(first, true)).toHaveBeenCalledOnce();
    expect(summary.focus).toHaveBeenCalledOnce();
    expect(hiddenContent.focus).not.toHaveBeenCalled();
    expect(disabled.focus).not.toHaveBeenCalled();

    const nested = new Control("DIALOG");
    const nestedControl = new Control("BUTTON");
    nested.add(nestedControl);
    dialog.add(nested);
    expect(tab(nestedControl)).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
