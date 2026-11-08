import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VerifiedFile } from "../runtime/file_delivery";
import type { DocxPreview } from "../runtime/docx_types";
import type {
  WorkbookDirectory,
  WorkbookPreview,
  WorkbookSheetRestore,
} from "../runtime/xlsx_types";
import { selectedWorkbookSheetId } from "../runtime/xlsx_directory";
import type { PreviewReadingPositionRef } from "../runtime/preview_reading_position";
const h = vi.hoisted(() => ({
  owner: "",
  cursor: 0,
  slots: new Map<
    string,
    { value?: unknown; deps?: unknown[]; cleanup?: () => void }[]
  >(),
  effects: [] as (() => void)[],
  captureWorkbook: vi.fn(),
  readWorkbook: vi.fn(),
  captureDocument: vi.fn(),
  readDocument: vi.fn(),
}));
vi.mock("react", async (original) => {
  const api = await original<typeof import("react")>();
  const slot = () => {
    let all = h.slots.get(h.owner);
    if (!all) h.slots.set(h.owner, (all = []));
    const index = h.cursor++;
    return { all, index, previous: all[index] };
  };
  const effect = (fn: () => void | (() => void), deps?: unknown[]) => {
    const { all, index, previous } = slot();
    if (
      !previous ||
      !deps ||
      deps.some((x, i) => !Object.is(x, previous.deps?.[i]))
    ) {
      const next = (all[index] = { deps, cleanup: previous?.cleanup });
      h.effects.push(() => {
        previous?.cleanup?.();
        next.cleanup = fn() || undefined;
      });
    }
  };
  return {
    ...api,
    useState: (initial: unknown) => {
      const { all, index, previous } = slot();
      const state =
        previous ??
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
      const { all, index, previous } = slot();
      return (previous ?? (all[index] = { value: { current: initial } })).value;
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const { all, index, previous } = slot();
      if (!previous || deps.some((x, i) => !Object.is(x, previous.deps?.[i])))
        all[index] = { value: fn(), deps };
      return all[index].value;
    },
    useLayoutEffect: effect,
    useEffect: effect,
  };
});
vi.mock("../runtime/xlsx_preview", () => ({
  readWorkbookCapture: h.captureWorkbook,
  readWorkbookPreview: h.readWorkbook,
}));
vi.mock("../runtime/docx_preview", () => ({
  readDocxCapture: h.captureDocument,
  readDocxPreview: h.readDocument,
}));
import { WorkbookFilePreview } from "./WorkbookFilePreview";
import { DocxFilePreview } from "./DocxFilePreview";
import { cellAddress } from "../runtime/workbook_view";
import { WORKBOOK_STRINGS as W } from "../runtime/workbook_strings";
import { DOCUMENT_STRINGS as D } from "../runtime/document_strings";
type Element = ReactElement<Record<string, unknown>>;
// Explicit component/key ownership and unmount cleanup; parser/IPC are mocked.
// This harness verifies React component state contracts, not browser layout.
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
  return { html: renderToStaticMarkup(result), all };
}
const source: VerifiedFile = {
  root: "/work",
  path: "/work/a.xlsx",
  resolvedPath: "/work/a.xlsx",
  name: "a.xlsx",
  size: 32,
  sha256: "h1",
  version: "v1",
};
const changed = { ...source, sha256: "h2", version: "v2" };
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));
function book(
  file: VerifiedFile,
  id = "first",
  row = 220,
  column = 30,
): WorkbookPreview {
  return {
    date1904: false,
    sheets: [
      { id: "first", name: "First", state: "visible" },
      { id: "second", name: "Second", state: "visible" },
    ],
    styles: [{ numFmt: "General", font: {}, borders: {} }],
    warnings: [],
    sheet: {
      id,
      cells: [
        {
          reference: cellAddress(row, column),
          row,
          column,
          type: "text",
          value: `${file.version}-${id}`,
          raw: `${file.version}-${id}`,
          cacheState: "notFormula",
          formulaPresent: false,
          formula: null,
          display: null,
          styleId: 0,
        },
      ],
      rows: [],
      columns: [],
      merges: [],
    },
  };
}
// Match the current preview port: resolve a saved location against this new
// directory before returning one completed sheet, with the same dimensions.
function workbookReader(row = 220, column = 30) {
  return async (
    capture: { file: VerifiedFile },
    id: string | undefined,
    _signal: AbortSignal,
    onDirectory?: (directory: WorkbookDirectory) => void,
    restoreSheet?: WorkbookSheetRestore,
  ) => {
    const sheets = book(capture.file).sheets;
    const selected = selectedWorkbookSheetId(sheets, id, restoreSheet);
    const value = book(capture.file, selected, row, column);
    onDirectory?.({ sheets: value.sheets, selectedId: value.sheet!.id });
    return value;
  };
}
function document(file: VerifiedFile, count = 45): DocxPreview {
  const blocks = Array.from({ length: count }, (_, i) => ({
    kind: "paragraph" as const,
    id: `p${i}`,
    source: { part: "word/footnotes.xml", elementPath: [2, i] },
    style: {},
    runs: [
      { kind: "text" as const, style: {}, text: `${file.version}-note-${i}` },
    ],
  }));
  return {
    file,
    blocks: [
      {
        kind: "paragraph",
        id: "body",
        source: { part: "word/document.xml", elementPath: [0, 0] },
        style: {},
        runs: [{ kind: "text", style: {}, text: `${file.version}-body` }],
      },
    ],
    stories: [{ id: "note:7", kind: "footnote", noteId: "7", blocks }],
    images: [],
    warnings: [],
    partial: false,
  };
}
function action(view: ReturnType<typeof render>, label: string) {
  const node = view.all.find(
    (n) => n.type === "button" && n.props.children === label,
  );
  expect(node).toBeDefined();
  (node!.props.onClick as () => void)();
}
beforeEach(() => {
  h.slots.clear();
  h.effects = [];
  vi.clearAllMocks();
  h.captureWorkbook.mockImplementation(async (file) => ({ file }));
  h.readWorkbook.mockImplementation(workbookReader());
  h.captureDocument.mockImplementation(async (file) => ({ file }));
  h.readDocument.mockImplementation(async (capture) => document(capture.file));
});
afterEach(() => {
  for (const slots of h.slots.values())
    for (const slot of slots) slot.cleanup?.();
  h.slots.clear();
});
it("restores the matching sheet/window on a new revision and clamps to real shrunken bounds", async () => {
  const position: PreviewReadingPositionRef = {
    current: {
      root: source.root,
      resolvedPath: source.resolvedPath,
      kind: "workbook",
      sheet: { id: "second", name: "Second" },
      row: 201,
      column: 25,
      showHidden: false,
    },
  };
  const node = (
    <WorkbookFilePreview file={changed} active readingPosition={position} />
  );
  render(node);
  await drain();
  let view = render(node);
  await drain();
  view = render(node);
  expect(view.html).toContain('value="second" selected');
  expect(view.html).toContain("Y201");
  expect(view.html).toContain("v2-second");
  expect(h.readWorkbook).toHaveBeenCalledOnce();
  expect(h.readWorkbook.mock.calls[0][4]).toEqual({
    id: "second",
    name: "Second",
  });
  h.readWorkbook.mockImplementation(workbookReader(8, 4));
  render(null);
  const small = (
    <WorkbookFilePreview
      file={{ ...changed, version: "v3", sha256: "h3" }}
      active
      readingPosition={position}
    />
  );
  render(small);
  await drain();
  render(small);
  await drain();
  view = render(small);
  expect(view.html).toContain("D8");
  expect(view.html).not.toContain("v2-second");
  expect(position.current).toMatchObject({ row: 8, column: 4 });
});
it("retains document story and segment across unmount and clamps when its contents shrink", async () => {
  const file = {
    ...source,
    path: "/work/a.docx",
    resolvedPath: "/work/a.docx",
    name: "a.docx",
  };
  const position: PreviewReadingPositionRef = {
    current: {
      root: file.root,
      resolvedPath: file.resolvedPath,
      kind: "document",
      story: { id: "note:7", kind: "footnote", noteId: "7" },
      segment: 2,
    },
  };
  const node = (
    <DocxFilePreview file={file} active readingPosition={position} />
  );
  render(node);
  await drain();
  let view = render(node);
  expect(view.html).toContain("v1-note-40");
  expect(view.html).not.toContain("v1-body");
  render(null);
  h.readDocument.mockImplementation(async (capture) =>
    document(capture.file, 21),
  );
  const next = (
    <DocxFilePreview
      file={{ ...file, version: "v2", sha256: "h2" }}
      active
      readingPosition={position}
    />
  );
  render(next);
  await drain();
  view = render(next);
  expect(view.html).toContain("v2-note-20");
  expect(view.html).not.toContain("v1-note");
  expect(position.current).toMatchObject({ segment: 1 });
});
it("keeps a chosen document segment when hidden and later shown", async () => {
  const position: PreviewReadingPositionRef = { current: null };
  const file = {
    ...source,
    path: "/work/a.docx",
    resolvedPath: "/work/a.docx",
    name: "a.docx",
  };
  h.readDocument.mockImplementation(async (capture) => ({
    ...document(capture.file),
    blocks: document(capture.file).stories[0].blocks,
    stories: [],
  }));
  const node = (
    <DocxFilePreview file={file} active readingPosition={position} />
  );
  render(node);
  await drain();
  let view = render(node);
  action(view, D.next);
  view = render(node);
  expect(view.html).toContain("v1-note-20");
  render(
    <DocxFilePreview file={file} active={false} readingPosition={position} />,
  );
  render(node);
  await drain();
  view = render(node);
  expect(view.html).toContain("v1-note-20");
});

it("does not carry a selected cell's old value or detail into the next verified revision", async () => {
  const position: PreviewReadingPositionRef = {
    current: {
      root: source.root,
      resolvedPath: source.resolvedPath,
      kind: "workbook",
      sheet: { id: "second", name: "Second" },
      row: 201,
      column: 25,
      showHidden: false,
    },
  };
  let node = (
    <WorkbookFilePreview file={source} active readingPosition={position} />
  );
  render(node);
  await drain();
  let view = render(node);
  const cell = view.all.find(
    (n) =>
      n.type === "button" &&
      n.props["aria-label"] === `${W.selected("AD220")}：v1-second`,
  );
  expect(cell).toBeDefined();
  (cell!.props.onClick as () => void)();
  view = render(node);
  expect(view.html.includes("workbook-cell-detail")).toBe(true);
  node = (
    <WorkbookFilePreview file={changed} active readingPosition={position} />
  );
  view = render(node);
  expect(view.html.includes("v1-second")).toBe(false);
  await drain();
  view = render(node);
  expect(view.html.includes("v2-second")).toBe(true);
  expect(view.html.includes("workbook-cell-detail")).toBe(false);
});
it("a removed sheet falls back without borrowing its coordinates, and hidden/retry keeps the current window", async () => {
  const position: PreviewReadingPositionRef = {
    current: {
      root: source.root,
      resolvedPath: source.resolvedPath,
      kind: "workbook",
      sheet: { id: "removed", name: "Gone" },
      row: 201,
      column: 25,
      showHidden: true,
    },
  };
  const node = (
    <WorkbookFilePreview file={source} active readingPosition={position} />
  );
  render(node);
  await drain();
  let view = render(node);
  expect(position.current).toMatchObject({
    sheet: { id: "first", name: "First" },
    row: 1,
    column: 1,
    showHidden: false,
  });
  action(view, W.nextRows);
  view = render(node);
  expect(position.current).toMatchObject({ row: 101 });
  render(
    <WorkbookFilePreview
      file={source}
      active={false}
      readingPosition={position}
    />,
  );
  render(node);
  await drain();
  view = render(node);
  expect(view.html.includes("A101")).toBe(true);
});
it("a removed document story returns to body while a late old document cannot replace the new position", async () => {
  const file = {
    ...source,
    path: "/work/a.docx",
    resolvedPath: "/work/a.docx",
    name: "a.docx",
  };
  const position: PreviewReadingPositionRef = {
    current: {
      root: file.root,
      resolvedPath: file.resolvedPath,
      kind: "document",
      story: { id: "gone", kind: "footnote", noteId: "7" },
      segment: 2,
    },
  };
  let finish!: (d: DocxPreview) => void;
  h.readDocument.mockImplementationOnce(
    () => new Promise<DocxPreview>((yes) => (finish = yes)),
  );
  render(<DocxFilePreview file={file} active readingPosition={position} />);
  await drain();
  const next = { ...file, version: "v2", sha256: "h2" };
  const node = (
    <DocxFilePreview file={next} active readingPosition={position} />
  );
  render(node);
  await drain();
  let view = render(node);
  expect(view.html.includes("v2-body")).toBe(true);
  expect(position.current).toMatchObject({ story: null, segment: 0 });
  finish(document(file));
  await drain();
  view = render(node);
  expect(view.html.includes("v1-note")).toBe(false);
  expect(view.html.includes("v2-body")).toBe(true);
  expect(position.current).toMatchObject({ story: null, segment: 0 });
});
it("cancelled workbook restoration preserves the previous position and ignores the late parser result", async () => {
  const position: PreviewReadingPositionRef = {
    current: {
      root: source.root,
      resolvedPath: source.resolvedPath,
      kind: "workbook",
      sheet: { id: "second", name: "Second" },
      row: 201,
      column: 25,
      showHidden: false,
    },
  };
  const previous = position.current;
  let finish!: (d: WorkbookPreview) => void;
  h.readWorkbook.mockImplementationOnce(
    () => new Promise<WorkbookPreview>((yes) => (finish = yes)),
  );
  const node = (
    <WorkbookFilePreview file={changed} active readingPosition={position} />
  );
  render(node);
  await drain();
  action(render(node), W.cancel);
  finish(book(changed));
  await drain();
  const view = render(node);
  expect(view.html.includes("v2-first")).toBe(false);
  expect(position.current).toBe(previous);
});

it("uses a prepared matching document without a new capture, and reports owned readiness", async () => {
  const status = vi.fn(),
    prepared = { kind: "docx" as const, file: source, value: document(source) };
  const node = (
    <DocxFilePreview
      file={source}
      active
      prepared={prepared}
      onStatus={status}
    />
  );
  render(node);
  await drain();
  render(node);
  expect(h.captureDocument).not.toHaveBeenCalled();
  expect(h.readDocument).not.toHaveBeenCalled();
  expect(status).toHaveBeenLastCalledWith({ file: source, state: "ready" });
});
it("adopts a prepared workbook but reselects the latest position from its same capture", async () => {
  const position: PreviewReadingPositionRef = {
    current: {
      root: source.root,
      resolvedPath: source.resolvedPath,
      kind: "workbook",
      sheet: { id: "second", name: "Second" },
      row: 201,
      column: 25,
      showHidden: false,
    },
  };
  const prepared = {
    kind: "workbook" as const,
    file: source,
    capture: { file: source, parts: [], entries: [], inflatedBytes: 1 },
    value: book(source, "first"),
  };
  const node = (
    <WorkbookFilePreview
      file={source}
      active
      prepared={prepared}
      readingPosition={position}
    />
  );
  render(node);
  await drain();
  render(node);
  await drain();
  const view = render(node);
  expect(h.captureWorkbook).not.toHaveBeenCalled();
  expect(h.readWorkbook).toHaveBeenCalledOnce();
  expect(h.readWorkbook.mock.calls[0][0]).toBe(prepared.capture);
  expect(view.html).toContain('value="second" selected');
});
it("does not consume prepared data from another verified version", async () => {
  const prepared = {
    kind: "docx" as const,
    file: source,
    value: document(source),
  };
  const node = <DocxFilePreview file={changed} active prepared={prepared} />;
  render(node);
  await drain();
  const view = render(node);
  expect(h.captureDocument).toHaveBeenCalledOnce();
  expect(view.html).toContain("v2-body");
  expect(view.html).not.toContain("v1-body");
});

it.each(["docx", "workbook"] as const)(
  "%s keeps an in-flight capture across hide and reports late pending without auto retry",
  async (kind) => {
    const status = vi.fn();
    let reject!: (e: unknown) => void;
    const capture = kind === "docx" ? h.captureDocument : h.captureWorkbook;
    capture.mockImplementationOnce(() => new Promise((_, no) => (reject = no)));
    const element = (active: boolean) =>
      kind === "docx" ? (
        <DocxFilePreview file={source} active={active} onStatus={status} />
      ) : (
        <WorkbookFilePreview file={source} active={active} onStatus={status} />
      );
    render(element(true));
    await drain();
    const signal = capture.mock.calls[0][1] as AbortSignal;
    render(element(false));
    render(element(true));
    await drain();
    expect(capture).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(false);
    const ErrorClass =
      kind === "docx"
        ? (await import("../runtime/docx_types")).DocxError
        : (await import("../runtime/xlsx_types")).XlsxError;
    reject(new ErrorClass("readPending"));
    await drain();
    render(element(true));
    expect(status).toHaveBeenLastCalledWith({
      file: source,
      state: "failed",
      code: "readPending",
    });
    render(element(false));
    render(element(true));
    await drain();
    const view = render(element(true));
    expect(capture).toHaveBeenCalledOnce();
    action(view, kind === "docx" ? "重新预览" : "重新预览");
    render(element(true));
    await drain();
    render(element(true));
    expect(capture).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenLastCalledWith({ file: source, state: "ready" });
  },
);

it.each(["docx", "workbook"] as const)(
  "%s does not let an obsolete capture failure replace same-file prepared readiness",
  async (kind) => {
    const status = vi.fn();
    let reject!: (e: unknown) => void;
    const capture = kind === "docx" ? h.captureDocument : h.captureWorkbook;
    capture.mockImplementationOnce(() => new Promise((_, no) => (reject = no)));
    const initial =
      kind === "docx" ? (
        <DocxFilePreview file={source} active onStatus={status} />
      ) : (
        <WorkbookFilePreview file={source} active onStatus={status} />
      );
    render(initial);
    await drain();
    const prepared =
      kind === "docx" ? (
        <DocxFilePreview
          file={source}
          active
          onStatus={status}
          prepared={{ kind: "docx", file: source, value: document(source) }}
        />
      ) : (
        <WorkbookFilePreview
          file={source}
          active
          onStatus={status}
          prepared={{
            kind: "workbook",
            file: source,
            capture: { file: source, parts: [], entries: [], inflatedBytes: 1 },
            value: book(source),
          }}
        />
      );
    render(prepared);
    await drain();
    render(prepared);
    expect(status).toHaveBeenLastCalledWith({ file: source, state: "ready" });
    const ErrorClass =
      kind === "docx"
        ? (await import("../runtime/docx_types")).DocxError
        : (await import("../runtime/xlsx_types")).XlsxError;
    reject(new ErrorClass("readPending"));
    await drain();
    expect(status).toHaveBeenLastCalledWith({ file: source, state: "ready" });
  },
);

it.each(["docx", "workbook"] as const)(
  "%s only reports the current retry when two waiters share a still-pending capture",
  async (kind) => {
    const status = vi.fn();
    let reject!: (e: unknown) => void;
    const capture = kind === "docx" ? h.captureDocument : h.captureWorkbook;
    capture.mockImplementationOnce(() => new Promise((_, no) => (reject = no)));
    const node =
      kind === "docx" ? (
        <DocxFilePreview file={source} active onStatus={status} />
      ) : (
        <WorkbookFilePreview file={source} active onStatus={status} />
      );
    render(node);
    await drain();
    action(render(node), "取消预览");
    action(render(node), "重新预览");
    render(node);
    await drain();
    expect(capture).toHaveBeenCalledOnce();
    const ErrorClass =
      kind === "docx"
        ? (await import("../runtime/docx_types")).DocxError
        : (await import("../runtime/xlsx_types")).XlsxError;
    reject(new ErrorClass("readPending"));
    await drain();
    render(node);
    expect(status.mock.calls.filter(([s]) => s.state === "failed")).toEqual([
      [{ file: source, state: "failed", code: "readPending" }],
    ]);
  },
);
