import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Hand-mocked React and DOM, matching the repo's component-test style:
 * `useEffect` callbacks are collected into `h.effects`, `useRef` returns plain
 * cells, and `document`/`HTMLElement` are stubbed with minimal fakes.
 */
const h = {
  effects: [] as (() => void | (() => void))[],
};
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (fn: () => void | (() => void)) => {
    h.effects.push(fn);
  },
  useRef: (current: unknown) => ({ current }),
}));
import { useModalDialog } from "./useModalDialog";

/** Minimal focusable element: connected, visible, focus-recording. */
class FocusTarget {
  isConnected = true;
  hidden = false;
  constructor(readonly name: string) {}
  closest() {
    return this.hidden ? {} : null;
  }
  matches() {
    return false;
  }
  getClientRects() {
    return this.isConnected && !this.hidden ? [{}] : [];
  }
  contains(other: unknown) {
    return other === this;
  }
  focus() {
    page.activeElement = this;
    events.push(this.name);
  }
}

const events: string[] = [];
const page = {
  activeElement: null as FocusTarget | null,
  openDialogs: [] as { contains(t: unknown): boolean }[],
  querySelectorAll(selector: string) {
    return selector === "dialog[open]" ? page.openDialogs : [];
  },
};

class FakeDialog {
  open = false;
  fields: FocusTarget[] = [];
  showModal = vi.fn(() => {
    this.open = true;
  });
  close = vi.fn(() => {
    this.open = false;
    page.activeElement = null;
  });
  querySelectorAll(selector: string) {
    return this.fields;
  }
  querySelector(selector: string) {
    return this.fields[0] ?? null;
  }
  getBoundingClientRect() {
    return { left: 10, right: 110, top: 10, bottom: 60 };
  }
  contains(other: unknown) {
    return this.fields.includes(other as FocusTarget);
  }
}

beforeEach(() => {
  h.effects = [];
  events.length = 0;
  page.activeElement = new FocusTarget("body");
  page.openDialogs = [];
  vi.stubGlobal("document", page);
  vi.stubGlobal("HTMLElement", FocusTarget);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function render(opts: Parameters<typeof useModalDialog>[0]) {
  return useModalDialog(opts);
}
const cancelEvent = (dialog: unknown, target = dialog) => ({
  target,
  currentTarget: dialog,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
});

describe("useModalDialog lifecycle", () => {
  it("opens with showModal, closes on cleanup and returns focus to the opener", () => {
    const dialog = new FakeDialog();
    const dialogRef = { current: dialog as unknown as HTMLDialogElement };
    const opener = new FocusTarget("opener");
    page.activeElement = opener;
    render({ dialogRef });
    expect(h.effects).toHaveLength(1);
    const cleanup = h.effects[0]() as () => void;
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(typeof cleanup).toBe("function");
    cleanup();
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(page.activeElement).toBe(opener);
  });

  it("closes instead of opening when open=false", () => {
    const dialog = new FakeDialog();
    render({
      dialogRef: { current: dialog as unknown as HTMLDialogElement },
      open: false,
    });
    const cleanup = h.effects[0]();
    expect(dialog.showModal).not.toHaveBeenCalled();
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(cleanup).toBeUndefined();
  });

  it("prefers an explicit returnFocusRef over the active element", () => {
    const dialog = new FakeDialog();
    const marked = new FocusTarget("marked");
    const cleanup = (function () {
      const dialogRef = { current: dialog as unknown as HTMLDialogElement };
      render({
        dialogRef,
        returnFocusRef: { current: marked as unknown as HTMLElement },
      });
      return h.effects[0]() as () => void;
    })();
    cleanup();
    expect(page.activeElement).toBe(marked);
  });

  it("focuses initialFocusRef after showModal, before selector fallbacks", () => {
    const dialog = new FakeDialog();
    const field = new FocusTarget("field");
    dialog.fields = [new FocusTarget("first")];
    render({
      dialogRef: { current: dialog as unknown as HTMLDialogElement },
      initialFocusRef: { current: field as unknown as HTMLElement },
      autoFocus: true,
    });
    h.effects[0]();
    expect(page.activeElement).toBe(field);
  });

  it("uses focusSelector, then the first eligible text input", () => {
    const dialog = new FakeDialog();
    const chosen = new FocusTarget("chosen");
    dialog.fields = [chosen];
    render({
      dialogRef: { current: dialog as unknown as HTMLDialogElement },
      focusSelector: "[data-focus]",
    });
    h.effects[0]();
    expect(page.activeElement).toBe(chosen);
    const dialog2 = new FakeDialog();
    dialog2.fields = [new FocusTarget("auto")];
    render({
      dialogRef: { current: dialog2 as unknown as HTMLDialogElement },
      autoFocus: true,
    });
    h.effects[1]();
    expect(page.activeElement).toBe(dialog2.fields[0]);
  });

  it("falls back to fallbackFocusRef when the opener is gone", () => {
    const dialog = new FakeDialog();
    const opener = new FocusTarget("opener");
    const fallback = new FocusTarget("fallback");
    page.activeElement = opener;
    render({
      dialogRef: { current: dialog as unknown as HTMLDialogElement },
      fallbackFocusRef: { current: fallback as unknown as HTMLElement },
    });
    const cleanup = h.effects[0]() as () => void;
    opener.isConnected = false;
    cleanup();
    expect(page.activeElement).toBe(fallback);
  });

  it("skips the focus return to a hidden or disconnected opener", () => {
    for (const makeStale of [
      (e: FocusTarget) => {
        e.hidden = true;
      },
      (e: FocusTarget) => {
        e.isConnected = false;
      },
    ]) {
      const dialog = new FakeDialog();
      const opener = new FocusTarget("opener");
      page.activeElement = opener;
      render({
        dialogRef: { current: dialog as unknown as HTMLDialogElement },
      });
      const cleanup = h.effects.splice(0)[0]() as () => void;
      makeStale(opener);
      page.activeElement = null;
      cleanup();
      expect(page.activeElement).not.toBe(opener);
    }
  });
});

describe("useModalDialog busy locking", () => {
  it("consumes but does not forward Escape while busy", () => {
    const dialog = new FakeDialog();
    const dismiss = vi.fn();
    const { onCancel } = render({
      dialogRef: { current: dialog as unknown as HTMLDialogElement },
      busy: true,
      onDismiss: dismiss,
    });
    h.effects[0]();
    const event = cancelEvent(dialog);
    onCancel(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("locks the backdrop click while busy and frees it when idle", () => {
    const dialog = new FakeDialog();
    const dismiss = vi.fn();
    const busyHandlers = render({
      dialogRef: { current: dialog as unknown as HTMLDialogElement },
      busy: true,
      onDismiss: dismiss,
      backdropDismiss: true,
    });
    const idleHandlers = render({
      dialogRef: { current: dialog as unknown as HTMLDialogElement },
      busy: false,
      onDismiss: dismiss,
      backdropDismiss: true,
    });
    const outside = { target: dialog, clientX: 5, clientY: 5 };
    busyHandlers.onClick(outside as never);
    expect(dismiss).not.toHaveBeenCalled();
    idleHandlers.onClick(outside as never);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("dismisses only for clicks beyond the dialog bounds", () => {
    const dialog = new FakeDialog();
    const dismiss = vi.fn();
    const { onClick } = render({
      dialogRef: { current: dialog as unknown as HTMLDialogElement },
      onDismiss: dismiss,
      backdropDismiss: true,
    });
    onClick({ target: dialog, clientX: 5, clientY: 5 } as never);
    expect(dismiss).toHaveBeenCalledOnce();
    onClick({ target: dialog, clientX: 50, clientY: 30 } as never);
    expect(dismiss).toHaveBeenCalledOnce();
    onClick({ target: {}, clientX: 5, clientY: 5 } as never);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("ignores cancel events bubbling from a nested dialog", () => {
    const dialog = new FakeDialog();
    const dismiss = vi.fn();
    const { onCancel } = render({
      dialogRef: { current: dialog as unknown as HTMLDialogElement },
      onDismiss: dismiss,
    });
    const event = cancelEvent(dialog, {});
    onCancel(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });
});

describe("useModalDialog nested focus return", () => {
  it.each([false, true])(
    "does not return focus for a retired owner (deferred=%s)",
    async (deferFocusReturn) => {
      const dialog = new FakeDialog();
      const opener = new FocusTarget("old-owner");
      page.activeElement = opener;
      let current = true;
      render({
        dialogRef: { current: dialog as unknown as HTMLDialogElement },
        returnFocusWhen: () => current,
        deferFocusReturn,
      });
      const cleanup = h.effects[0]() as () => void;
      if (!deferFocusReturn) current = false;
      cleanup();
      current = false;
      await Promise.resolve();
      expect(events).not.toContain("old-owner");
    },
  );

  it("yields the focus return to a still-open dialog when deferFocusReturn", async () => {
    const dialog = new FakeDialog();
    const opener = new FocusTarget("opener");
    page.activeElement = opener;
    render({
      dialogRef: { current: dialog as unknown as HTMLDialogElement },
      deferFocusReturn: true,
    });
    const cleanup = h.effects[0]() as () => void;
    // A second modal is still open elsewhere and does not contain the opener.
    page.openDialogs = [{ contains: () => false }];
    cleanup();
    await Promise.resolve();
    await Promise.resolve();
    expect(page.activeElement).not.toBe(opener);
  });

  it("returns focus normally once no other modal remains", async () => {
    const dialog = new FakeDialog();
    const opener = new FocusTarget("opener");
    page.activeElement = opener;
    render({
      dialogRef: { current: dialog as unknown as HTMLDialogElement },
      deferFocusReturn: true,
    });
    const cleanup = h.effects[0]() as () => void;
    cleanup();
    await Promise.resolve();
    await Promise.resolve();
    expect(page.activeElement).toBe(opener);
  });
});
