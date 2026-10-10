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
import type { VerifiedFile } from "../runtime/file_delivery";
import type { DocxParagraph, DocxPreview } from "../runtime/docx_types";
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
      found.push(child, ...elements(child.props.children as ReactNode));
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
  click(S.refresh);
  p.onOfficeTargetConfirm({
    ...a,
    anchor: { ...a.anchor, elementPath: [0, 3] },
  });
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
