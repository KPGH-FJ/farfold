import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  cursor: 0,
  effects: [] as (() => void)[],
  dirty: false,
  resize: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= {
      value:
        typeof initial === "function" ? (initial as () => unknown)() : initial,
    });
    return [
      slot.value,
      (next: unknown) => {
        const v =
          typeof next === "function"
            ? (next as (v: unknown) => unknown)(slot.value)
            : next;
        if (!Object.is(v, slot.value)) {
          slot.value = v;
          h.dirty = true;
        }
      },
    ];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useLayoutEffect: (callback: () => void | (() => void), deps: unknown[]) => {
    const index = h.cursor++,
      slot = h.slots[index];
    if (!slot || deps.some((v, i) => !Object.is(v, slot.deps?.[i])))
      h.effects.push(() => {
        slot?.cleanup?.();
        h.slots[index].cleanup = callback() || undefined;
      });
    h.slots[index] = { deps, cleanup: slot?.cleanup };
  },
}));
import { VisualAreaSelection } from "./VisualAreaSelection";
import { VISUAL_AREA_STRINGS as S } from "../runtime/visual_area_strings";
import {
  visualAreaFeedbackSourceIsValid,
  type VisualAreaFeedbackSource,
} from "../runtime/visual_feedback_target";
type Props = ComponentProps<typeof VisualAreaSelection>;
type El = ReactElement<Record<string, unknown>>;
let props: Props;
let rect = { left: 40, top: 90, width: 400, height: 200 };
const pixel = { isConnected: true, getBoundingClientRect: () => rect };
let refs: WeakMap<object, { focus: ReturnType<typeof vi.fn> }>,
  focused: unknown;
function nodes(tree: ReactNode): El[] {
  const result: El[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child)) {
      result.push(child);
      result.push(...nodes(child.props.children as ReactNode));
    }
  });
  return result;
}
let attached = new Set<{ current: unknown }>();
function render() {
  let result: El[] = [];
  for (let i = 0; i < 8; i++) {
    h.dirty = false;
    h.cursor = 0;
    result = nodes(VisualAreaSelection(props));
    const nextAttached = new Set<{ current: unknown }>();
    for (const node of result) {
      const ref = node.props.ref as { current: unknown } | undefined;
      if (ref && typeof ref === "object") {
        let el = refs.get(ref);
        if (!el) {
          el = {
            focus: vi.fn(() => {
              focused = ref;
            }),
          };
          refs.set(ref, el);
        }
        ref.current = el;
        nextAttached.add(ref);
      }
    }
    for (const ref of attached) if (!nextAttached.has(ref)) ref.current = null;
    attached = nextAttached;
    for (const effect of h.effects.splice(0)) effect();
    if (!h.dirty) return result;
  }
  throw new Error("render did not settle");
}
function button(label: string) {
  const b = render().find(
    (n) => n.type === "button" && n.props.children === label,
  );
  expect(b).toBeDefined();
  return b!;
}
function click(label: string) {
  const b = button(label);
  expect(b.props.disabled).not.toBe(true);
  (b.props.onClick as () => void)();
  render();
}
function field(key: "left" | "top" | "right" | "bottom", value: string) {
  const node = render().find(
    (n) => n.type === "input" && n.props["aria-label"] === S[key],
  )!;
  (node.props.onChange as (e: unknown) => void)({ currentTarget: { value } });
  render();
}
function choose() {
  const form = render().find((n) => n.type === "form")!;
  (form.props.onSubmit as (e: unknown) => void)({ preventDefault: vi.fn() });
  render();
}
function open() {
  click(S.open);
}
function setRect() {
  field("left", "10");
  field("top", "20");
  field("right", "60");
  field("bottom", "70");
  choose();
}
const source = () => {
  const calls = vi.mocked(props.onVisualTargetAvailability!).mock.calls;
  return calls.filter(([v]) => v.available).at(-1)![0].source;
};
function stage() {
  return render().find((n) =>
    String(n.props.className).startsWith("visual-area-stage"),
  )!;
}
function pointer(
  name: string,
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
) {
  const event = {
    clientX: x,
    clientY: y,
    pointerId: 1,
    button: 0,
    isPrimary: true,
    preventDefault: vi.fn(),
    currentTarget: {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    },
    ...extra,
  };
  (stage().props[name] as (e: unknown) => void)(event);
  render();
}
beforeEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  h.slots = [];
  h.cursor = 0;
  h.effects = [];
  h.resize = [];
  h.dirty = false;
  refs = new WeakMap();
  attached = new Set();
  focused = null;
  rect = { left: 40, top: 90, width: 400, height: 200 };
  pixel.isConnected = true;
  vi.stubGlobal("window", {
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        h.resize.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  const file = {
    root: "/work",
    path: "/work/a.pdf",
    resolvedPath: "/work/a.pdf",
    name: "a.pdf",
    size: 6,
    version: "v1",
    sha256: "a".repeat(64),
  };
  const preview = { file, mimeType: "application/pdf", data: btoa("%PDF-1") };
  props = {
    preview,
    display: {
      kind: "pdf",
      preview,
      page: 2,
      pageCount: 3,
      owner: {},
      element: pixel as unknown as HTMLCanvasElement,
      pixelWidth: 800,
      pixelHeight: 400,
    },
    interactionBlocked: false,
    isCurrent: () => true,
    children: null,
    onVisualTargetAvailability: vi.fn(),
    onVisualTargetConfirm: vi.fn(),
    onTargetEditing: vi.fn(),
  };
});
it("keeps invalid numeric editing active, then requires a separate confirmation", () => {
  open();
  expect(props.onTargetEditing).toHaveBeenLastCalledWith(
    expect.objectContaining({ editing: true }),
  );
  field("left", "10e1");
  choose();
  expect(props.onVisualTargetAvailability).not.toHaveBeenCalled();
  expect(button(S.confirm).props.disabled).toBe(true);
  expect(render().some((n) => n.props.children === S.invalid)).toBe(true);
  setRect();
  expect(props.onVisualTargetConfirm).not.toHaveBeenCalled();
  expect(button(S.confirm).props.disabled).toBe(false);
  expect(focused).toBe(button(S.confirm).props.ref);
  click(S.confirm);
  expect(props.onVisualTargetConfirm).toHaveBeenCalledWith({
    source: source(),
    anchor: {
      kind: "pdf-area",
      space: "display-oriented-v1",
      page: 2,
      pageCount: 3,
      left: 100000,
      top: 200000,
      right: 600000,
      bottom: 700000,
    },
  });
});
it("does not accept inverted, equal, empty or out-of-bound numeric rectangles", () => {
  open();
  for (const values of [
    ["70", "20", "60", "80"],
    ["10", "20", "10", "80"],
    ["", "20", "60", "80"],
    ["0", "0", "100.0001", "100"],
  ]) {
    for (let i = 0; i < 4; i++)
      field((["left", "top", "right", "bottom"] as const)[i], values[i]);
    choose();
    expect(button(S.confirm).props.disabled).toBe(true);
  }
  expect(props.onVisualTargetAvailability).not.toHaveBeenCalled();
});
it("retires old selection synchronously and ignores an old confirmation after editing", () => {
  open();
  setRect();
  const previous = source(),
    old = button(S.confirm).props.onClick as () => void;
  field("left", "11");
  expect(visualAreaFeedbackSourceIsValid(previous)).toBe(false);
  old();
  expect(props.onVisualTargetConfirm).not.toHaveBeenCalled();
  choose();
  expect(source()).not.toBe(previous);
  click(S.confirm);
  expect(props.onVisualTargetConfirm).toHaveBeenCalledOnce();
});
it("blocking preserves draft and editing owner, retires old source and rebuilds only a fresh candidate", () => {
  open();
  setRect();
  const previous = source(),
    old = button(S.confirm).props.onClick as () => void;
  const owner = vi.mocked(props.onTargetEditing!).mock.calls[0][0].owner;
  props = { ...props, interactionBlocked: true };
  render();
  expect(visualAreaFeedbackSourceIsValid(previous)).toBe(false);
  old();
  expect(props.onVisualTargetConfirm).not.toHaveBeenCalled();
  expect(
    vi.mocked(props.onTargetEditing!).mock.calls.filter(([v]) => !v.editing),
  ).toHaveLength(0);
  props = { ...props, interactionBlocked: false };
  render();
  expect(source()).not.toBe(previous);
  expect(
    render().find((n) => n.props["aria-label"] === S.left)?.props.value,
  ).toBe("10");
  expect(vi.mocked(props.onTargetEditing!).mock.calls[0][0].owner).toBe(owner);
  click(S.confirm);
  expect(props.onVisualTargetConfirm).toHaveBeenCalledOnce();
});
it("resize invalidates the candidate without losing numeric input or editing hold", () => {
  open();
  setRect();
  const previous = source(),
    old = button(S.confirm).props.onClick as () => void;
  rect = { ...rect, width: 200, height: 100 };
  h.resize.at(-1)!();
  render();
  expect(visualAreaFeedbackSourceIsValid(previous)).toBe(false);
  expect(button(S.confirm).props.disabled).toBe(true);
  expect(
    render().find((n) => n.props["aria-label"] === S.left)?.props.value,
  ).toBe("10");
  old();
  expect(props.onVisualTargetConfirm).not.toHaveBeenCalled();
  choose();
  click(S.confirm);
  expect(props.onVisualTargetConfirm).toHaveBeenCalledOnce();
});
it("maps a reverse pointer drag from actual pixels, excluding the surrounding origin offset", () => {
  open();
  pointer("onPointerDown", 280, 230);
  pointer("onPointerMove", 80, 130);
  pointer("onPointerUp", 80, 130);
  expect(props.onVisualTargetConfirm).not.toHaveBeenCalled();
  click(S.confirm);
  expect(
    vi.mocked(props.onVisualTargetConfirm!).mock.calls[0][0].anchor,
  ).toEqual({
    kind: "pdf-area",
    space: "display-oriented-v1",
    page: 2,
    pageCount: 3,
    left: 100000,
    top: 200000,
    right: 600000,
    bottom: 700000,
  });
});
it("rejects starts outside the pixel box and zero-area drags; clips a valid drag's far endpoint", () => {
  open();
  pointer("onPointerDown", 0, 0);
  pointer("onPointerUp", 100, 100);
  expect(button(S.confirm).props.disabled).toBe(true);
  pointer("onPointerDown", 80, 130);
  pointer("onPointerUp", 80, 130);
  expect(button(S.confirm).props.disabled).toBe(true);
  pointer("onPointerDown", 80, 130);
  pointer("onPointerUp", 999, 999);
  click(S.confirm);
  expect(
    vi.mocked(props.onVisualTargetConfirm!).mock.calls[0][0].anchor,
  ).toEqual(
    expect.objectContaining({
      left: 100000,
      top: 200000,
      right: 1000000,
      bottom: 1000000,
    }),
  );
});
it("scroll/size change during a drag and pointer cancellation cannot publish a target", () => {
  open();
  pointer("onPointerDown", 80, 130);
  rect = { ...rect, top: 100 };
  pointer("onPointerUp", 200, 220);
  expect(button(S.confirm).props.disabled).toBe(true);
  pointer("onPointerDown", 80, 130);
  pointer("onPointerCancel", 0, 0);
  pointer("onPointerUp", 200, 220);
  expect(props.onVisualTargetAvailability).not.toHaveBeenCalled();
});
it("hide/new frame releases old editing and candidate; late confirm never revives it", () => {
  open();
  setRect();
  const previous = source(),
    old = button(S.confirm).props.onClick as () => void;
  const display = props.display!;
  props = { ...props, display: null };
  render();
  expect(visualAreaFeedbackSourceIsValid(previous)).toBe(false);
  expect(props.onTargetEditing).toHaveBeenLastCalledWith(
    expect.objectContaining({ editing: false }),
  );
  old();
  expect(props.onVisualTargetConfirm).not.toHaveBeenCalled();
  props = { ...props, display: { ...display, owner: {} } };
  render();
  expect(render().some((n) => n.type === "form")).toBe(false);
});
it("cancel clears only the candidate and returns focus to this frame's entry", () => {
  open();
  setRect();
  const previous = source();
  click(S.cancel);
  expect(visualAreaFeedbackSourceIsValid(previous)).toBe(false);
  expect(props.onVisualTargetConfirm).not.toHaveBeenCalled();
  expect(props.onTargetEditing).toHaveBeenLastCalledWith(
    expect.objectContaining({ editing: false }),
  );
  expect(focused).toBe(button(S.open).props.ref);
});
it("a retire callback that changes ownership cannot make the old input or confirm act again", () => {
  open();
  setRect();
  const old = button(S.confirm).props.onClick as () => void;
  const observer = props.onVisualTargetAvailability;
  props = {
    ...props,
    onVisualTargetAvailability: (v) => {
      observer?.(v);
      if (!v.available) props = { ...props, isCurrent: () => false };
    },
  };
  render();
  field("left", "11");
  render();
  old();
  expect(props.onVisualTargetConfirm).not.toHaveBeenCalled();
});
it("a queued resize callback from an obsolete frame cannot retire the current frame", () => {
  render();
  const oldResize = h.resize[0];
  props = { ...props, display: { ...props.display!, owner: {} } };
  render();
  open();
  setRect();
  const currentSource = source();
  oldResize();
  render();
  expect(visualAreaFeedbackSourceIsValid(currentSource)).toBe(true);
  click(S.confirm);
  expect(props.onVisualTargetConfirm).toHaveBeenCalledOnce();
});
it("geometry changed while blocked requires explicit re-selection after unblocking", () => {
  open();
  setRect();
  props = { ...props, interactionBlocked: true };
  render();
  rect = { ...rect, width: 200, height: 100 };
  props = { ...props, interactionBlocked: false };
  render();
  expect(button(S.confirm).props.disabled).toBe(true);
  expect(
    render().find((n) => n.props["aria-label"] === S.left)?.props.value,
  ).toBe("10");
  choose();
  click(S.confirm);
  expect(props.onVisualTargetConfirm).toHaveBeenCalledOnce();
});
it("cannot pair a newly read version with the previous display pixels before the next draw", () => {
  render();
  props = {
    ...props,
    preview: {
      ...props.preview,
      file: { ...props.preview.file, version: "v2", sha256: "b".repeat(64) },
    },
  };
  render();
  expect(button(S.open).props.disabled).toBe(true);
  expect(props.onVisualTargetAvailability).not.toHaveBeenCalled();
});
it("Strict effect replay retires the previous source and gives the editor a new scoped owner", () => {
  open();
  setRect();
  const previous = source();
  const old = button(S.confirm).props.onClick as () => void;
  const originalOwner = vi.mocked(props.onTargetEditing!).mock.calls[0][0]
    .owner;
  for (let index = 0; index < h.slots.length; index++) {
    const slot = h.slots[index];
    if (slot?.deps) {
      slot.cleanup?.();
      delete h.slots[index];
    }
  }
  render();
  expect(visualAreaFeedbackSourceIsValid(previous)).toBe(false);
  expect(source()).not.toBe(previous);
  expect(
    vi.mocked(props.onTargetEditing!).mock.calls.at(-1)![0].owner,
  ).not.toBe(originalOwner);
  old();
  expect(props.onVisualTargetConfirm).not.toHaveBeenCalled();
  click(S.confirm);
  expect(props.onVisualTargetConfirm).toHaveBeenCalledOnce();
});
it("an image uses the same rectangle path without accidentally storing PDF page fields", () => {
  const preview = {
    ...props.preview,
    mimeType: "image/png",
    file: { ...props.preview.file, name: "a.png" },
  };
  props = {
    ...props,
    preview,
    display: {
      kind: "image",
      preview,
      owner: {},
      element: pixel as unknown as HTMLImageElement,
      pixelWidth: 400,
      pixelHeight: 200,
    },
  };
  open();
  setRect();
  click(S.confirm);
  expect(
    vi.mocked(props.onVisualTargetConfirm!).mock.calls[0][0].anchor,
  ).toEqual({
    kind: "image-area",
    space: "display-oriented-v1",
    left: 100000,
    top: 200000,
    right: 600000,
    bottom: 700000,
  });
});
it("retirement that loses the current display does not steal focus after cancel", () => {
  open();
  setRect();
  const previousFocus = focused;
  const observer = props.onVisualTargetAvailability;
  props = {
    ...props,
    onVisualTargetAvailability: (value) => {
      observer?.(value);
      if (!value.available) {
        props = { ...props, display: null };
        render();
      }
    },
  };
  render();
  click(S.cancel);
  expect(focused).toBe(previousFocus);
  expect(props.onVisualTargetConfirm).not.toHaveBeenCalled();
});
it("Escape cancels the current editor without changing previously confirmed opinions", () => {
  open();
  setRect();
  click(S.confirm);
  const selection = source();
  const editor = render().find(
    (n) => n.props.className === "visual-area-editor",
  )!;
  (editor.props.onKeyDown as (e: unknown) => void)({
    key: "Escape",
    preventDefault: vi.fn(),
  });
  render();
  expect(visualAreaFeedbackSourceIsValid(selection)).toBe(false);
  expect(props.onVisualTargetConfirm).toHaveBeenCalledTimes(1);
  expect(render().some((n) => n.type === "form")).toBe(false);
});
