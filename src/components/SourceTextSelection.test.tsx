import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [
      slot.value,
      (value: unknown) => {
        slot.value = value;
      },
    ];
  },
  useLayoutEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = h.cursor++,
      old = h.slots[index];
    const next = { deps, cleanup: old?.cleanup };
    h.slots[index] = next;
    if (!old || deps.some((d, i) => !Object.is(d, old.deps?.[i])))
      h.effects.push(() => {
        old?.cleanup?.();
        next.cleanup = effect() || undefined;
      });
  },
}));
import {
  SourceTextSelection,
  type SourceTextSelectionProps,
} from "./SourceTextSelection";
import { createTextFeedbackSource } from "../runtime/text_feedback_range";
import { SOURCE_TEXT_SELECTION_STRINGS as S } from "../runtime/source_text_selection_strings";

// Hook/ownership fixture only. Real DOM and keyboard events have a separate browser receipt.
const node = { nodeType: 3, childNodes: [], textContent: "" };
let ranges: Range[] = [];
const doc = {
  activeElement: null as unknown,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  defaultView: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  getSelection: () => ({
    rangeCount: ranges.length,
    isCollapsed: ranges.length === 0,
    getRangeAt: (i: number) => ranges[i],
    removeAllRanges: () => {
      ranges = [];
    },
    addRange: (r: Range) => {
      ranges.push(r);
    },
  }),
  createRange: () => range(0, 0),
};
const pre = {
  nodeType: 1,
  childNodes: [node],
  ownerDocument: doc,
  get textContent() {
    return node.textContent;
  },
  contains: (v: unknown) => v === node || v === pre,
};
let clearSelectionOnFocus = false;
let afterFocus: (() => void) | null = null;
const action = {
  focus: () => {
    if (clearSelectionOnFocus) ranges = [];
    doc.activeElement = action;
    afterFocus?.();
  },
};
const container = {
  contains: (v: unknown) => v === node || v === pre || v === action,
};
function range(start: number, end: number): Range {
  const value = {
    startContainer: node as unknown as Node,
    endContainer: node as unknown as Node,
    startOffset: start,
    endOffset: end,
    cloneRange() {
      const r = range(this.startOffset, this.endOffset);
      r.setStart(this.startContainer, this.startOffset);
      r.setEnd(this.endContainer, this.endOffset);
      return r;
    },
    setStart(n: Node, o: number) {
      this.startContainer = n;
      this.startOffset = o;
    },
    setEnd(n: Node, o: number) {
      this.endContainer = n;
      this.endOffset = o;
    },
  };
  return value as unknown as Range;
}
function source(text = "\uFEFF同名\r\n同名😀尾", version = "v1") {
  const file = {
    root: "/w",
    path: "a",
    resolvedPath: "/w/a",
    name: "a",
    size: new TextEncoder().encode(text).length,
    sha256: "a".repeat(64),
    version,
  };
  return createTextFeedbackSource({ file, text }, file)!;
}
function elements(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  const result: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(tree, (n) => {
    if (isValidElement<Record<string, unknown>>(n))
      result.push(n, ...elements(n.props.children as ReactNode));
  });
  return result;
}
let props: SourceTextSelectionProps;
function render(next = props) {
  props = next;
  h.cursor = 0;
  node.textContent = props.source.text;
  const nodes = elements(SourceTextSelection(props));
  for (const n of nodes) {
    const value =
      n.type === "pre"
        ? pre
        : n.type === "button" && n.props.children === S.confirm
          ? action
          : container;
    const ref = n.props.ref as
      ((v: unknown) => void) | { current: unknown } | undefined;
    if (typeof ref === "function") ref(value);
    else if (ref) ref.current = value;
  }
  for (const fn of h.effects.splice(0)) fn();
  return nodes;
}
function confirm(nodes = render()) {
  return nodes.find(
    (n) => n.type === "button" && n.props.children === S.confirm,
  )!;
}
function select(start: number, end: number) {
  ranges = [range(start, end)];
  doc.activeElement = pre;
  const element = render().find((n) => n.type === "pre")!;
  (element.props.onPointerUp as () => void)();
  return render();
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  ranges = [];
  clearSelectionOnFocus = false;
  afterFocus = null;
  doc.activeElement = null;
  props = {
    source: source(),
    enabled: true,
    onConfirm: vi.fn(),
    onAvailability: vi.fn(),
  };
});
it("a second occurrence is just a candidate until explicit confirmation", () => {
  render();
  const nodes = select(5, 7);
  expect(props.onConfirm).not.toHaveBeenCalled();
  expect(props.onAvailability).toHaveBeenLastCalledWith({
    source: props.source,
    available: true,
  });
  const button = confirm(nodes);
  expect(button.props.disabled).toBe(false);
  (button.props.onClick as () => void)();
  expect(props.onConfirm).toHaveBeenCalledWith({
    source: props.source,
    anchor: {
      kind: "text-range",
      byteStart: 11,
      byteEnd: 17,
      startLine: 2,
      endLine: 2,
    },
  });
  (button.props.onClick as () => void)();
  expect(props.onConfirm).toHaveBeenCalledTimes(1);
  expect(props.onAvailability).toHaveBeenLastCalledWith({
    source: props.source,
    available: false,
  });
});
it("keyboard line controls produce a real range and focus the separate confirmation", () => {
  render();
  for (const index of [0, 1]) {
    const input = render().filter((n) => n.type === "input")[index];
    (input.props.onChange as (e: unknown) => void)({ target: { value: "2" } });
  }
  const form = render().find((n) => n.type === "form")!;
  (form.props.onSubmit as (e: unknown) => void)({ preventDefault: vi.fn() });
  const nodes = render();
  expect(ranges).toHaveLength(1);
  expect(ranges[0].startOffset).toBe(5);
  expect(ranges[0].endOffset).toBe(props.source.text.length);
  expect(doc.activeElement).toBe(action);
  expect(props.onConfirm).not.toHaveBeenCalled();
  expect(confirm(nodes).props.disabled).toBe(false);
});
it("restores the chosen DOM range after WebKit clears selection while a number input loses focus", () => {
  render();
  for (const index of [0, 1]) {
    const input = render().filter((n) => n.type === "input")[index];
    (input.props.onChange as (e: unknown) => void)({ target: { value: "2" } });
  }
  clearSelectionOnFocus = true;
  const form = render().find((n) => n.type === "form")!;
  (form.props.onSubmit as (e: unknown) => void)({ preventDefault: vi.fn() });
  render();
  expect(ranges).toHaveLength(1);
  expect(ranges[0].startOffset).toBe(5);
  expect(ranges[0].endOffset).toBe(props.source.text.length);
  const capture = [...doc.addEventListener.mock.calls]
    .reverse()
    .find(([name]) => name === "selectionchange")![1] as () => void;
  capture();
  expect(confirm().props.disabled).toBe(false);
  expect(doc.activeElement).toBe(action);
  expect(props.onConfirm).not.toHaveBeenCalled();
  (confirm().props.onClick as () => void)();
  expect(props.onConfirm).toHaveBeenCalledOnce();
});
it.each(["changed DOM", "redirected focus", "withdrawn candidate"])(
  "does not restore a line candidate after %s during the focus handoff",
  (cause) => {
    render();
    clearSelectionOnFocus = true;
    afterFocus = () => {
      if (cause === "changed DOM") node.textContent = "different";
      else if (cause === "redirected focus") doc.activeElement = {};
      else {
        const blur = [...doc.defaultView.addEventListener.mock.calls]
          .reverse()
          .find(([name]) => name === "blur")![1] as () => void;
        blur();
      }
    };
    const form = render().find((n) => n.type === "form")!;
    (form.props.onSubmit as (e: unknown) => void)({ preventDefault: vi.fn() });
    render();
    expect(ranges).toHaveLength(0);
    const capture = [...doc.addEventListener.mock.calls]
      .reverse()
      .find(([name]) => name === "selectionchange")![1] as () => void;
    capture();
    expect(confirm().props.disabled).toBe(true);
    expect(props.onConfirm).not.toHaveBeenCalled();
  },
);
it("a late action cannot confirm after hide or replacement with the same text", () => {
  render();
  const old = confirm(select(5, 7));
  render({ ...props, enabled: false });
  (old.props.onClick as () => void)();
  expect(props.onConfirm).not.toHaveBeenCalled();
  render({ ...props, enabled: true });
  const next = confirm(select(5, 7));
  render({ ...props, source: source(undefined, "v2") });
  (next.props.onClick as () => void)();
  expect(props.onConfirm).not.toHaveBeenCalled();
});
it("rechecks DOM bytes on confirmation rather than trusting stored coordinates", () => {
  render();
  const old = confirm(select(5, 7));
  node.textContent = "other";
  (old.props.onClick as () => void)();
  expect(props.onConfirm).not.toHaveBeenCalled();
  expect(props.onAvailability).toHaveBeenLastCalledWith({
    source: props.source,
    available: false,
  });
});
it("rejects a partial surrogate or CRLF endpoint", () => {
  render();
  for (const [start, end] of [
    [3, 4],
    [7, 8],
  ]) {
    expect(confirm(select(start, end)).props.disabled).toBe(true);
  }
  expect(props.onConfirm).not.toHaveBeenCalled();
});
it("leaving the component clears only the candidate and does not emit an opinion", () => {
  render();
  select(5, 7);
  const root = render()[0];
  (root.props.onBlurCapture as (e: unknown) => void)({
    relatedTarget: {},
    currentTarget: container,
  });
  expect(props.onAvailability).toHaveBeenLastCalledWith({
    source: props.source,
    available: false,
  });
  expect(props.onConfirm).not.toHaveBeenCalled();
});
it("exposes the available line range and disables selecting an empty source", () => {
  expect(
    render().some((n) => n.type === "p" && n.props.children === S.range(1, 2)),
  ).toBe(true);
  const nodes = render({ ...props, source: source("") });
  expect(
    nodes.some((n) => n.type === "p" && n.props.children === S.empty),
  ).toBe(true);
  expect(
    nodes.filter((n) => n.type === "input").every((n) => n.props.disabled),
  ).toBe(true);
});
