import { FileFeedbackDrafts } from "./FileFeedbackDrafts";
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
  prepare: vi.fn(),
  monitor: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../runtime/file_delivery", () => ({
  fileDelivery: { inspectLink: h.inspect, readText: h.read },
}));
vi.mock("../runtime/text_block_preview", async (original) => ({
  ...(await original<typeof import("../runtime/text_block_preview")>()),
  readTextBlock: h.block,
}));
vi.mock("./useFileRevisionMonitor", () => ({
  useFileRevisionMonitor: h.monitor,
}));
vi.mock("../runtime/office_preview_prepare", () => ({
  prepareOfficePreview: h.prepare,
}));
vi.mock("./DocxFilePreview", () => ({
  DocxFilePreview: () => <div />,
}));
vi.mock("./PptxFilePreview", () => ({ PptxFilePreview: () => <div /> }));
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
import { DocxFilePreview } from "./DocxFilePreview";
import { PptxFilePreview } from "./PptxFilePreview";
import { pptxDisplayFixture } from "../runtime/pptx_display_fixture";
import {
  createPptxFeedbackSource,
  pptxFeedbackTarget,
} from "../runtime/pptx_feedback_target";
import type { VerifiedFile } from "../runtime/file_delivery";
import type { DocxParagraph, DocxPreview } from "../runtime/docx_types";
import { DocxError } from "../runtime/docx_types";
import { DOCUMENT_STRINGS as D } from "../runtime/document_strings";
import type { PreviewContentStatus } from "../runtime/preview_capture";
import {
  createDocumentFeedbackSource,
  documentFeedbackTarget,
} from "../runtime/docx_feedback_target";
import type {
  OfficeTargetAvailability,
  OfficeTargetConfirmation,
} from "../runtime/office_feedback_target";
import { composerDrafts, fileFeedbackDrafts } from "../runtime/drafts";
import { FILE_OPEN_STRINGS as S } from "../runtime/file_open_strings";
import { VISUAL_FEEDBACK_STRINGS as V } from "../runtime/visual_feedback_strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { FileRevisionMonitor } from "../runtime/file_revision_monitor";

const file: VerifiedFile = {
  root: "/work",
  path: "/work/result.docx",
  resolvedPath: "/work/result.docx",
  name: "result.docx",
  size: 1024,
  sha256: "a".repeat(64),
  version: "v1",
};
const id = (f = file) =>
  `disk:${JSON.stringify([f.resolvedPath, f.version, f.sha256])}`;
let props: OpenedFileViewProps;
type Element = ReactElement<Record<string, unknown>>;
type DocumentProps = {
  file: VerifiedFile;
  active: boolean;
  interactionBlocked: boolean;
  onStatus: (s: PreviewContentStatus) => void;
  onOfficeTargetAvailability: (v: OfficeTargetAvailability) => void;
  onOfficeTargetConfirm: (v: OfficeTargetConfirmation) => void;
};
function elements(tree: ReactNode): Element[] {
  const found: Element[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      found.push(
        child,
        ...elements(
          child.type === FileFeedbackEditor
            ? FileFeedbackEditor(
                child.props as unknown as Parameters<
                  typeof FileFeedbackEditor
                >[0],
              )
            : (child.props.children as ReactNode),
        ),
      );
  });
  return found;
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
  return render().nodes.find((n) => n.type === DocxFilePreview)!
    .props as unknown as DocumentProps;
}
const saved = (f = file, key = props.threadKey) =>
  fileFeedbackDrafts.read(key, f.resolvedPath, id(f));
function target(f = file, path = [0, 1], part = "word/document.xml") {
  // Parent ownership tests use explicit synthetic source coordinates; the
  // independent ZIP/Worker oracle verifies that the parser emits real paths.
  const block: DocxParagraph = {
    kind: "paragraph",
    id: "same-display-id",
    source: { part, elementPath: path },
    style: {},
    runs: [{ kind: "text", text: "相同正文", style: {} }],
  };
  const preview: DocxPreview = {
    file: f,
    blocks: [block],
    stories: [],
    images: [],
    warnings: [],
    partial: false,
  };
  const source = createDocumentFeedbackSource({
    preview,
    block,
    expectedFile: f,
  });
  expect(source).not.toBeNull();
  return { source: source!, anchor: documentFeedbackTarget(source!)! };
}
function announce(p = child(), t = target()) {
  p.onOfficeTargetAvailability({ source: t.source, available: true });
  return t;
}
function edit(text: string) {
  const input = render().nodes.find(
    (n) => n.type === "textarea" && n.props["aria-label"] === W.feedbackLabel,
  )!;
  expect(input).toBeDefined();
  (input.props.onChange as (e: unknown) => void)({ target: { value: text } });
  return input;
}
async function ready() {
  render();
  await vi.waitFor(() =>
    expect(render().nodes.some((n) => n.type === DocxFilePreview)).toBe(true),
  );
  const p = child();
  p.onStatus({ file: p.file, state: "ready" });
  render();
  return child();
}
function seed() {
  fileFeedbackDrafts.update(props.threadKey, file.resolvedPath, {
    text: " 保留原意见\n",
    selection: null,
    scope: "file",
    contentId: id(),
  });
}
function monitor() {
  return h.monitor.mock.calls.at(-1)![0] as {
    apply: (file: VerifiedFile, valid: () => boolean) => Promise<string>;
  };
}
beforeEach(() => {
  for (const key of ["docx-feedback-parent", "other-docx-feedback"]) {
    for (const v of Object.values(fileFeedbackDrafts.entries(key)))
      fileFeedbackDrafts.clear(key, v.path);
    composerDrafts.clear(`session:${key}`);
  }
  h.slots = [];
  h.effects = [];
  h.cursor = 0;
  for (const m of [h.inspect, h.read, h.block, h.monitor, h.prepare])
    m.mockReset();
  h.inspect.mockResolvedValue(file);
  props = {
    threadKey: "docx-feedback-parent",
    path: "result.docx",
    workingDirectory: "/work",
    active: true,
    selectionKey: "a",
    onOpenHtml: vi.fn(),
  };
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  vi.useRealTimers();
});

it("gates DOCX opinions on current completed preview and revokes a stale editor", async () => {
  render();
  await vi.waitFor(() =>
    expect(render().nodes.some((n) => n.type === DocxFilePreview)).toBe(true),
  );
  expect(button(S.feedback)).toBeDefined();
  expect(button(S.feedback)?.props.disabled).toBe(true);
  const p = child();
  p.onStatus({ file: p.file, state: "ready" });
  expect(button(S.feedback)?.props.disabled).toBe(false);
  click(S.feedback);
  const input = edit("保留整文件意见");
  p.onStatus({ file: p.file, state: "failed" });
  (input.props.onChange as (e: unknown) => void)({
    target: { value: "迟到替换" },
  });
  expect(saved().text).toBe("保留整文件意见");
  expect(button(S.feedback)?.props.disabled).toBe(true);
});
it("blocks top-level DOCX reread until the first capture receipt returns", async () => {
  render();
  await vi.waitFor(() =>
    expect(render().nodes.some((n) => n.type === DocxFilePreview)).toBe(true),
  );
  const p = child();
  const staleClick = button(S.refresh)!.props.onClick as () => void;
  p.onStatus({ file, state: "loading", readInFlight: true });
  expect(button(S.refresh)?.props.disabled).toBe(true);
  staleClick();
  p.onStatus({ file, state: "paused", readInFlight: true });
  expect(button(S.refresh)?.props.disabled).toBe(true);
  staleClick();
  expect(h.inspect).toHaveBeenCalledOnce();

  p.onStatus({ file, state: "failed", readInFlight: false, code: "invalid" });
  expect(button(S.refresh)?.props.disabled).toBe(false);
  const next = { ...file, version: "v2", sha256: "b".repeat(64) };
  h.inspect.mockResolvedValueOnce(next);
  click(S.refresh);
  await vi.waitFor(() => expect(child().file).toBe(next));
  expect(h.inspect).toHaveBeenCalledTimes(2);
  expect(h.prepare).not.toHaveBeenCalled();
});
it("only explicit current confirmation changes a same-text block target, retaining opinion text", async () => {
  const p = await ready();
  seed();
  const a = target();
  p.onOfficeTargetConfirm(a);
  expect(saved().anchor).toBeUndefined();
  announce(p, a);
  expect(saved().anchor).toBeUndefined();
  p.onOfficeTargetConfirm(a);
  expect(saved()).toMatchObject({ text: " 保留原意见\n", anchor: a.anchor });
  const b = announce(child(), target(file, [0, 2]));
  expect(saved().anchor).toEqual(a.anchor);
  p.onOfficeTargetConfirm({
    ...b,
    anchor: { ...b.anchor, elementPath: [0, 3] },
  });
  expect(saved().anchor).toEqual(a.anchor);
  child().onOfficeTargetConfirm(b);
  expect(saved().anchor).toEqual(b.anchor);
  p.onOfficeTargetAvailability({ source: a.source, available: true });
  p.onOfficeTargetConfirm(a);
  expect(saved().anchor).toEqual(b.anchor);
  click(V.wholeFile);
  expect(saved().anchor).toBeUndefined();
  expect(saved().text).toBe(" 保留原意见\n");
});
it.each(["hidden", "other conversation", "new selection"])(
  "rejects old DOCX callbacks after %s",
  async (cause) => {
    const p = await ready();
    seed();
    const t = announce(p);
    if (cause === "hidden") render({ ...props, active: false });
    else if (cause === "other conversation")
      render({ ...props, threadKey: "other-docx-feedback" });
    else render({ ...props, selectionKey: "b" });
    p.onOfficeTargetAvailability({ source: t.source, available: true });
    p.onOfficeTargetConfirm(t);
    expect(saved(file, "docx-feedback-parent").anchor).toBeUndefined();
    expect(saved(file, "other-docx-feedback").anchor).toBeUndefined();
    expect(saved(file, "docx-feedback-parent").text).toBe(" 保留原意见\n");
  },
);
it.each(["loading", "failed", "paused"] as const)(
  "permanently retires candidate on DOCX %s",
  async (state) => {
    const p = await ready();
    const a = announce(p);
    p.onOfficeTargetConfirm(a);
    edit("原坐标意见");
    const b = announce(child(), target(file, [0, 2]));
    p.onStatus({ file, state });
    p.onOfficeTargetConfirm(b);
    p.onStatus({ file, state: "ready" });
    p.onOfficeTargetAvailability({ source: b.source, available: true });
    p.onOfficeTargetConfirm(b);
    expect(saved()).toMatchObject({ text: "原坐标意见", anchor: a.anchor });
  },
);
it("preserves old DOCX coordinates across replacement and joins new content once", async () => {
  const p = await ready();
  seed();
  const a = announce(p);
  p.onOfficeTargetConfirm(a);
  const next = { ...file, version: "v2", sha256: "b".repeat(64) };
  expect(await monitor().apply(next, () => true)).toBe("deferred");
  h.inspect.mockResolvedValue(next);
  let complete!: (preview: unknown) => void;
  h.prepare.mockReturnValueOnce(new Promise((resolve) => (complete = resolve)));
  click(S.refresh);
  expect(
    render().nodes.find((n) => n.type === DocxFilePreview)?.props.file,
  ).toBe(file);
  await vi.waitFor(() => expect(h.prepare).toHaveBeenCalledOnce());
  expect(child().interactionBlocked).toBe(true);
  p.onOfficeTargetConfirm({
    ...a,
    anchor: { ...a.anchor, elementPath: [0, 3] },
  });
  complete({ kind: "docx", file: next, value: { file: next } });
  await vi.waitFor(() => expect(child().file).toBe(next));
  expect(saved()).toMatchObject({ anchor: a.anchor, text: " 保留原意见\n" });
  p.onStatus({ file, state: "ready" });
  expect(button(S.feedback)?.props.disabled).toBe(true);
  child().onStatus({ file: next, state: "ready" });
  const b = announce(child(), target(next, [2, 0], "word/footnotes.xml"));
  child().onOfficeTargetConfirm(b);
  edit("新版脚注意见");
  const form = render().nodes.find((n) => n.type === "form")!;
  const submit = () =>
    (form.props.onSubmit as (e: unknown) => void)({ preventDefault: vi.fn() });
  submit();
  submit();
  const joined = composerDrafts.read(`session:${props.threadKey}`).text;
  expect(joined.match(/新版脚注意见/g)).toHaveLength(1);
  expect(joined).toContain(next.sha256);
  expect(joined).toContain("word/footnotes.xml");
  expect(joined).toContain("[2,0]");
  expect(saved(next).text).toBe("");
  expect(saved().anchor).toEqual(a.anchor);
});

it("keeps the ready DOCX and its opinion when the manually reread file is invalid", async () => {
  const position = {
    kind: "document" as const,
    root: file.root,
    resolvedPath: file.resolvedPath,
    story: null,
    segment: 2,
  };
  const readingPosition = { current: position };
  props.readingPosition = readingPosition;
  const old = await ready();
  seed();
  const retained = announce(old);
  old.onOfficeTargetConfirm(retained);
  const next = { ...file, version: "v2", sha256: "b".repeat(64) };
  h.inspect.mockResolvedValue(next);
  h.prepare.mockRejectedValueOnce(new DocxError("invalid"));
  click(S.refresh);
  expect(
    render().nodes.find((n) => n.type === DocxFilePreview)?.props.file,
  ).toBe(file);
  await vi.waitFor(() => expect(render().html).toContain(D.invalid));
  expect(render().html).toContain(S.revisionNotices.refreshFailed);
  expect(child().file).toBe(file);
  expect(child().interactionBlocked).toBe(false);
  expect(readingPosition.current).toBe(position);
  expect(h.prepare).toHaveBeenCalledExactlyOnceWith(
    next,
    readingPosition,
    expect.any(AbortSignal),
    expect.any(Function),
    undefined,
  );
  expect(saved()).toMatchObject({
    text: " 保留原意见\n",
    anchor: retained.anchor,
  });
  expect(saved(next).anchor).toBeUndefined();
});

it("waits for the original DOCX read receipt through hide and resumes only on explicit reread", async () => {
  await ready();
  const next = { ...file, version: "v2", sha256: "b".repeat(64) };
  h.inspect.mockResolvedValue(next);
  let fail!: (reason: DocxError) => void;
  h.prepare.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
  click(S.refresh);
  await vi.waitFor(() => expect(h.prepare).toHaveBeenCalledOnce());
  const signal = h.prepare.mock.calls[0][2] as AbortSignal;
  render({ ...props, active: false });
  expect(signal.aborted).toBe(true);
  render({ ...props, active: true });
  expect(child().file).toBe(file);
  expect(button(S.refresh)?.props.disabled).toBe(true);
  fail(new DocxError("readPending"));
  await vi.waitFor(() => expect(render().html).toContain(D.readPending));
  expect(child().file).toBe(file);
  expect(h.monitor.mock.calls.at(-1)?.[0].blocked).toBe(true);
  expect(h.prepare).toHaveBeenCalledOnce();
  h.prepare.mockResolvedValueOnce({
    kind: "docx",
    file: next,
    value: { file: next },
  });
  expect(button(S.refresh)?.props.disabled).toBe(false);
  click(S.refresh);
  await vi.waitFor(() => expect(child().file).toBe(next));
  expect(h.prepare).toHaveBeenCalledTimes(2);
});

it("keeps the old DOCX if a manual reread resolves the path to another file", async () => {
  await ready();
  h.inspect.mockResolvedValue({
    ...file,
    resolvedPath: "/work/redirected.docx",
    version: "v2",
  });
  click(S.refresh);
  await vi.waitFor(() =>
    expect(render().html).toContain(S.revisionNotices.redirected),
  );
  expect(child().file).toBe(file);
  expect(h.prepare).not.toHaveBeenCalled();
});
it.each([false, true])(
  "does not cancel DOCX refresh itself while interaction is blocked (hide=%s)",
  async (hide) => {
    const old = await ready();
    const next = { ...file, version: "v2", sha256: "b".repeat(64) };
    let finish!: (v: unknown) => void;
    h.prepare.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    vi.useFakeTimers();
    const check = vi.fn(async () => ({
      kind: "verified" as const,
      file: next,
    }));
    const real = new FileRevisionMonitor({
      check,
      apply: (f, valid) =>
        monitor().apply(f, valid) as Promise<
          "applied" | "deferred" | "failed" | "cancelled"
        >,
      notice: vi.fn(),
    });
    h.monitor.mockImplementation((o) => {
      real.update({
        identity: o.identity,
        file: o.file,
        enabled: o.active,
        blocked: o.blocked,
      });
      return null;
    });
    try {
      render();
      real.focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.prepare).toHaveBeenCalledTimes(1);
      const staged = child();
      expect(staged.active).toBe(true);
      expect(staged.interactionBlocked).toBe(true);
      const t = target();
      old.onOfficeTargetAvailability({ source: t.source, available: true });
      old.onOfficeTargetConfirm(t);
      expect(saved().anchor).toBeUndefined();
      if (hide) render({ ...props, active: false });
      finish({ kind: "docx", file: next });
      await vi.advanceTimersByTimeAsync(0);
      expect(child().file).toBe(hide ? file : next);
      expect(check).toHaveBeenCalledTimes(1);
      expect(h.prepare).toHaveBeenCalledTimes(1);
    } finally {
      real.dispose();
    }
  },
);

// The same parent Office guards must apply when the preview format is PPTX.
const pptxFile = {
  ...file,
  path: "/work/slides.pptx",
  resolvedPath: "/work/slides.pptx",
  name: "slides.pptx",
};
const pptxChild = () =>
  render().nodes.find((n) => n.type === PptxFilePreview)!
    .props as unknown as DocumentProps;
const pptxTarget = (f = pptxFile) => {
  const preview = { ...pptxDisplayFixture(), file: f };
  const source = createPptxFeedbackSource({
    preview,
    slide: preview.slides[1],
    expectedFile: f,
  })!;
  return { source, anchor: pptxFeedbackTarget(source)! };
};
async function readyPptx() {
  h.inspect.mockResolvedValue(pptxFile);
  render({ ...props, path: "slides.pptx" });
  await vi.waitFor(() =>
    expect(render().nodes.some((n) => n.type === PptxFilePreview)).toBe(true),
  );
  expect(button(S.feedback)?.props.disabled).toBe(true);
  const p = pptxChild();
  p.onStatus({ file: p.file, state: "ready", readInFlight: false });
  render();
  expect(button(S.feedback)?.props.disabled).toBe(false);
  return pptxChild();
}
it("uses the shared editor for an explicitly confirmed PPTX slide and permanently revokes nonready targets", async () => {
  const p = await readyPptx(),
    target = pptxTarget();
  p.onOfficeTargetConfirm(target);
  expect(saved(pptxFile).anchor).toBeUndefined();
  p.onOfficeTargetAvailability({ source: target.source, available: true });
  p.onOfficeTargetConfirm(target);
  edit("  keep slide opinion\n");
  expect(saved(pptxFile)).toMatchObject({
    text: "  keep slide opinion\n",
    anchor: target.anchor,
  });
  const oldEditor = render().nodes.find((n) => n.type === "textarea")!;
  p.onStatus({ file: p.file, state: "failed" });
  (oldEditor.props.onChange as (e: unknown) => void)({
    target: { value: "late" },
  });
  expect(pptxFeedbackTarget(target.source)).toBeNull();
  p.onStatus({ file: p.file, state: "ready" });
  p.onOfficeTargetAvailability({ source: target.source, available: true });
  p.onOfficeTargetConfirm(target);
  expect(saved(pptxFile).text).toBe("  keep slide opinion\n");
});
it.each(["hide", "conversation", "selection"])(
  "rejects a retained PPTX confirmation after %s without changing prior opinion",
  async (change) => {
    const p = await readyPptx(),
      target = pptxTarget();
    p.onOfficeTargetAvailability({ source: target.source, available: true });
    if (change === "hide") render({ ...props, active: false });
    if (change === "conversation")
      render({ ...props, threadKey: "other-docx-feedback" });
    if (change === "selection") render({ ...props, selectionKey: "another" });
    p.onOfficeTargetConfirm(target);
    expect(saved(pptxFile, "docx-feedback-parent").anchor).toBeUndefined();
    expect(saved(pptxFile, "other-docx-feedback").anchor).toBeUndefined();
  },
);
it("retains a prior-version PPTX opinion on refresh and adds it once without sending", async () => {
  const p = await readyPptx(),
    target = pptxTarget();
  p.onOfficeTargetAvailability({ source: target.source, available: true });
  p.onOfficeTargetConfirm(target);
  edit("  original slide text\n");
  const next = { ...pptxFile, version: "two", sha256: "b".repeat(64) };
  h.inspect.mockResolvedValue(next);
  h.prepare.mockResolvedValue({
    kind: "pptx",
    file: next,
    value: { ...pptxDisplayFixture(), file: next },
  });
  click(S.refresh);
  await vi.waitFor(() => expect(pptxChild().file).toEqual(next));
  expect(saved(pptxFile)).toMatchObject({
    text: "  original slide text\n",
    anchor: target.anchor,
  });
  expect(saved(next).anchor).toBeUndefined();
  p.onOfficeTargetConfirm(target);
  expect(saved(next).anchor).toBeUndefined();
  expect(render().html).toContain("其他内容版本的意见");
  const key = Object.keys(fileFeedbackDrafts.entries(props.threadKey)).find(
    (key) =>
      fileFeedbackDrafts.entries(props.threadKey)[key].contentId ===
      id(pptxFile),
  )!;
  const { fileFeedbackText } = await import("../runtime/feedback_strings");
  const before = composerDrafts.read(`session:${props.threadKey}`);
  expect(
    fileFeedbackDrafts.take(
      props.threadKey,
      key,
      fileFeedbackText({ ...saved(pptxFile), path: pptxFile.resolvedPath }),
    ),
  ).toBe(true);
  expect(fileFeedbackDrafts.take(props.threadKey, key, "duplicate")).toBe(
    false,
  );
  expect(composerDrafts.read(`session:${props.threadKey}`)).toEqual({
    ...before,
    text: expect.stringContaining("  original slide text\n"),
  });
  expect(composerDrafts.read(`session:${props.threadKey}`).text).toContain(
    `文件内定位依据 ${JSON.stringify(target.anchor.part)}`,
  );
  expect(composerDrafts.read(`session:${props.threadKey}`).text).toContain(
    pptxFile.sha256,
  );
});

it("the common disk-file form and historical list use the visible new draft, and stale destination cannot consume an opinion", async () => {
  await ready();
  composerDrafts.clear("new");
  let current = true;
  const feedbackDestination = {
    threadKey: props.threadKey,
    draftKey: "new",
    isCurrent: () => current,
  };
  props = { ...props, feedbackDestination };
  click(S.feedback);
  edit("EXACT VISIBLE DISK OPINION");
  const tree = render().nodes;
  const form = tree.find((node) => node.type === "form")!;
  const historical = tree.find((node) => node.type === FileFeedbackDrafts)!;
  expect(historical.props.feedbackDestination).toBe(feedbackDestination);
  current = false;
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  expect(saved().text).toBe("EXACT VISIBLE DISK OPINION");
  expect(composerDrafts.read("new").text).toBe("");
  current = true;
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  expect(composerDrafts.read("new").text).toContain(
    "EXACT VISIBLE DISK OPINION",
  );
  expect(composerDrafts.read(`session:${props.threadKey}`).text).not.toContain(
    "EXACT VISIBLE DISK OPINION",
  );
  expect(saved().text).toBe("");
});
