import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import type { VerifiedFile } from "../runtime/file_delivery";
import type { OfficeTargetEditing } from "../runtime/office_target_editing";
import type { WorkbookCapture, WorkbookPreview } from "../runtime/xlsx_types";
import type {
  OfficeTargetAvailability,
  OfficeTargetConfirmation,
} from "../runtime/office_feedback_target";

const h = vi.hoisted(() => ({
  owner: "",
  cursor: 0,
  slots: new Map<
    string,
    {
      value?: unknown;
      deps?: unknown[];
      cleanup?: () => void;
      setup?: () => void | (() => void);
    }[]
  >(),
  effects: [] as (() => void)[],
  capture: vi.fn(),
  parse: vi.fn(),
}));
vi.mock("react", async (original) => {
  const api = await original<typeof import("react")>();
  const slot = () => {
    let all = h.slots.get(h.owner);
    if (!all) h.slots.set(h.owner, (all = []));
    const index = h.cursor++;
    return { all, index, old: all[index] };
  };
  const effect = (setup: () => void | (() => void), deps?: unknown[]) => {
    const { all, index, old } = slot();
    if (!old || !deps || deps.some((x, i) => !Object.is(x, old.deps?.[i]))) {
      const next = (all[index] = { deps, setup, cleanup: old?.cleanup });
      h.effects.push(() => {
        old?.cleanup?.();
        next.cleanup = setup() || undefined;
      });
    }
  };
  return {
    ...api,
    useState: (initial: unknown) => {
      const { all, index, old } = slot();
      const state =
        old ??
        (all[index] = {
          value: typeof initial === "function" ? initial() : initial,
        });
      return [
        state.value,
        (v: unknown) => {
          state.value = typeof v === "function" ? v(state.value) : v;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const { all, index, old } = slot();
      return (old ?? (all[index] = { value: { current: initial } })).value;
    },
    useMemo: (read: () => unknown, deps: unknown[]) => {
      const { all, index, old } = slot();
      if (!old || deps.some((x, i) => !Object.is(x, old.deps?.[i])))
        all[index] = { value: read(), deps };
      return all[index].value;
    },
    useLayoutEffect: effect,
    useEffect: effect,
  };
});
vi.mock("../runtime/xlsx_preview", () => ({
  readWorkbookCapture: h.capture,
  readWorkbookPreview: h.parse,
}));
import { WorkbookFilePreview } from "./WorkbookFilePreview";
import { WORKBOOK_STRINGS as S } from "../runtime/workbook_strings";

type Element = ReactElement<Record<string, unknown>>;
// Real component/key/effect ownership; IPC/parser and browser layout are mocked.
// Real keyboard/focus/DOM is verified separately by the browser receipt.
function render(node: ReactNode) {
  const visited = new Set<string>(),
    all: Element[] = [];
  const resolve = (node: ReactNode, path: string): ReactNode => {
    if (!isValidElement<Record<string, unknown>>(node)) return node;
    const key = `${path}:${node.key ?? ""}`;
    if (typeof node.type === "function") {
      const owner = `${key}:${node.type.name}`;
      visited.add(owner);
      h.owner = owner;
      h.cursor = 0;
      return resolve(
        (node.type as (p: unknown) => ReactNode)(node.props),
        owner,
      );
    }
    const children = Children.toArray(node.props.children as ReactNode).map(
      (child, i) => resolve(child, `${key}/${i}`),
    );
    const result = createElement(node.type, node.props, ...children);
    all.push(result as Element);
    return result;
  };
  const result = resolve(node, "root");
  for (const [owner, slots] of h.slots)
    if (!visited.has(owner)) {
      slots.forEach((s) => s.cleanup?.());
      h.slots.delete(owner);
    }
  for (const fn of h.effects.splice(0)) fn();
  return { all, html: renderToStaticMarkup(result) };
}
const file: VerifiedFile = {
  root: "/work",
  path: "/work/positions.xlsx",
  resolvedPath: "/work/positions.xlsx",
  name: "positions.xlsx",
  size: 100,
  version: "one",
  sha256: "a".repeat(64),
};
const capture: WorkbookCapture = {
  file,
  parts: [],
  entries: [],
  inflatedBytes: 0,
};
function book(id = "sheet-main"): WorkbookPreview {
  return {
    date1904: false,
    sheets: [
      { id: "sheet-main", name: "数据一", state: "visible" },
      { id: "rel_17", name: "同文副本", state: "visible" },
      { id: "hidden.note", name: "隐藏资料", state: "hidden" },
    ],
    styles: [{ numFmt: "General", font: {}, borders: {} }],
    warnings: [],
    sheet: {
      id,
      rows: [{ index: 10, hidden: true }],
      columns: [{ min: 22, max: 22, hidden: true }],
      merges: [
        { fromRow: 99, toRow: 102, fromColumn: 24, toColumn: 27 },
        { fromRow: 10, toRow: 12, fromColumn: 22, toColumn: 23 },
      ],
      cells: [0, false, ""].map((value, i) => ({
        reference: `${String.fromCharCode(65 + i)}1`,
        row: 1,
        column: i + 1,
        type:
          typeof value === "number"
            ? "number"
            : typeof value === "boolean"
              ? "boolean"
              : "text",
        raw: String(value),
        value,
        display: String(value),
        styleId: 0,
        cacheState: "notFormula",
        formulaPresent: false,
        formula: null,
      })),
    },
  };
}
const drain = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
let props: Parameters<typeof WorkbookFilePreview>[0] & {
  interactionBlocked?: boolean;
  onOfficeTargetAvailability: Mock<(value: OfficeTargetAvailability) => void>;
  onOfficeTargetConfirm: Mock<(value: OfficeTargetConfirmation) => void>;
  onOfficeTargetEditing: Mock<(value: OfficeTargetEditing) => void>;
};
function view() {
  return render(createElement(WorkbookFilePreview, props));
}
function button(v: ReturnType<typeof view>, label: string) {
  return v.all.find((n) => n.type === "button" && n.props.children === label);
}
function click(n: Element | undefined) {
  expect(n).toBeDefined();
  expect(n!.props.disabled).not.toBe(true);
  (n!.props.onClick as () => void)();
}
function select(address: string) {
  const cell = view().all.find((n) => n.props["data-cell"] === address)!;
  const action = Children.toArray(
    cell.props.children as ReactNode,
  )[0] as Element;
  click(action);
  view();
  return view();
}
function choose(address: string, v = view()) {
  const cell = v.all.find((n) => n.props["data-cell"] === address)!;
  click(Children.toArray(cell.props.children as ReactNode)[0] as Element);
}
async function ready() {
  view();
  await drain();
  view();
  return view();
}
const confirmLabel = "对此单元格提意见";
const mergeLabel = "对整个合并范围提意见";
beforeEach(() => {
  h.slots.clear();
  h.effects = [];
  h.cursor = 0;
  h.capture.mockReset().mockResolvedValue(capture);
  h.parse.mockReset().mockImplementation(async (_capture, id) => book(id));
  props = {
    file,
    active: true,
    onOfficeTargetAvailability: vi.fn(),
    onOfficeTargetConfirm: vi.fn(),
    onOfficeTargetEditing: vi.fn(),
  };
});
afterEach(() => {
  h.slots.forEach((all) => all.forEach((s) => s.cleanup?.()));
});

const RANGE = "选择意见范围",
  INPUT = "意见范围",
  SUBMIT = "选择范围",
  CONFIRM = "对此范围提意见",
  CANCEL = "取消选择",
  HIDDEN = "范围包括这些隐藏行列";
function inputRange(value: string) {
  const field = view().all.find(
    (n) => n.type === "input" && n.props["aria-label"] === INPUT,
  );
  expect(field).toBeDefined();
  (field!.props.onChange as (event: unknown) => void)({ target: { value } });
  view();
}
function submitRange() {
  const form = view().all.find(
    (n) => n.type === "form" && n.props["aria-label"] === INPUT,
  );
  expect(form).toBeDefined();
  (form!.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  view();
  return view();
}
async function openRange() {
  await ready();
  click(button(view(), RANGE));
  view();
  return view();
}
it("range editing is reported before a valid coordinate exists, without creating a target", async () => {
  await openRange();
  expect(props.onOfficeTargetEditing).toHaveBeenLastCalledWith(
    expect.objectContaining({ file, editing: true }),
  );
  expect(props.onOfficeTargetAvailability).not.toHaveBeenCalledWith(
    expect.objectContaining({ available: true }),
  );
  inputRange("invalid");
  expect(submitRange().html).toContain("请输入当前工作表的范围");
  expect(button(view(), CONFIRM)).toBeUndefined();
});
it("reverse cross-window coordinates are exact and require a separate confirmation", async () => {
  await openRange();
  inputRange(" ab103:w98 ");
  const v = submitRange();
  expect(v.html).toContain("W98:AB103");
  expect(v.html).toContain("当前仅显示其中一部分");
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  click(button(v, CONFIRM));
  expect(props.onOfficeTargetConfirm).toHaveBeenLastCalledWith(
    expect.objectContaining({
      anchor: expect.objectContaining({
        fromRow: 98,
        toRow: 103,
        fromColumn: 23,
        toColumn: 28,
      }),
    }),
  );
});
it("partial merges keep the typed rectangle and disclose the full merge without expanding", async () => {
  await openRange();
  inputRange("Z101:AB103");
  const v = submitRange();
  expect(v.html).toContain("X99:AA102");
  expect(v.html).toContain("意见仍针对所填范围");
  click(button(v, CONFIRM));
  expect(props.onOfficeTargetConfirm).toHaveBeenLastCalledWith(
    expect.objectContaining({
      anchor: expect.objectContaining({
        fromRow: 101,
        toRow: 103,
        fromColumn: 26,
        toColumn: 28,
      }),
    }),
  );
});
it("hidden interior coordinates require separate acceptance and do not reveal values", async () => {
  await openRange();
  inputRange("U9:X13");
  let v = submitRange();
  expect(button(v, CONFIRM)).toBeUndefined();
  const check = v.all.find(
    (n) => n.type === "input" && n.props["aria-label"] === HIDDEN,
  )!;
  expect(check).toBeDefined();
  (check.props.onChange as (e: unknown) => void)({ target: { checked: true } });
  view();
  v = view();
  click(button(v, CONFIRM));
  expect(props.onOfficeTargetConfirm).toHaveBeenLastCalledWith(
    expect.objectContaining({
      anchor: expect.objectContaining({
        fromRow: 9,
        toRow: 13,
        fromColumn: 21,
        toColumn: 24,
      }),
    }),
  );
  expect(
    v.all.find(
      (n) =>
        n.type === "input" &&
        n.props.type === "checkbox" &&
        n.props["aria-label"] !== HIDDEN,
    )!.props.checked,
  ).toBe(false);
});
it("editing immediately retires a candidate and queued confirmation cannot change the opinion", async () => {
  await openRange();
  inputRange("A1:C2");
  const v = submitRange(),
    old = button(v, CONFIRM);
  const source = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  inputRange("Sheet2!A1");
  expect(props.onOfficeTargetAvailability).toHaveBeenLastCalledWith({
    source,
    available: false,
  });
  click(old);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  expect(button(submitRange(), CONFIRM)).toBeUndefined();
});
it("the last blank rectangle is bounded without allocating its cell area", async () => {
  await openRange();
  inputRange("A1:XFD1048576");
  let v = submitRange();
  const check = v.all.find(
    (n) => n.type === "input" && n.props["aria-label"] === HIDDEN,
  )!;
  (check.props.onChange as (e: unknown) => void)({ target: { checked: true } });
  view();
  v = view();
  expect(v.all.filter((n) => n.props["data-cell"]).length).toBeLessThanOrEqual(
    2400,
  );
  click(button(v, CONFIRM));
  expect(props.onOfficeTargetConfirm).toHaveBeenLastCalledWith(
    expect.objectContaining({
      anchor: expect.objectContaining({
        fromRow: 1,
        toRow: 1048576,
        fromColumn: 1,
        toColumn: 16384,
      }),
    }),
  );
});
it("cancel clears only the candidate, leaves the old opinion untouched and ends editing", async () => {
  await openRange();
  inputRange("A1:B2");
  const v = submitRange();
  click(button(v, CANCEL));
  view();
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  expect(props.onOfficeTargetAvailability.mock.lastCall![0].available).toBe(
    false,
  );
  expect(props.onOfficeTargetEditing.mock.lastCall![0].editing).toBe(false);
});
it("blocking keeps the parsed sheet and input while recreating only a fresh candidate on unblock", async () => {
  await openRange();
  inputRange("A1:C2");
  const v = submitRange(),
    old = button(v, CONFIRM);
  const before = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  props = { ...props, interactionBlocked: true };
  view();
  click(old);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  props = { ...props, interactionBlocked: false };
  view();
  const next = view();
  const after = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  expect(after).not.toBe(before);
  click(old);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  click(button(next, CONFIRM));
  expect(props.onOfficeTargetConfirm).toHaveBeenCalledOnce();
  expect(h.capture).toHaveBeenCalledOnce();
  expect(h.parse).toHaveBeenCalledOnce();
});
it.each(["Sheet2!A1", "A1,B2", "=A1", "A0", "XFE1", "A1048577", "A1:B2:C3"])(
  "invalid range %s cannot preserve an earlier confirmation",
  async (value) => {
    await openRange();
    inputRange("A1:B2");
    const v = submitRange(),
      old = button(v, CONFIRM);
    inputRange(value);
    submitRange();
    click(old);
    expect(button(view(), CONFIRM)).toBeUndefined();
    expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
    expect(h.capture).toHaveBeenCalledOnce();
    expect(h.parse).toHaveBeenCalledOnce();
  },
);
it("hidden acceptance is discarded on input change even when it names the same cells", async () => {
  await openRange();
  inputRange("U9:X13");
  let v = submitRange();
  const checkbox = () =>
    view().all.find(
      (n) => n.type === "input" && n.props["aria-label"] === HIDDEN,
    )!;
  (checkbox().props.onChange as (e: unknown) => void)({
    target: { checked: true },
  });
  view();
  v = view();
  const old = button(v, CONFIRM);
  inputRange("U9:X13 ");
  v = submitRange();
  expect(checkbox().props.checked).toBe(false);
  expect(button(v, CONFIRM)).toBeUndefined();
  click(old);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
});
it("entering range mode retires the old cell and selecting a cell closes range ownership", async () => {
  await ready();
  const cell = select("A1"),
    oldCell = button(cell, confirmLabel);
  click(button(cell, RANGE));
  view();
  inputRange("B1:C2");
  const v = submitRange(),
    oldRange = button(v, CONFIRM);
  click(oldCell);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  choose("C1", v);
  view();
  const next = view();
  click(oldRange);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  expect(props.onOfficeTargetEditing.mock.lastCall![0].editing).toBe(false);
  click(button(next, confirmLabel));
  expect(props.onOfficeTargetConfirm.mock.lastCall![0].anchor).toEqual(
    expect.objectContaining({
      fromColumn: 3,
      toColumn: 3,
      fromRow: 1,
      toRow: 1,
    }),
  );
});
it.each(["window", "hidden", "sheet", "hide", "version"])(
  "%s retires range ownership and cannot confirm a late range",
  async (change) => {
    await openRange();
    inputRange("A1:C2");
    const v = submitRange(),
      old = button(v, CONFIRM);
    if (change === "window") click(button(v, S.nextRows));
    else if (change === "hidden") {
      const control = v.all.find(
        (n) => n.type === "input" && n.props.type === "checkbox",
      )!;
      (control.props.onChange as (e: unknown) => void)({
        target: { checked: true },
      });
    } else if (change === "sheet") {
      const control = v.all.find((n) => n.type === "select")!;
      (control.props.onChange as (e: unknown) => void)({
        target: { value: "rel_17" },
      });
    } else
      props =
        change === "hide"
          ? { ...props, active: false }
          : {
              ...props,
              file: { ...file, version: "next", sha256: "b".repeat(64) },
            };
    view();
    click(old);
    expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
    expect(props.onOfficeTargetEditing.mock.lastCall![0].editing).toBe(false);
  },
);
it("blocked queued form handlers cannot change the candidate or hidden acknowledgement", async () => {
  await openRange();
  inputRange("U9:X13");
  const v = submitRange();
  const oldInput = v.all.find(
    (n) => n.type === "input" && n.props["aria-label"] === INPUT,
  )!;
  const oldCheck = v.all.find(
    (n) => n.type === "input" && n.props["aria-label"] === HIDDEN,
  )!;
  const oldForm = v.all.find(
    (n) => n.type === "form" && n.props["aria-label"] === INPUT,
  )!;
  props = { ...props, interactionBlocked: true };
  view();
  (oldInput.props.onChange as (e: unknown) => void)({
    target: { value: "A1" },
  });
  (oldCheck.props.onChange as (e: unknown) => void)({
    target: { checked: true },
  });
  (oldForm.props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
  click(button(v, CANCEL));
  const blocked = view();
  expect(
    blocked.all.find(
      (n) => n.type === "input" && n.props["aria-label"] === INPUT,
    )!.props.value,
  ).toBe("U9:X13");
  expect(
    blocked.all.find(
      (n) => n.type === "input" && n.props["aria-label"] === HIDDEN,
    )!.props.checked,
  ).toBe(false);
  expect(props.onOfficeTargetEditing.mock.lastCall![0].editing).toBe(true);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
});
it("a queued cancel or hidden checkbox from old input cannot clear a newer candidate", async () => {
  await openRange();
  inputRange("U9:X13");
  const first = submitRange();
  const cancel = button(first, CANCEL),
    check = first.all.find(
      (n) => n.type === "input" && n.props["aria-label"] === HIDDEN,
    )!;
  inputRange("A1:B2");
  const second = submitRange();
  const source = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  click(cancel);
  (check.props.onChange as (e: unknown) => void)({ target: { checked: true } });
  view();
  click(button(view(), CONFIRM));
  expect(props.onOfficeTargetConfirm).toHaveBeenLastCalledWith(
    expect.objectContaining({
      source,
      anchor: expect.objectContaining({
        fromColumn: 1,
        toColumn: 2,
        fromRow: 1,
        toRow: 2,
      }),
    }),
  );
  expect(button(second, CONFIRM)).toBeDefined();
});
it("replayed range effects issue a new editing owner and permanently retire the old source", async () => {
  await openRange();
  inputRange("A1:C2");
  const v = submitRange(),
    old = button(v, CONFIRM);
  const source = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  const owner = props.onOfficeTargetEditing.mock.lastCall![0].owner;
  const slots = [...h.slots].find(([key]) =>
    key.includes("WorkbookRangeSelection"),
  )![1];
  for (const slot of slots) slot.cleanup?.();
  for (const slot of slots)
    if (slot.setup) slot.cleanup = slot.setup() || undefined;
  const nextSource = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  const nextOwner = props.onOfficeTargetEditing.mock.lastCall![0].owner;
  expect(nextSource).not.toBe(source);
  expect(nextOwner).not.toBe(owner);
  expect(props.onOfficeTargetEditing).toHaveBeenCalledWith({
    owner,
    file,
    editing: false,
  });
  click(old);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  click(button(view(), CONFIRM));
  expect(props.onOfficeTargetConfirm).toHaveBeenLastCalledWith(
    expect.objectContaining({ source: nextSource }),
  );
});
it("removing feedback integration releases editing and retires the candidate", async () => {
  await openRange();
  inputRange("A1:C2");
  const v = submitRange(),
    old = button(v, CONFIRM);
  const availability = props.onOfficeTargetAvailability,
    editing = props.onOfficeTargetEditing;
  render(
    createElement(WorkbookFilePreview, {
      file,
      active: true,
      onOfficeTargetAvailability: availability,
      onOfficeTargetEditing: editing,
    }),
  );
  click(old);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  expect(availability.mock.lastCall![0].available).toBe(false);
  expect(editing.mock.lastCall![0].editing).toBe(false);
});
it("coordinate disclosure renders only a bounded page and blocked old navigation is inert", async () => {
  h.parse.mockImplementation(async () => {
    const value = book();
    value.sheet!.rows = Array.from({ length: 100 }, (_, i) => ({
      index: i * 2 + 1,
      hidden: true,
    }));
    return value;
  });
  await openRange();
  inputRange("A1:B200");
  const v = submitRange();
  expect(v.html).toContain("显示第 1–20 项，共 100 项");
  expect(v.html).not.toContain("39、41");
  const next = button(v, "下一组位置");
  props = { ...props, interactionBlocked: true };
  view();
  click(next);
  expect(view().html).toContain("显示第 1–20 项，共 100 项");
  props = { ...props, interactionBlocked: false };
  view();
  click(button(view(), "下一组位置"));
  expect(view().html).toContain("显示第 21–40 项，共 100 项");
});
it("partial merge highlighting is explicitly distinct from a wholly included merge", async () => {
  await openRange();
  inputRange("W98:Z100");
  const v = submitRange();
  expect(
    v.all.find((n) => n.props["data-cell"] === "X99")!.props[
      "data-opinion-range"
    ],
  ).toBe("partial");
  expect(v.html).toContain(S.feedbackRangeIntersection);
  inputRange("W98:AB103");
  const whole = submitRange();
  expect(
    whole.all.find((n) => n.props["data-cell"] === "X99")!.props[
      "data-opinion-range"
    ],
  ).toBe("inside");
});
it("retirement that synchronously removes the form cannot report a range to its retired owner", async () => {
  const { WorkbookRangeSelection } = await import("./WorkbookRangeSelection");
  let live = true;
  const onRange = vi.fn();
  const leaf = {
    file,
    capture,
    preview: book(),
    hiddenSheetSelected: false,
    interactionBlocked: false,
    window: { firstRow: 1, lastRow: 100, firstColumn: 1, lastColumn: 24 },
    isCurrent: () => live,
    retireSelection: { current: null as (() => void) | null },
    onOfficeTargetConfirm: vi.fn(),
    onRange,
    onClose: vi.fn(),
    onOfficeTargetAvailability: (value: OfficeTargetAvailability) => {
      if (!value.available) {
        live = false;
        render(null);
      }
    },
  };
  const draw = () => render(createElement(WorkbookRangeSelection, leaf));
  let v = draw();
  (
    v.all.find((n) => n.type === "input" && n.props["aria-label"] === INPUT)!
      .props.onChange as (e: unknown) => void
  )({ target: { value: "A1:B2" } });
  v = draw();
  (
    v.all.find((n) => n.type === "form")!.props.onSubmit as (e: unknown) => void
  )({ preventDefault() {} });
  draw();
  v = draw();
  onRange.mockClear();
  (
    v.all.find((n) => n.type === "input" && n.props["aria-label"] === INPUT)!
      .props.onChange as (e: unknown) => void
  )({ target: { value: "C1:D2" } });
  expect(live).toBe(false);
  expect(onRange).not.toHaveBeenCalled();
});
