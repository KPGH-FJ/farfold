import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VerifiedFile } from "/Users/tw/Desktop/farfold/src/runtime/file_delivery";
import type {
  DocxCapture,
  DocxPreview,
  DocxParagraph,
  DocxTable,
} from "/Users/tw/Desktop/farfold/src/runtime/docx_types";
import type { PreviewReadingPositionRef } from "/Users/tw/Desktop/farfold/src/runtime/preview_reading_position";

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
vi.mock("/Users/tw/Desktop/farfold/src/runtime/docx_preview", () => ({
  readDocxCapture: h.capture,
  readDocxPreview: h.parse,
}));
import { DocxFilePreview } from "/Users/tw/Desktop/farfold/src/components/DocxFilePreview";
import { DOCUMENT_STRINGS as S } from "/Users/tw/Desktop/farfold/src/runtime/document_strings";

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
  path: "/work/windows.docx",
  resolvedPath: "/work/windows.docx",
  name: "windows.docx",
  size: 200,
  version: "one",
  sha256: "a".repeat(64),
};
function makeDocument(
  source = file,
  length = 40010,
  rows = 21,
  columns = 13,
): DocxPreview {
  const paragraph: DocxParagraph = {
    kind: "paragraph",
    id: "long",
    source: { part: "word/document.xml", elementPath: [0, 0] },
    style: {},
    runs: [{ kind: "text", text: "A".repeat(length), style: {} }],
  };
  const table: DocxTable = {
    kind: "table",
    id: "table",
    source: { part: "word/document.xml", elementPath: [0, 1] },
    columnsPt: Array(columns).fill(50),
    rows: Array.from({ length: rows }, (_, r) => ({
      cells: Array.from({ length: columns }, (_, c) => ({
        column: c,
        rowSpan: 1,
        columnSpan: 1,
        blocks: [
          {
            kind: "paragraph" as const,
            id: `p-${r}-${c}`,
            source: { part: "word/document.xml", elementPath: [0, 1, r, c, 0] },
            style: {},
            runs: [
              {
                kind: "text" as const,
                text: `CELL ${r + 1}/${c + 1}`,
                style: {},
              },
            ],
          },
        ],
      })),
    })),
  };
  return {
    file: source,
    images: [],
    warnings: [],
    partial: false,
    blocks: [paragraph, table],
    stories: [],
  };
}
let doc: DocxPreview;
let position: PreviewReadingPositionRef;
let props: Parameters<typeof DocxFilePreview>[0];
const drain = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const view = () => render(createElement(DocxFilePreview, props));
async function ready() {
  view();
  await drain();
  view();
  return view();
}
function action(v: ReturnType<typeof view>, text: string) {
  const n = v.all.find((n) => n.type === "button" && n.props.children === text);
  expect(n).toBeDefined();
  expect(n!.props.disabled).not.toBe(true);
  (n!.props.onClick as () => void)();
  return n!;
}
beforeEach(() => {
  h.slots.clear();
  h.effects = [];
  h.cursor = 0;
  doc = makeDocument();
  position = { current: null };
  h.capture.mockReset().mockImplementation(
    async (file) =>
      ({
        file,
        parts: [],
        entries: [],
        inflatedBytes: 0,
      }) satisfies DocxCapture,
  );
  h.parse.mockReset().mockImplementation(async () => doc);
  props = {
    file,
    active: true,
    readingPosition: position,
    onOfficeTargetConfirm: vi.fn(),
    onOfficeTargetAvailability: vi.fn(),
  };
});
afterEach(() => {
  for (const all of h.slots.values()) for (const s of all) s.cleanup?.();
  h.slots.clear();
});
it("withdrawal reentry that blocks the current view cannot save an old navigation", async () => {
  action(await ready(), S.selectParagraph);
  view();
  const next = view().all.find(
    (n) => n.type === "button" && n.props.children === S.next,
  )!;
  expect(next).toBeDefined();
  expect(props.onOfficeTargetAvailability).toHaveBeenCalledWith(
    expect.objectContaining({ available: true }),
  );
  const before = [...position.documentWindows!.positions];
  props = {
    ...props,
    onOfficeTargetAvailability: (value) => {
      if (!value.available) {
        props = { ...props, interactionBlocked: true };
        view();
      }
    },
  };
  view();
  (next.props.onClick as () => void)();
  expect([...position.documentWindows!.positions]).toEqual(before);
  expect(view().html.includes(S.paragraphPart(2, 2))).toBe(false);
});
