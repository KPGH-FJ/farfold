import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import type { VerifiedFile } from "../../../../../src/runtime/file_delivery";
import type {
  DocxCapture,
  DocxPreview,
  DocxParagraph,
  DocxTable,
} from "../../../../../src/runtime/docx_types";
import type {
  OfficeTargetAvailability,
  OfficeTargetConfirmation,
} from "../../../../../src/runtime/office_feedback_target";

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
vi.mock("../../../../../src/runtime/docx_preview", () => ({
  readDocxCapture: h.capture,
  readDocxPreview: h.parse,
}));
import { DocxFilePreview } from "../../../../../src/components/DocxFilePreview";
import { DOCUMENT_STRINGS as S } from "../../../../../src/runtime/document_strings";

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

import { documentFeedbackTarget } from "../../../../../src/runtime/docx_feedback_target";
it("same-file prepared replacement retires old source through ready and permits only the new document", async () => {
  await ready();
  const oldButton = buttons(select(), confirmParagraph)[0];
  const oldSource = props.onOfficeTargetAvailability.mock.lastCall![0].source;
  const oldAnchor = documentFeedbackTarget(oldSource);
  expect(oldAnchor).not.toBeNull();
  const replacement = document();
  expect(replacement.file).toBe(doc.file);
  const first = replacement.blocks[0] as DocxParagraph;
  first.source = { part: "word/document.xml", elementPath: [0, 80] };
  first.runs = [
    { kind: "text", text: "same-file new parsed object", style: {} },
  ];
  props = { ...props, prepared: { kind: "docx", file, value: replacement } };
  view();
  expect(documentFeedbackTarget(oldSource)).toBeNull();
  click(oldButton);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  await drain();
  const updated = view();
  expect(updated.html).toContain("same-file new parsed object");
  const current = select();
  const currentSource =
    props.onOfficeTargetAvailability.mock.lastCall![0].source;
  expect(currentSource).not.toBe(oldSource);
  expect(documentFeedbackTarget(currentSource)).toMatchObject({
    elementPath: [0, 80],
  });
  click(oldButton);
  expect(props.onOfficeTargetConfirm).not.toHaveBeenCalled();
  click(buttons(current, confirmParagraph)[0]);
  expect(props.onOfficeTargetConfirm).toHaveBeenCalledExactlyOnceWith({
    source: currentSource,
    anchor: documentFeedbackTarget(currentSource),
  });
  expect(h.capture).toHaveBeenCalledTimes(1);
  expect(h.parse).toHaveBeenCalledTimes(1);
});
