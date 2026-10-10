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
vi.mock("./WorkbookFilePreview", () => ({
  WorkbookFilePreview: () => <div />,
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
import { WorkbookFilePreview } from "./WorkbookFilePreview";
import type { VerifiedFile } from "../runtime/file_delivery";
import type { WorkbookPreview } from "../runtime/xlsx_types";
import type { PreviewContentStatus } from "../runtime/preview_capture";
import { workbookWindow } from "../runtime/workbook_view";
import {
  createWorkbookFeedbackSource,
  workbookFeedbackTarget,
} from "../runtime/workbook_feedback_target";
import type {
  OfficeTargetAvailability,
  OfficeTargetConfirmation,
} from "../runtime/office_feedback_target";
import { composerDrafts, fileFeedbackDrafts } from "../runtime/drafts";
import { FILE_OPEN_STRINGS as S } from "../runtime/file_open_strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { WORKBOOK_STRINGS as B } from "../runtime/workbook_strings";
import { VISUAL_FEEDBACK_STRINGS as V } from "../runtime/visual_feedback_strings";
import { FileRevisionMonitor } from "../runtime/file_revision_monitor";

const file: VerifiedFile = {
  root: "/work",
  path: "/work/result.xlsx",
  resolvedPath: "/work/result.xlsx",
  name: "result.xlsx",
  size: 200,
  sha256: "a".repeat(64),
  version: "v1",
};
const id = (f = file) =>
  `disk:${JSON.stringify([f.resolvedPath, f.version, f.sha256])}`;
let props: OpenedFileViewProps;
type Element = ReactElement<Record<string, unknown>>;
type WorkbookProps = {
  file: VerifiedFile;
  active: boolean;
  onStatus: (s: PreviewContentStatus) => void;
  onOfficeTargetAvailability: (v: OfficeTargetAvailability) => void;
  onOfficeTargetConfirm: (v: OfficeTargetConfirmation) => void;
};
function elements(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      result.push(child, ...elements(child.props.children as ReactNode));
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
  return render().nodes.find((n) => n.type === WorkbookFilePreview)!
    .props as unknown as WorkbookProps;
}
const saved = (f = file, key = props.threadKey) =>
  fileFeedbackDrafts.read(key, f.resolvedPath, id(f));
function source(f = file, column = 1) {
  const preview: WorkbookPreview = {
    date1904: false,
    sheets: [{ id: "sheet-任意-ID", name: "重复内容", state: "visible" }],
    styles: [],
    warnings: [],
    sheet: {
      id: "sheet-任意-ID",
      cells: [],
      rows: [],
      columns: [{ min: 1, max: 4, hidden: false }],
      merges: [],
    },
  };
  const capture = { file: f, parts: [], entries: [], inflatedBytes: 0 };
  const window = workbookWindow(
    preview.sheet!,
    new Map(),
    { row: 1, column: 1 },
    false,
  );
  const result = createWorkbookFeedbackSource({
    capture,
    preview,
    window,
    position: window.positions[0][column - 1],
    showHidden: false,
    hiddenSheetSelected: false,
    expectedFile: f,
  });
  expect(result).not.toBeNull();
  return result!;
}
function announce(p: WorkbookProps, s = source(), available = true) {
  p.onOfficeTargetAvailability({ source: s, available });
  return s;
}
function confirm(
  p: WorkbookProps,
  s: ReturnType<typeof source>,
  anchor = workbookFeedbackTarget(s),
) {
  if (anchor) p.onOfficeTargetConfirm({ source: s, anchor });
  return anchor;
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
    expect(render().nodes.some((n) => n.type === WorkbookFilePreview)).toBe(
      true,
    ),
  );
  const p = child();
  p.onStatus({ file: p.file, state: "ready" });
  render();
  return child();
}
function seed(text = " 保留原意见\n") {
  fileFeedbackDrafts.update(props.threadKey, file.resolvedPath, {
    text,
    selection: null,
    scope: "file",
    contentId: id(),
  });
}
function form() {
  return render().nodes.find((n) => n.type === "form")!;
}
function submit(f = form()) {
  (f.props.onSubmit as (e: unknown) => void)({ preventDefault: vi.fn() });
}
function monitor() {
  return h.monitor.mock.calls.at(-1)![0] as {
    apply: (file: VerifiedFile, valid: () => boolean) => Promise<string>;
  };
}

beforeEach(() => {
  for (const key of ["workbook-feedback-parent", "other-workbook-feedback"]) {
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
    threadKey: "workbook-feedback-parent",
    path: "result.xlsx",
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

it.each([false, true])(
  "stages one automatic workbook refresh without cancelling its own monitor (hidden: %s)",
  async (hide) => {
    const old = await ready();
    const next = { ...file, version: "v2", sha256: "b".repeat(64) };
    let finish!: (value: unknown) => void;
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
      apply: (value, valid) =>
        monitor().apply(value, valid) as Promise<
          "applied" | "deferred" | "failed" | "cancelled"
        >,
      notice: vi.fn(),
    });
    h.monitor.mockImplementation((options) => {
      real.update({
        identity: options.identity,
        file: options.file,
        enabled: options.active,
        blocked: options.blocked,
      });
      return null;
    });
    try {
      render();
      real.focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.prepare).toHaveBeenCalledTimes(1);
      const staged = child();
      // Mirror the leaf's real visibility status, without mocking the monitor's
      // validity callback. Hiding a view is distinct from staging a replacement.
      if (!staged.active) staged.onStatus({ file, state: "paused" });
      render();
      const late = source();
      old.onOfficeTargetAvailability({ source: late, available: true });
      old.onOfficeTargetConfirm({
        source: late,
        anchor: workbookFeedbackTarget(late)!,
      });
      expect(saved().anchor).toBeUndefined();
      if (hide) render({ ...props, active: false });
      finish({ kind: "workbook", file: next });
      await vi.advanceTimersByTimeAsync(0);
      expect(child().file).toBe(hide ? file : next);
      expect(check).toHaveBeenCalledTimes(1);
      expect(h.prepare).toHaveBeenCalledTimes(1);
    } finally {
      real.dispose();
    }
  },
);

it("requires actual current workbook readiness before creating whole-file opinions", async () => {
  render();
  await vi.waitFor(() =>
    expect(render().nodes.some((n) => n.type === WorkbookFilePreview)).toBe(
      true,
    ),
  );
  expect(button(S.feedback)?.props.disabled).toBe(true);
  const p = child();
  p.onStatus({ file: p.file, state: "ready" });
  expect(button(S.feedback)?.props.disabled).toBe(false);
  click(S.feedback);
  edit("整文件意见");
  expect(saved()).toMatchObject({
    text: "整文件意见",
    contentId: id(),
    scope: "file",
  });
  expect(saved().anchor).toBeUndefined();
  const oldEditor = edit("保留整文件意见");
  p.onStatus({ file: p.file, state: "failed" });
  expect(button(S.feedback)?.props.disabled).toBe(true);
  (oldEditor.props.onChange as (e: unknown) => void)({
    target: { value: "迟到改写" },
  });
  expect(saved().text).toBe("保留整文件意见");
});
it("does not retarget on viewing a cell and only accepts the exact current confirmed position", async () => {
  const p = await ready();
  seed();
  const a = source();
  const first = workbookFeedbackTarget(a)!;
  confirm(p, a);
  expect(saved().anchor).toBeUndefined();
  announce(p, a);
  expect(saved().anchor).toBeUndefined();
  confirm(p, a);
  expect(saved()).toMatchObject({ text: " 保留原意见\n", anchor: first });
  expect(render().html).toContain(B.feedbackTarget(first));
  const b = announce(child(), source(file, 2));
  expect(saved().anchor).toEqual(first);
  p.onOfficeTargetAvailability({ source: a, available: false });
  p.onOfficeTargetConfirm({ source: a, anchor: first });
  expect(saved().anchor).toEqual(first);
  const second = confirm(child(), b)!;
  expect(saved().anchor).toEqual(second);
  expect(second.fromColumn).toBe(2);
  p.onOfficeTargetAvailability({ source: a, available: true });
  p.onOfficeTargetConfirm({ source: a, anchor: first });
  expect(saved().anchor).toEqual(second);
  click(V.wholeFile);
  expect(saved().text).toBe(" 保留原意见\n");
  expect(saved().anchor).toBeUndefined();
});
it("rejects mismatched coordinates and shape-valid but unregistered source objects", async () => {
  const p = await ready();
  const a = announce(p);
  const anchor = workbookFeedbackTarget(a)!;
  p.onOfficeTargetConfirm({
    source: a,
    anchor: { ...anchor, fromColumn: 2, toColumn: 2 },
  });
  expect(saved().anchor).toBeUndefined();
  const fake = { ...a };
  p.onOfficeTargetAvailability({ source: fake, available: true });
  p.onOfficeTargetConfirm({ source: fake, anchor });
  expect(saved().anchor).toBeUndefined();
  confirm(p, a);
  expect(saved().anchor).toEqual(anchor);
});
it.each(["hidden", "other conversation", "new selection"])(
  "rejects late callbacks after %s",
  async (cause) => {
    const p = await ready();
    seed();
    const a = announce(p);
    const anchor = workbookFeedbackTarget(a)!;
    if (cause === "hidden") render({ ...props, active: false });
    else if (cause === "other conversation")
      render({ ...props, threadKey: "other-workbook-feedback" });
    else render({ ...props, selectionKey: "b" });
    p.onOfficeTargetAvailability({ source: a, available: true });
    p.onOfficeTargetConfirm({ source: a, anchor });
    expect(saved(file, "workbook-feedback-parent").anchor).toBeUndefined();
    expect(saved(file, "other-workbook-feedback").anchor).toBeUndefined();
    expect(saved(file, "workbook-feedback-parent").text).toBe(" 保留原意见\n");
  },
);
it.each(["loading", "failed", "paused"] as const)(
  "withdraws eligibility synchronously on %s without losing retained opinion",
  async (state) => {
    const p = await ready();
    seed();
    const a = announce(p);
    const anchor = confirm(p, a)!;
    const next = announce(child(), source(file, 2));
    const other = workbookFeedbackTarget(next)!;
    p.onStatus({ file: p.file, state });
    p.onOfficeTargetConfirm({ source: next, anchor: other });
    expect(saved().anchor).toEqual(anchor);
    p.onStatus({ file: p.file, state: "ready" });
    p.onOfficeTargetAvailability({ source: next, available: true });
    p.onOfficeTargetConfirm({ source: next, anchor: other });
    expect(saved().anchor).toEqual(anchor);
  },
);
it("defers automatic replacement while a cell candidate exists and retires it before explicit reread", async () => {
  const p = await ready();
  const a = announce(p);
  const anchor = workbookFeedbackTarget(a)!;
  const next = { ...file, version: "v2", sha256: "b".repeat(64) };
  expect(await monitor().apply(next, () => true)).toBe("deferred");
  expect(h.prepare).not.toHaveBeenCalled();
  h.inspect.mockResolvedValue(next);
  click(S.refresh);
  p.onOfficeTargetAvailability({ source: a, available: true });
  p.onOfficeTargetConfirm({ source: a, anchor });
  expect(saved().anchor).toBeUndefined();
  await vi.waitFor(() => expect(child().file).toBe(next));
  p.onStatus({ file, state: "ready" });
  expect(button(S.feedback)?.props.disabled).toBe(true);
  child().onStatus({ file: next, state: "ready" });
  const b = announce(child(), source(next, 2));
  confirm(child(), b);
  expect(saved(next).anchor?.kind).toBe("xlsx-range");
  expect(saved().anchor).toBeUndefined();
});
it("keeps old-version opinions across replacement and joins exact coordinates once without sending", async () => {
  const p = await ready();
  seed();
  const a = announce(p);
  const anchor = confirm(p, a)!;
  const next = { ...file, version: "v2", sha256: "b".repeat(64) };
  h.inspect.mockResolvedValue(next);
  click(S.refresh);
  await vi.waitFor(() => expect(child().file).toBe(next));
  expect(saved()).toMatchObject({
    text: " 保留原意见\n",
    anchor,
    contentId: id(),
  });
  expect(saved(next).anchor).toBeUndefined();
  child().onStatus({ file: next, state: "ready" });
  const b = announce(child(), source(next, 2));
  const second = confirm(child(), b)!;
  edit("新版本意见\n");
  const oldForm = form();
  submit(oldForm);
  submit(oldForm);
  const joined = composerDrafts.read(`session:${props.threadKey}`).text;
  expect(joined.match(/新版本意见/g)).toHaveLength(1);
  expect(joined).toContain(next.sha256);
  expect(joined).toContain('"sheet-任意-ID"');
  expect(joined).toContain("B1");
  expect(second.fromColumn).toBe(2);
  expect(saved(next).text).toBe("");
  expect(saved().anchor).toEqual(anchor);
});
