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
import type {
  DocxCapture,
  DocxPreview,
  DocxParagraph,
  DocxTable,
} from "../runtime/docx_types";
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
vi.mock("../runtime/docx_preview", () => ({
  readDocxCapture: h.capture,
  readDocxPreview: h.parse,
}));
import { DocxFilePreview } from "./DocxFilePreview";
import { DOCUMENT_STRINGS as S } from "../runtime/document_strings";

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
  path: "/work/positions.docx",
  resolvedPath: "/work/positions.docx",
  name: "positions.docx",
  size: 100,
  version: "one",
  sha256: "a".repeat(64),
};
const capture: DocxCapture = { file, parts: [], entries: [], inflatedBytes: 0 };
const para = (
  n: number,
  text = "重复正文",
  part = "word/document.xml",
): DocxParagraph => ({
  kind: "paragraph",
  id: `p${n}`,
  source: { part, elementPath: [0, n] },
  style: {},
  runs: [{ kind: "text", text, style: {} }],
});
function document(): DocxPreview {
  const table: DocxTable = {
    kind: "table",
    id: "table",
    source: { part: "word/document.xml", elementPath: [0, 5] },
    columnsPt: [90],
    rows: Array.from({ length: 22 }, (_, r) => ({
      cells: [
        {
          column: 0,
          rowSpan: 1,
          columnSpan: 1,
          blocks: [
            {
              ...para(100 + r),
              source: {
                part: "word/document.xml",
                elementPath: [0, 5, r, 0, 0],
              },
            },
          ],
        },
      ],
    })),
  };
  return {
    file,
    images: [],
    warnings: [],
    partial: true,
    blocks: [
      para(1),
      para(3),
      table,
      { kind: "notice", id: "notice", code: "unsupportedContent" },
      { ...para(7), runs: [{ kind: "notice", code: "hiddenContent" }] },
      { ...para(8), runs: [] },
      para(9, "长".repeat(40001)),
      ...Array.from({ length: 16 }, (_, n) => para(10 + n)),
    ],
    stories: [
      {
        id: "header",
        kind: "header",
        blocks: [para(1, "重复正文", "word/header1.xml")],
      },
    ],
  };
}
let doc: DocxPreview;
let props: Parameters<typeof DocxFilePreview>[0] & {
  interactionBlocked?: boolean;
  onOfficeTargetAvailability: Mock<(value: OfficeTargetAvailability) => void>;
  onOfficeTargetConfirm: Mock<(value: OfficeTargetConfirmation) => void>;
};
const drain = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function view() {
  return render(createElement(DocxFilePreview, props));
}
function buttons(v: ReturnType<typeof view>, label: string) {
  return v.all.filter((n) => n.type === "button" && n.props.children === label);
}
function click(n: Element | undefined) {
  expect(n).toBeDefined();
  expect(n!.props.disabled).not.toBe(true);
  (n!.props.onClick as () => void)();
}
const selectParagraph = "选择整个段落",
  selectTable = "选择整个表格";
const confirmParagraph = "对此段落提意见",
  confirmTable = "对此表格提意见";
async function ready() {
  view();
  await drain();
  view();
  return view();
}
function select(label = selectParagraph, index = 0) {
  click(buttons(view(), label)[index]);
  view();
  return view();
}
beforeEach(() => {
  h.slots.clear();
  h.effects = [];
  h.cursor = 0;
  doc = document();
  h.capture.mockReset().mockResolvedValue(capture);
  h.parse.mockReset().mockImplementation(async () => doc);
  props = {
    file,
    active: true,
    onOfficeTargetAvailability: vi.fn(),
    onOfficeTargetConfirm: vi.fn(),
  };
});
afterEach(() => h.slots.forEach((all) => all.forEach((s) => s.cleanup?.())));
it("selection registers a whole source paragraph and only an explicit second action confirms", async () => {
  await ready();
  const chosen = select();
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  expect(props.onOfficeTargetAvailability.mock.lastCall?.[0].available).toBe(
    true,
  );
  click(buttons(chosen, confirmParagraph)[0]);
  expect(props.onOfficeTargetConfirm).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      anchor: {
        kind: "docx-block",
        part: "word/document.xml",
        elementPath: [0, 1],
        blockKind: "paragraph",
      },
    }),
  );
});
it("repeated text selects its actual second block, not text or display-id matching", async () => {
  await ready();
  const chosen = select(selectParagraph, 1);
  click(buttons(chosen, confirmParagraph)[0]);
  expect(props.onOfficeTargetConfirm.mock.lastCall?.[0].anchor).toEqual({
    kind: "docx-block",
    part: "word/document.xml",
    elementPath: [0, 3],
    blockKind: "paragraph",
  });
});
it("the entire original table remains the target despite a smaller rendered window", async () => {
  await ready();
  const chosen = select(selectTable);
  click(buttons(chosen, confirmTable)[0]);
  expect(props.onOfficeTargetConfirm.mock.lastCall?.[0].anchor).toEqual({
    kind: "docx-block",
    part: "word/document.xml",
    elementPath: [0, 5],
    blockKind: "table",
  });
});
it("notice-only blocks have no action, but a genuine empty source paragraph does", async () => {
  const v = await ready();
  // 20 blocks on first segment: 1 table + 1 notice + 1 notice-only paragraph.
  expect(buttons(v, selectParagraph)).toHaveLength(17);
  const chosen = select(selectParagraph, 2);
  click(buttons(chosen, confirmParagraph)[0]);
  expect(props.onOfficeTargetConfirm.mock.lastCall?.[0].anchor).toEqual(
    expect.objectContaining({ elementPath: [0, 8] }),
  );
});
it("selecting another paragraph withdraws immediately and an old confirm cannot retarget", async () => {
  await ready();
  const chosen = select();
  const old = buttons(chosen, confirmParagraph)[0];
  const source = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  click(buttons(chosen, selectParagraph)[1]);
  expect(props.onOfficeTargetAvailability).toHaveBeenLastCalledWith({
    source,
    available: false,
  });
  click(old);
  view();
  click(old);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
});
it.each(["story", "segment", "paragraph-part", "table-window", "cell-detail"])(
  "%s transition withdraws before display changes",
  async (change) => {
    await ready();
    const chosen = select(
      change.startsWith("table") || change === "cell-detail"
        ? selectTable
        : selectParagraph,
      change === "paragraph-part" ? 3 : 0,
    );
    const old = buttons(
      chosen,
      change.startsWith("table") || change === "cell-detail"
        ? confirmTable
        : confirmParagraph,
    )[0];
    const source = props.onOfficeTargetAvailability.mock.lastCall![0].source;
    if (change === "story")
      (
        chosen.all.find((n) => n.type === "select")!.props.onChange as (
          e: unknown,
        ) => void
      )({ target: { value: "header" } });
    else if (change === "table-window") click(buttons(chosen, S.nextRows)[0]);
    else if (change === "cell-detail")
      click(chosen.all.find((n) => n.props["data-document-cell"] === "0:0"));
    else click(buttons(chosen, S.next)[change === "paragraph-part" ? 1 : 0]);
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
it("header targets preserve their actual part, and cell detail targets preserve nested original paths", async () => {
  let v = await ready();
  (
    v.all.find((n) => n.type === "select")!.props.onChange as (
      e: unknown,
    ) => void
  )({ target: { value: "header" } });
  view();
  click(buttons(select(), confirmParagraph)[0]);
  expect(props.onOfficeTargetConfirm.mock.lastCall?.[0].anchor).toEqual(
    expect.objectContaining({ part: "word/header1.xml" }),
  );
  (
    view().all.find((n) => n.type === "select")!.props.onChange as (
      e: unknown,
    ) => void
  )({ target: { value: "" } });
  view();
  click(view().all.find((n) => n.props["data-document-cell"] === "0:0"));
  view();
  const nested = buttons(view(), selectParagraph)[2];
  click(nested);
  view();
  click(buttons(view(), confirmParagraph)[0]);
  expect(props.onOfficeTargetConfirm.mock.lastCall?.[0].anchor).toEqual(
    expect.objectContaining({ elementPath: [0, 5, 0, 0, 0] }),
  );
});
it("blocking preserves body and readiness without read, then makes a fresh candidate", async () => {
  const status = vi.fn();
  props = { ...props, onStatus: status };
  await ready();
  const old = buttons(select(), confirmParagraph)[0];
  const source = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  const reads = h.capture.mock.calls.length,
    parses = h.parse.mock.calls.length;
  status.mockClear();
  props = { ...props, interactionBlocked: true };
  const blocked = view();
  expect(
    blocked.all.find((n) => n.props.className === "document-preview")!.props
      .inert,
  ).toBe(true);
  expect(blocked.html).toContain("重复正文");
  expect(status).not.toHaveBeenCalled();
  expect(props.onOfficeTargetAvailability).toHaveBeenLastCalledWith({
    source,
    available: false,
  });
  click(old);
  props = { ...props, interactionBlocked: false };
  view();
  const next = view();
  const fresh = props.onOfficeTargetAvailability.mock.lastCall![0];
  expect(fresh.available).toBe(true);
  expect(fresh.source).not.toBe(source);
  click(old);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  click(buttons(next, confirmParagraph)[0]);
  expect(props.onOfficeTargetConfirm.mock.lastCall?.[0].source).toBe(
    fresh.source,
  );
  expect(h.capture).toHaveBeenCalledTimes(reads);
  expect(h.parse).toHaveBeenCalledTimes(parses);
});
it.each(["hide", "version", "prepared"])(
  "%s invalidates old callbacks",
  async (change) => {
    await ready();
    const old = buttons(select(), confirmParagraph)[0];
    if (change === "hide") props = { ...props, active: false };
    else if (change === "version")
      props = {
        ...props,
        file: { ...file, version: "two", sha256: "b".repeat(64) },
      };
    else
      props = { ...props, prepared: { kind: "docx", file, value: document() } };
    view();
    click(old);
    expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
    expect(props.onOfficeTargetAvailability.mock.lastCall?.[0].available).toBe(
      false,
    );
  },
);
it("queued navigation cannot mutate a blocked view", async () => {
  const v = await ready();
  const selectStory = v.all.find((n) => n.type === "select")!;
  const next = buttons(v, S.next)[0];
  const cell = v.all.find((n) => n.props["data-document-cell"] === "0:0")!;
  props = { ...props, interactionBlocked: true };
  view();
  (selectStory.props.onChange as (e: unknown) => void)({
    target: { value: "header" },
  });
  click(next);
  click(cell);
  props = { ...props, interactionBlocked: false };
  const after = view();
  expect(after.all.find((n) => n.type === "select")!.props.value).toBe("");
  expect(after.html).toContain("内容第 1 / 2 部分");
  expect(buttons(after, S.backTable)).toHaveLength(0);
});
it("selecting the already selected paragraph keeps a usable candidate", async () => {
  await ready();
  const chosen = select();
  click(buttons(chosen, selectParagraph)[0]);
  view();
  click(buttons(view(), confirmParagraph)[0]);
  expect(props.onOfficeTargetConfirm).toHaveBeenCalledOnce();
});
it("StrictMode-style child-first effect replay retires the old source and registers a fresh one", async () => {
  await ready();
  const old = buttons(select(), confirmParagraph)[0];
  const source = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  const owners = [...h.slots].filter(([key]) =>
    key.includes("DocxDocumentView"),
  );
  for (const [, slots] of owners) for (const slot of slots) slot.cleanup?.();
  for (const [, slots] of owners.reverse())
    for (const slot of slots)
      if (slot.setup) slot.cleanup = slot.setup() || undefined;
  const next = props.onOfficeTargetAvailability.mock.lastCall![0];
  expect(next.available).toBe(true);
  expect(next.source).not.toBe(source);
  click(old);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  click(buttons(view(), confirmParagraph)[0]);
  expect(props.onOfficeTargetConfirm.mock.lastCall?.[0].source).toBe(
    next.source,
  );
});
it("removing integration retires the selected source without hiding the document", async () => {
  await ready();
  const chosen = select();
  const old = buttons(chosen, confirmParagraph)[0];
  const source = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  const { onOfficeTargetConfirm, ...rest } = props;
  const shown = render(createElement(DocxFilePreview, rest));
  expect(shown.html).toContain("重复正文");
  expect(props.onOfficeTargetAvailability).toHaveBeenLastCalledWith({
    source,
    available: false,
  });
  click(old);
  expect(onOfficeTargetConfirm).not.toHaveBeenCalled();
});
it("mutated source coordinates cannot be confirmed from a previously shown candidate", async () => {
  await ready();
  const chosen = select();
  (doc.blocks[0] as DocxParagraph).source = {
    part: "word/header1.xml",
    elementPath: [0, 0],
  };
  click(buttons(chosen, confirmParagraph)[0]);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
});
it("a partial paragraph still targets the entire original paragraph", async () => {
  await ready();
  const chosen = select(selectParagraph, 3);
  expect(chosen.html).toContain(S.feedbackParagraphScope);
  click(buttons(chosen, confirmParagraph)[0]);
  expect(props.onOfficeTargetConfirm.mock.lastCall?.[0].anchor).toEqual(
    expect.objectContaining({ elementPath: [0, 9] }),
  );
});
it("cancel selection withdraws only the candidate and returns focus without clearing a confirmed opinion", async () => {
  await ready();
  const chosen = select();
  click(buttons(chosen, confirmParagraph)[0]);
  const source = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  const selectButton = buttons(chosen, selectParagraph)[0];
  const focus = vi.fn();
  const elementRef = selectButton.props.ref as { current: unknown };
  // A DOM focus double only; both real browser engines check the actual focus.
  if (elementRef) elementRef.current = { focus, isConnected: true };
  click(buttons(chosen, "取消选择")[0]);
  expect(props.onOfficeTargetAvailability).toHaveBeenLastCalledWith({
    source,
    available: false,
  });
  expect(props.onOfficeTargetConfirm).toHaveBeenCalledTimes(1);
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  view();
  expect(buttons(view(), confirmParagraph)).toHaveLength(0);
  const next = select();
  click(buttons(next, confirmParagraph)[0]);
  expect(props.onOfficeTargetConfirm).toHaveBeenCalledTimes(2);
  expect(props.onOfficeTargetConfirm.mock.lastCall?.[0].source).not.toBe(
    source,
  );
});
it("a retired cancel button cannot withdraw another block's newer candidate", async () => {
  await ready();
  const chosen = select();
  const oldCancel = buttons(chosen, "取消选择")[0];
  expect(oldCancel).toBeDefined();
  const next = select(selectParagraph, 1);
  const source = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  click(oldCancel);
  expect(props.onOfficeTargetAvailability).toHaveBeenLastCalledWith({
    source,
    available: true,
  });
  click(buttons(next, confirmParagraph)[0]);
  expect(props.onOfficeTargetConfirm.mock.lastCall?.[0].source).toBe(source);
});
it("a withdrawal callback which leaves the view cannot refocus its old selection button", async () => {
  await ready();
  const chosen = select();
  const focus = vi.fn();
  (
    buttons(chosen, selectParagraph)[0].props.ref as { current: unknown }
  ).current = { focus, isConnected: true };
  props.onOfficeTargetAvailability.mockImplementation((value) => {
    if (!value.available) {
      props = { ...props, active: false };
      view();
    }
  });
  click(buttons(chosen, "取消选择")[0]);
  expect(focus).not.toHaveBeenCalled();
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
});
