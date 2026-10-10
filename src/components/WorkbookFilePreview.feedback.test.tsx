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
  };
});
afterEach(() => {
  h.slots.forEach((all) => all.forEach((s) => s.cleanup?.()));
});

it.each(["A1", "B1", "C1", "D1"])(
  "%s creates an explicit candidate without changing opinion first",
  async (address) => {
    await ready();
    const v = select(address);
    expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
    expect(props.onOfficeTargetAvailability).toHaveBeenLastCalledWith(
      expect.objectContaining({ available: true }),
    );
    click(button(v, confirmLabel));
    expect(props.onOfficeTargetConfirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        anchor: {
          kind: "xlsx-range",
          sheetId: "sheet-main",
          sheetName: "数据一",
          fromRow: 1,
          toRow: 1,
          fromColumn: address.charCodeAt(0) - 64,
          toColumn: address.charCodeAt(0) - 64,
        },
      }),
    );
  },
);
it("a clipped merge confirms the entire original range", async () => {
  await ready();
  const v = select("X99");
  expect(v.html).toContain(S.partialMerge);
  click(button(v, mergeLabel));
  expect(props.onOfficeTargetConfirm).toHaveBeenLastCalledWith(
    expect.objectContaining({
      anchor: expect.objectContaining({
        fromRow: 99,
        toRow: 102,
        fromColumn: 24,
        toColumn: 27,
      }),
    }),
  );
});
it("a hidden original anchor cannot become feedback until explicitly shown", async () => {
  await ready();
  const hidden = select("W11");
  expect(hidden.html).toContain(S.hiddenMerge);
  expect(button(hidden, mergeLabel)).toBeUndefined();
  const toggle = hidden.all.find(
    (n) => n.type === "input" && n.props.type === "checkbox",
  )!;
  (toggle.props.onChange as (e: unknown) => void)({
    target: { checked: true },
  });
  view();
  click(button(select("V10"), mergeLabel));
  expect(props.onOfficeTargetConfirm).toHaveBeenCalledOnce();
});

it("another cell retires the old candidate synchronously before rerender", async () => {
  await ready();
  const first = select("A1");
  const old = button(first, confirmLabel);
  const source = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  choose("B1", first);
  expect(props.onOfficeTargetAvailability).toHaveBeenLastCalledWith({
    source,
    available: false,
  });
  click(old);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  view();
  const next = view();
  const nextSource = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  expect(nextSource).not.toBe(source);
  click(button(next, confirmLabel));
  expect(props.onOfficeTargetConfirm).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      source: nextSource,
      anchor: expect.objectContaining({ fromColumn: 2, toColumn: 2 }),
    }),
  );
});

it.each(["window", "hidden", "detail", "sheet"])(
  "%s change synchronously withdraws rather than retargeting the opinion",
  async (change) => {
    await ready();
    const first = select("A1");
    const old = button(first, confirmLabel);
    const source = props.onOfficeTargetAvailability.mock.lastCall![0].source;
    if (change === "window") click(button(first, S.nextRows));
    else if (change === "detail") click(button(first, S.closeDetail));
    else {
      const control = first.all.find((n) =>
        change === "sheet"
          ? n.type === "select"
          : n.type === "input" && n.props.type === "checkbox",
      )!;
      (control.props.onChange as (event: unknown) => void)({
        target: { value: "rel_17", checked: true },
      });
    }
    expect(props.onOfficeTargetAvailability).toHaveBeenLastCalledWith({
      source,
      available: false,
    });
    click(old);
    view();
    click(old);
    expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  },
);

it.each(["hide", "version", "prepared"])(
  "%s transition rejects a callback from the retired display",
  async (change) => {
    await ready();
    const old = button(select("A1"), confirmLabel);
    if (change === "hide") props = { ...props, active: false };
    else if (change === "version")
      props = {
        ...props,
        file: { ...file, version: "two", sha256: "b".repeat(64) },
      };
    else
      props = {
        ...props,
        prepared: { kind: "workbook", file, capture, value: book("rel_17") },
      };
    view();
    click(old);
    expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
    expect(props.onOfficeTargetAvailability.mock.lastCall?.[0].available).toBe(
      false,
    );
  },
);

it("an explicitly chosen hidden worksheet keeps its own r:id and name", async () => {
  await ready();
  const control = view().all.find((n) => n.type === "select")!;
  (control.props.onChange as (e: unknown) => void)({
    target: { value: "hidden.note" },
  });
  await ready();
  click(button(select("A1"), confirmLabel));
  expect(props.onOfficeTargetConfirm).toHaveBeenLastCalledWith(
    expect.objectContaining({
      anchor: expect.objectContaining({
        sheetId: "hidden.note",
        sheetName: "隐藏资料",
      }),
    }),
  );
});

it("a replayed grid registration creates a new source instead of reusing its retired source", async () => {
  await ready();
  const old = button(select("A1"), confirmLabel);
  const source = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  const grid = [...h.slots].find(([key]) => key.includes("WorkbookGrid"))![1];
  for (const slot of grid) slot.cleanup?.();
  for (const slot of grid)
    if (slot.setup) slot.cleanup = slot.setup() || undefined;
  const nextSource = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  expect(nextSource).not.toBe(source);
  click(old);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  click(button(view(), confirmLabel));
  expect(props.onOfficeTargetConfirm).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ source: nextSource }),
  );
});

it("removing feedback integration withdraws the candidate without changing cell details", async () => {
  await ready();
  select("A1");
  const availability = props.onOfficeTargetAvailability;
  const v = render(
    createElement(WorkbookFilePreview, {
      file,
      active: true,
      onOfficeTargetAvailability: availability,
    }),
  );
  expect(availability.mock.lastCall?.[0].available).toBe(false);
  expect(v.html).toContain(S.value);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
});

it("the readable feedback label names the sheet and original range without its internal id", () => {
  const anchor = {
    kind: "xlsx-range" as const,
    sheetId: "rel_17",
    sheetName: "副本'与&同文",
    fromRow: 99,
    toRow: 102,
    fromColumn: 24,
    toColumn: 27,
  };
  expect(S.feedbackTarget(anchor)).toBe(
    "意见针对工作表“副本'与&同文”的 X99:AA102",
  );
  expect(
    S.feedbackTarget({
      ...anchor,
      fromRow: 1,
      toRow: 1,
      fromColumn: 1,
      toColumn: 1,
    }),
  ).toBe("意见针对工作表“副本'与&同文”的 A1");
});

it("interaction blocking preserves the loaded grid and ready state without another read", async () => {
  const onStatus = vi.fn();
  props = { ...props, onStatus };
  await ready();
  select("B1");
  onStatus.mockClear();
  const reads = h.capture.mock.calls.length;
  const parses = h.parse.mock.calls.length;
  props = { ...props, interactionBlocked: true };
  view();
  await drain();
  const blocked = view();
  const section = blocked.all.find((n) => n.type === "section")!;
  expect(section.props.inert).toBe(true);
  expect(section.props["aria-busy"]).toBe(false);
  expect(blocked.html).toContain('data-cell="B1"');
  expect(blocked.html).toContain(S.selected("B1"));
  expect(blocked.html).toContain("false");
  expect(onStatus).not.toHaveBeenCalled();
  expect(h.capture).toHaveBeenCalledTimes(reads);
  expect(h.parse).toHaveBeenCalledTimes(parses);
  props = { ...props, interactionBlocked: false };
  view();
  await drain();
  expect(view().all.find((n) => n.type === "section")!.props.inert).toBe(false);
  expect(onStatus).not.toHaveBeenCalled();
  expect(h.capture).toHaveBeenCalledTimes(reads);
  expect(h.parse).toHaveBeenCalledTimes(parses);
});

it("blocking retires the source and unblocking creates only a fresh candidate for the same cell", async () => {
  await ready();
  const old = button(select("A1"), confirmLabel);
  const source = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  props = { ...props, interactionBlocked: true };
  view();
  expect(props.onOfficeTargetAvailability).toHaveBeenLastCalledWith({
    source,
    available: false,
  });
  click(old);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  expect(button(view(), confirmLabel)).toBeUndefined();
  props = { ...props, interactionBlocked: false };
  view();
  const unblocked = view();
  const next = props.onOfficeTargetAvailability.mock.lastCall![0];
  expect(next.available).toBe(true);
  expect(next.source).not.toBe(source);
  click(old);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  click(button(unblocked, confirmLabel));
  expect(props.onOfficeTargetConfirm).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ source: next.source }),
  );
});

it.each(["cell", "sheet", "window", "hidden", "detail", "address", "jump"])(
  "a queued %s action cannot change the blocked display",
  async (action) => {
    await ready();
    const first = select("A1");
    const old = button(first, confirmLabel);
    const address = first.all.find(
      (n) => n.props["aria-label"] === S.address && n.type === "input",
    )!;
    (address.props.onChange as (event: unknown) => void)({
      target: { value: "B101" },
    });
    const shown = view();
    props = { ...props, interactionBlocked: true };
    view();
    const reads = h.capture.mock.calls.length;
    const parses = h.parse.mock.calls.length;
    if (action === "cell") choose("B1", shown);
    else if (action === "window") click(button(shown, S.nextRows));
    else if (action === "detail") click(button(shown, S.closeDetail));
    else if (action === "jump") {
      const form = shown.all.find((n) => n.type === "form")!;
      (form.props.onSubmit as (event: unknown) => void)({
        preventDefault() {},
      });
    } else {
      const control = shown.all.find((n) =>
        action === "sheet"
          ? n.type === "select"
          : n.type === "input" &&
            (action === "hidden"
              ? n.props.type === "checkbox"
              : n.props["aria-label"] === S.address),
      )!;
      (control.props.onChange as (event: unknown) => void)({
        target: {
          value: action === "sheet" ? "rel_17" : "C201",
          checked: true,
        },
      });
    }
    view();
    await drain();
    const blocked = view();
    expect(blocked.all.find((n) => n.type === "strong")?.props.children).toBe(
      S.selected("A1"),
    );
    expect(blocked.html).toContain('data-cell="A1"');
    expect(blocked.all.find((n) => n.type === "select")!.props.value).toBe(
      "sheet-main",
    );
    expect(
      blocked.all.find(
        (n) => n.type === "input" && n.props.type === "checkbox",
      )!.props.checked,
    ).toBe(false);
    expect(
      blocked.all.find(
        (n) => n.type === "input" && n.props["aria-label"] === S.address,
      )!.props.value,
    ).toBe("B101");
    expect(h.capture).toHaveBeenCalledTimes(reads);
    expect(h.parse).toHaveBeenCalledTimes(parses);
    click(old);
    expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  },
);

it("blocking an in-progress parse does not pause or restart it", async () => {
  let resolve!: (value: WorkbookPreview) => void;
  h.parse.mockImplementation(
    () =>
      new Promise<WorkbookPreview>((done) => {
        resolve = done;
      }),
  );
  const onStatus = vi.fn();
  props = { ...props, onStatus };
  view();
  await drain();
  const loading = view();
  const oldCancel = button(loading, S.cancel);
  props = { ...props, interactionBlocked: true };
  view();
  click(oldCancel);
  resolve(book());
  await drain();
  view();
  const blocked = view();
  expect(onStatus.mock.calls.map(([value]) => value.state)).toEqual([
    "loading",
    "ready",
  ]);
  expect(h.capture).toHaveBeenCalledOnce();
  expect(h.parse).toHaveBeenCalledOnce();
  expect(blocked.html).toContain('data-cell="A1"');
  expect(blocked.all.find((n) => n.type === "section")!.props.inert).toBe(true);
});

it("a queued retry remains inert until an explicit unblocked action", async () => {
  h.capture.mockRejectedValueOnce(new Error("controlled read failure"));
  await ready();
  const oldRetry = button(view(), S.retry);
  props = { ...props, interactionBlocked: true };
  view();
  click(oldRetry);
  await ready();
  expect(h.capture).toHaveBeenCalledOnce();
  props = { ...props, interactionBlocked: false };
  click(button(view(), S.retry));
  await ready();
  expect(h.capture).toHaveBeenCalledTimes(2);
  expect(view().html).toContain('data-cell="A1"');
});
