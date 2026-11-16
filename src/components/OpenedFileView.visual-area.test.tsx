import { FileFeedbackEditor } from "./FileFeedbackEditor";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  cursor: 0,
  effects: [] as (() => void)[],
  inspect: vi.fn(),
  read: vi.fn(),
  block: vi.fn(),
  visual: vi.fn(),
  monitor: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../runtime/file_delivery", () => ({
  fileDelivery: {
    inspectLink: h.inspect,
    readText: h.read,
    readVisual: h.visual,
  },
}));
vi.mock("../runtime/text_block_preview", async (original) => ({
  ...(await original<typeof import("../runtime/text_block_preview")>()),
  readTextBlock: h.block,
}));
vi.mock("./useFileRevisionMonitor", () => ({
  useFileRevisionMonitor: h.monitor,
}));

vi.mock("./VisualFilePreview", () => ({ VisualFilePreview: () => <div /> }));
vi.mock("./FileCopyJobsStatus", () => ({ FileCopyJobsStatus: () => null }));
vi.mock("./SourceTextSelection", () => ({
  SourceTextSelection: ({ source }: { source: { text: string } }) => (
    <pre>{source.text}</pre>
  ),
}));
vi.mock("./TextBlockPreview", () => ({ TextBlockPreview: () => <div /> }));
vi.mock("react", async (original) => {
  const effect = (callback: () => void | (() => void), deps: unknown[]) => {
    const index = h.cursor++;
    const slot = h.slots[index];
    if (!slot || deps.some((v, i) => !Object.is(v, slot.deps?.[i])))
      h.effects.push(() => {
        slot?.cleanup?.();
        h.slots[index].cleanup = callback() || undefined;
      });
    h.slots[index] = { deps, cleanup: slot?.cleanup };
  };
  return {
    ...(await original<typeof import("react")>()),
    useState: (initial: unknown) => {
      const slot = (h.slots[h.cursor++] ??= {
        value:
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
      });
      return [
        slot.value,
        (next: unknown) => {
          slot.value =
            typeof next === "function"
              ? (next as (v: unknown) => unknown)(slot.value)
              : next;
        },
      ];
    },
    useRef: (initial: unknown) =>
      (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
    useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
    useEffect: effect,
    useLayoutEffect: effect,
  };
});

import { OpenedFileView, type OpenedFileViewProps } from "./OpenedFileView";
import {
  VisualFilePreview,
  type PdfPreviewCandidate,
} from "./VisualFilePreview";
import type { VerifiedFile, VisualPreview } from "../runtime/file_delivery";
import type { VisualPreviewReadiness } from "../runtime/visual_feedback";
import {
  registerVisualFeedbackFrame,
  createVisualAreaFeedbackSource,
  visualAreaFeedbackTarget,
  type VisualTargetAvailability,
  type VisualTargetConfirmation,
} from "../runtime/visual_feedback_target";
import type { FileTargetEditing } from "../runtime/file_target_editing";
import { fileFeedbackDrafts } from "../runtime/drafts";
import { FILE_OPEN_STRINGS as S } from "../runtime/file_open_strings";
import { VISUAL_FEEDBACK_STRINGS as F } from "../runtime/visual_feedback_strings";

const file: VerifiedFile = {
  root: "/work",
  path: "/work/result.pdf",
  resolvedPath: "/work/result.pdf",
  name: "result.pdf",
  size: 200,
  sha256: "a".repeat(64),
  version: "v1",
};
const id = (f = file) =>
  `disk:${JSON.stringify([f.resolvedPath, f.version, f.sha256])}`;
let props: OpenedFileViewProps;
type Element = ReactElement<Record<string, unknown>>;
type VisualProps = {
  preview: VisualPreview;
  active: boolean;
  interactionBlocked?: boolean;
  pdfCandidate?: PdfPreviewCandidate;
  onReadiness: (value: VisualPreviewReadiness) => void;
  onVisualTargetAvailability: (value: VisualTargetAvailability) => void;
  onVisualTargetConfirm: (value: VisualTargetConfirmation) => void;
  onTargetEditing: (value: FileTargetEditing) => void;
};
function elements(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (node) => {
    if (isValidElement<Record<string, unknown>>(node))
      result.push(
        node,
        ...elements(
          node.type === FileFeedbackEditor
            ? FileFeedbackEditor(
                node.props as unknown as Parameters<
                  typeof FileFeedbackEditor
                >[0],
              )
            : (node.props.children as ReactNode),
        ),
      );
  });
  return result;
}
function render(next = props) {
  props = next;
  h.cursor = 0;
  const tree = OpenedFileView(next);
  for (const effect of h.effects.splice(0)) effect();
  return { nodes: elements(tree), html: renderToStaticMarkup(tree) };
}
function button(label: string) {
  return render().nodes.find(
    (n) => n.type === "button" && n.props.children === label,
  );
}
function click(label: string) {
  const b = button(label);
  expect(b, label).toBeDefined();
  (b!.props.onClick as () => void)();
}
function child() {
  return render().nodes.find((n) => n.type === VisualFilePreview)!
    .props as unknown as VisualProps;
}
async function completePdfDraw(previous: VisualPreview) {
  const candidate = await vi.waitFor(() => {
    const staged = child();
    expect(staged.preview).toBe(previous);
    expect(staged.interactionBlocked).toBe(true);
    expect(staged.pdfCandidate).toBeDefined();
    return staged.pdfCandidate!;
  });
  candidate.settle({
    element: { width: 40, height: 30 } as HTMLCanvasElement,
    page: candidate.page,
    pageCount: 4,
  });
}
function preview(f = file): VisualPreview {
  return {
    file: f,
    mimeType: f.name.endsWith("pdf") ? "application/pdf" : "image/png",
    data: "AA==",
  };
}
function location(p: VisualProps): VisualPreviewReadiness {
  return {
    source: p.preview,
    location:
      p.preview.mimeType === "application/pdf"
        ? { kind: "pdf", page: 2, pageCount: 4 }
        : { kind: "image" },
  };
}
async function ready() {
  render();
  await vi.waitFor(() =>
    expect(render().nodes.some((n) => n.type === VisualFilePreview)).toBe(true),
  );
  const p = child();
  p.onReadiness(location(p));
  return child();
}
const saved = (f = file, key = props.threadKey) =>
  fileFeedbackDrafts.read(key, f.resolvedPath, id(f));
function seed(f = file) {
  fileFeedbackDrafts.update(props.threadKey, f.resolvedPath, {
    text: " 保留原意见\n",
    selection: null,
    scope: "file",
    contentId: id(f),
  });
}
function area(p: VisualPreview, isCurrent = () => true, left = 100000) {
  const common = {
    preview: p,
    expectedFile: p.file,
    drawOwner: {},
    pixelWidth: 400,
    pixelHeight: 200,
    isCurrent,
  };
  const frame = registerVisualFeedbackFrame(
    p.mimeType === "application/pdf"
      ? { ...common, kind: "pdf", page: 2, pageCount: 4 }
      : { ...common, kind: "image" },
  );
  expect(frame).not.toBeNull();
  const source = createVisualAreaFeedbackSource({
    frame: frame!,
    expectedFile: p.file,
    selection: { left, top: 200000, right: 800000, bottom: 900000 },
  });
  expect(source).not.toBeNull();
  const anchor = visualAreaFeedbackTarget(source!);
  expect(anchor).not.toBeNull();
  return { source: source!, anchor: anchor! } as VisualTargetConfirmation;
}
function announce(p: VisualProps, a = area(p.preview)) {
  p.onVisualTargetAvailability({ source: a.source, available: true });
  return a;
}
function monitor() {
  return h.monitor.mock.calls.at(-1)![0] as {
    apply: (file: VerifiedFile, valid: () => boolean) => Promise<string>;
  };
}
const next = () => ({ ...file, version: "v2", sha256: "b".repeat(64) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  for (const key of ["visual-area-parent", "other-visual-area"])
    for (const value of Object.values(fileFeedbackDrafts.entries(key)))
      fileFeedbackDrafts.clear(key, value.path);
  h.slots = [];
  h.effects = [];
  h.cursor = 0;
  for (const mock of [h.inspect, h.read, h.visual, h.block, h.monitor])
    mock.mockReset();
  h.inspect.mockResolvedValue(file);
  h.visual.mockImplementation(async (f: VerifiedFile) => preview(f));
  props = {
    threadKey: "visual-area-parent",
    path: file.path,
    workingDirectory: "/work",
    active: true,
    selectionKey: "a",
    onOpenHtml: vi.fn(),
  };
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
});

it.each(["pdf", "image"])(
  "only explicit current %s region confirmation changes the target and preserves text",
  async (kind) => {
    const f =
      kind === "pdf"
        ? file
        : {
            ...file,
            path: "/work/image.png",
            resolvedPath: "/work/image.png",
            name: "image.png",
          };
    h.inspect.mockResolvedValue(f);
    const p = await ready();
    seed(f);
    const a = area(p.preview);
    p.onVisualTargetConfirm(a);
    expect(saved(f).anchor).toBeUndefined();
    announce(p, a);
    expect(saved(f).anchor).toBeUndefined();
    p.onVisualTargetConfirm(a);
    expect(saved(f)).toMatchObject({ text: " 保留原意见\n", anchor: a.anchor });
    click(F.wholeFile);
    expect(saved(f).text).toBe(" 保留原意见\n");
    expect(saved(f).anchor).toBeUndefined();
  },
);
it("keeps the PDF page target path separate from a displayed region", async () => {
  const p = await ready();
  seed();
  const a = announce(p);
  p.onVisualTargetConfirm(a);
  click(F.currentPage(2));
  expect(saved().anchor).toEqual({ kind: "pdf-page", page: 2, pageCount: 4 });
  p.onReadiness({ source: p.preview, location: null });
  expect(button(F.currentPage(2))).toBeUndefined();
  expect(saved().anchor).toEqual({ kind: "pdf-page", page: 2, pageCount: 4 });
  expect(saved().text).toBe(" 保留原意见\n");
});
it("rejects a separately read preview even when all seven file fields match", async () => {
  const p = await ready();
  seed();
  const wrong = announce(
    p,
    area({ ...p.preview, file: { ...p.preview.file } }),
  );
  p.onVisualTargetConfirm(wrong);
  expect(saved().anchor).toBeUndefined();
  const actual = announce(p);
  p.onVisualTargetConfirm(actual);
  expect(saved().anchor).toEqual(actual.anchor);
});
it("requires current successful frame readiness as well as a valid factory source", async () => {
  const p = await ready();
  p.onReadiness({ source: p.preview, location: null });
  const a = announce(p);
  p.onVisualTargetConfirm(a);
  expect(saved().anchor).toBeUndefined();
});
it("holds automatic replacement for incomplete numeric editing without creating a target", async () => {
  const p = await ready();
  p.onTargetEditing({ owner: {}, file: p.preview.file, editing: true });
  expect(await monitor().apply(next(), () => true)).toBe("deferred");
  expect(h.visual).toHaveBeenCalledTimes(1);
  expect(saved().anchor).toBeUndefined();
});
it("wrong-file false and the old editor cannot release the current editor hold", async () => {
  const p = await ready(),
    old = {},
    current = {};
  p.onTargetEditing({ owner: old, file, editing: true });
  p.onTargetEditing({ owner: current, file, editing: true });
  p.onTargetEditing({ owner: old, file, editing: false });
  p.onTargetEditing({ owner: current, file: next(), editing: false });
  expect(await monitor().apply(next(), () => true)).toBe("deferred");
  p.onTargetEditing({ owner: current, file, editing: false });
  const operation = monitor().apply(next(), () => true);
  await completePdfDraw(p.preview);
  expect(await operation).toBe("applied");
});
it.each(["hide", "thread", "selection"])(
  "rejects late callbacks after %s",
  async (cause) => {
    const p = await ready();
    seed();
    const a = announce(p);
    if (cause === "hide") render({ ...props, active: false });
    else if (cause === "thread")
      render({ ...props, threadKey: "other-visual-area" });
    else render({ ...props, selectionKey: "b" });
    p.onVisualTargetAvailability({ source: a.source, available: true });
    p.onVisualTargetConfirm(a);
    expect(saved(file, "visual-area-parent").anchor).toBeUndefined();
    expect(saved(file, "visual-area-parent").text).toBe(" 保留原意见\n");
    expect(saved(file, "other-visual-area").anchor).toBeUndefined();
  },
);
it("candidate holds auto refresh, while explicit reread retires old callbacks", async () => {
  const p = await ready();
  seed();
  const a = announce(p);
  expect(await monitor().apply(next(), () => true)).toBe("deferred");
  h.inspect.mockResolvedValue(next());
  click(S.refresh);
  p.onVisualTargetConfirm(a);
  expect(saved().anchor).toBeUndefined();
  await completePdfDraw(p.preview);
  await vi.waitFor(() => expect(child().preview.file.version).toBe("v2"));
  p.onReadiness(location(p));
  p.onVisualTargetAvailability({ source: a.source, available: true });
  p.onVisualTargetConfirm(a);
  expect(saved().anchor).toBeUndefined();
});
it("staging retains the actual old pixel preview and blocks controls until a new read succeeds", async () => {
  const p = await ready();
  const read = deferred<VisualPreview>();
  h.visual.mockReturnValue(read.promise);
  const operation = monitor().apply(next(), () => true);
  const staged = child();
  expect(staged.preview).toBe(p.preview);
  expect(staged.active).toBe(true);
  expect(staged.interactionBlocked).toBe(true);
  const a = announce(p);
  p.onVisualTargetConfirm(a);
  expect(saved().anchor).toBeUndefined();
  read.resolve(preview(next()));
  await completePdfDraw(p.preview);
  expect(await operation).toBe("applied");
  expect(child().preview).not.toBe(p.preview);
  expect(child().interactionBlocked).toBe(false);
});
it.each(["hide", "pending"])(
  "rechecks parent ownership when the renderer's current callback synchronously causes %s",
  async (cause) => {
    const p = await ready();
    seed();
    let effect: (() => void) | null = null;
    const a = area(p.preview, () => {
      const run = effect;
      effect = null;
      run?.();
      return true;
    });
    announce(p, a);
    const read = deferred<VisualPreview>();
    h.visual.mockReturnValue(read.promise);
    let operation: Promise<string> | undefined;
    effect = () => {
      if (cause === "hide") render({ ...props, active: false });
      else {
        click(S.refresh);
        render();
      }
    };
    p.onVisualTargetConfirm(a);
    expect(saved().anchor).toBeUndefined();
    expect(saved().text).toBe(" 保留原意见\n");
    read.resolve(preview(file));
    await operation;
  },
);
