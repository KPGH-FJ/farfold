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
  inspectLink: vi.fn(),
  checkRevision: vi.fn(),
  prepareOffice: vi.fn(),
  readText: vi.fn(),
  readVisual: vi.fn(),
  readBlock: vi.fn(),
  open: vi.fn(),
  reveal: vi.fn(),
  openLocation: vi.fn(),
  revealLocation: vi.fn(),
  copy: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../runtime/file_copy_jobs", () => ({
  fileCopyJobs: { begin: h.copy },
}));
vi.mock("./FileCopyJobsStatus", () => ({
  FileCopyJobsStatus: () => <div data-copy-jobs />,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: h.save }));
vi.mock("../runtime/office_preview_prepare", () => ({
  prepareOfficePreview: h.prepareOffice,
}));
vi.mock("../runtime/file_delivery", () => ({
  fileDelivery: {
    inspectLink: h.inspectLink,
    checkRevision: h.checkRevision,
    readText: h.readText,
    readVisual: h.readVisual,
    open: h.open,
    reveal: h.reveal,
    openSelectedLocation: h.openLocation,
    revealSelectedLocation: h.revealLocation,
    copy: h.copy,
  },
}));
vi.mock("../runtime/text_block_preview", async (original) => ({
  ...(await original<typeof import("../runtime/text_block_preview")>()),
  readTextBlock: h.readBlock,
}));
vi.mock("./TextBlockPreview", () => ({
  TextBlockPreview: ({
    initial,
  }: {
    initial: { text: string; file: { version: string } };
  }) => (
    <div data-text-block-version={initial.file.version}>{initial.text}</div>
  ),
}));
vi.mock("./VisualFilePreview", () => ({
  VisualFilePreview: ({
    preview,
  }: {
    preview: { file: { version: string } };
  }) => <div data-visual-version={preview.file.version} />,
}));
vi.mock("./WorkbookFilePreview", () => ({
  WorkbookFilePreview: ({
    file,
    active,
  }: {
    file: { version: string };
    active: boolean;
  }) => <div data-workbook-version={file.version} data-active={active} />,
}));
vi.mock("./DocxFilePreview", () => ({
  DocxFilePreview: ({
    file,
    active,
  }: {
    file: { version: string };
    active: boolean;
  }) => (
    <div data-document-version={file.version} data-document-active={active} />
  ),
}));
vi.mock("react", async (original) => {
  const effect = (callback: () => void | (() => void), deps: unknown[]) => {
    const index = h.cursor++;
    const slot = h.slots[index];
    if (!slot || deps.some((value, i) => !Object.is(value, slot.deps?.[i])))
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
import { TEXT_BLOCK_STRINGS as T } from "../runtime/text_block_strings";
import { FILE_OPEN_STRINGS as S } from "../runtime/file_open_strings";
import { FILE_DELIVERY_STRINGS as D } from "../runtime/file_delivery_strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { composerDrafts, fileFeedbackDrafts } from "../runtime/drafts";
import { FileFeedbackDrafts } from "./FileFeedbackDrafts";

const receipt = {
  root: "/work",
  path: "/work/result.md",
  resolvedPath: "/work/result.md",
  name: "result.md",
  size: 10,
  sha256: "sha-a",
  version: "v1",
};
let props: OpenedFileViewProps;
type Element = ReactElement<Record<string, unknown>>;
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
    (node) => node.type === "button" && node.props.children === label,
  );
}
function click(label: string) {
  const found = button(label);
  expect(found, label).toBeDefined();
  (found!.props.onClick as () => void)();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function ready() {
  render();
  await vi.waitFor(() => expect(button(S.open)).toBeDefined());
}
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  for (const key of ["opened-file-test", "other-file-test"]) {
    for (const entry of Object.values(fileFeedbackDrafts.entries(key)))
      fileFeedbackDrafts.clear(key, entry.path);
    composerDrafts.clear(`session:${key}`);
  }
  h.slots.length = 0;
  h.effects.length = 0;
  h.cursor = 0;
  for (const mock of [
    h.inspectLink,
    h.checkRevision,
    h.prepareOffice,
    h.readText,
    h.readVisual,
    h.readBlock,
    h.open,
    h.reveal,
    h.openLocation,
    h.revealLocation,
    h.copy,
    h.save,
  ])
    mock.mockReset();
  h.inspectLink.mockResolvedValue(receipt);
  h.checkRevision.mockResolvedValue({ kind: "hintUnchanged" });
  h.readText.mockResolvedValue({ file: receipt, text: "# Real disk content" });
  props = {
    threadKey: "opened-file-test",
    path: "result.md",
    workingDirectory: "/work",
    active: true,
    selectionKey: "task-a:1",
    onOpenHtml: vi.fn(),
  };
});

afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  vi.useRealTimers();
});

it("automatically displays a newly verified file without a second pathname inspection", async () => {
  vi.useFakeTimers();
  await ready();
  const next = { ...receipt, version: "auto-new", sha256: "new-hash" };
  h.checkRevision.mockResolvedValueOnce({ kind: "verified", file: next });
  h.readText.mockResolvedValueOnce({
    file: next,
    text: "# Automatically updated",
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(render().html).toContain("Automatically updated");
  expect(render().html).not.toContain("Real disk content");
  expect(h.readText).toHaveBeenLastCalledWith(next);
  expect(h.inspectLink).toHaveBeenCalledOnce();
});

it("retains old contents with an explicit warning after automatic reread failure", async () => {
  vi.useFakeTimers();
  await ready();
  h.checkRevision.mockResolvedValueOnce({
    kind: "verified",
    file: { ...receipt, version: "auto-new" },
  });
  h.readText.mockRejectedValueOnce(new Error("private-file-error"));
  await vi.advanceTimersByTimeAsync(5000);
  const result = render().html;
  expect(result).toContain("Real disk content");
  expect(result).toContain(S.revisionNotices.refreshFailed);
  expect(result).not.toContain("private-file-error");
  await vi.advanceTimersByTimeAsync(120000);
  expect(h.checkRevision).toHaveBeenCalledOnce();
});

it("does not replace the content under an open version-specific opinion", async () => {
  vi.useFakeTimers();
  await ready();
  click(S.feedback);
  render();
  h.checkRevision.mockResolvedValueOnce({
    kind: "verified",
    file: { ...receipt, version: "auto-new" },
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(render().html).toContain("Real disk content");
  expect(render().html).toContain(S.revisionNotices.newVersion);
  expect(h.readText).toHaveBeenCalledOnce();
});

it("checks for a changed file when the content panel becomes active again", async () => {
  vi.useFakeTimers();
  await ready();
  render({ ...props, active: false });
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.checkRevision).not.toHaveBeenCalled();
  render({ ...props, active: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.checkRevision).toHaveBeenCalledWith(receipt, "content");
});

it("leaves selected HTML loading under explicit user control", async () => {
  vi.useFakeTimers();
  h.inspectLink.mockResolvedValue({ ...receipt, name: "page.html" });
  await ready();
  render({ ...props, active: false });
  render({ ...props, active: true });
  await vi.advanceTimersByTimeAsync(120000);
  expect(h.checkRevision).not.toHaveBeenCalled();
  expect(props.onOpenHtml).toHaveBeenCalledOnce();
});

it("keeps a deletion warning and does not automatically retry when the panel reopens", async () => {
  vi.useFakeTimers();
  await ready();
  h.checkRevision.mockRejectedValueOnce({ code: "missing" });
  await vi.advanceTimersByTimeAsync(5000);
  expect(render().html).toContain(S.revisionNotices.missing);
  render({ ...props, active: false });
  render({ ...props, active: true });
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.checkRevision).toHaveBeenCalledOnce();
});

it("waits for actual Office readiness, then stages replacement before retiring the old document", async () => {
  vi.useFakeTimers();
  const file = { ...receipt, name: "result.docx" };
  h.inspectLink.mockResolvedValue(file);
  await ready();
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.checkRevision).not.toHaveBeenCalled();
  const child = render().nodes.find(
    (node) => typeof node.props.onStatus === "function",
  )!;
  (child.props.onStatus as (s: unknown) => void)({ file, state: "ready" });
  render();
  const next = { ...file, version: "new-document" };
  const pending = deferred<unknown>();
  h.checkRevision.mockResolvedValueOnce({ kind: "verified", file: next });
  h.prepareOffice.mockReturnValueOnce(pending.promise);
  await vi.advanceTimersByTimeAsync(0);
  expect(render().html).toContain('data-document-version="v1"');
  expect(render().html).not.toContain('data-document-version="new-document"');
  pending.resolve({ kind: "docx", file: next, value: { file: next } });
  await vi.advanceTimersByTimeAsync(0);
  expect(render().html).toContain('data-document-version="new-document"');
  expect(h.prepareOffice).toHaveBeenCalledOnce();
});

it("retains the old document and stops automatic checking when Office staging reports pending", async () => {
  vi.useFakeTimers();
  const file = { ...receipt, name: "result.docx" };
  h.inspectLink.mockResolvedValue(file);
  await ready();
  const child = render().nodes.find(
    (node) => typeof node.props.onStatus === "function",
  )!;
  (child.props.onStatus as (s: unknown) => void)({ file, state: "ready" });
  render();
  h.checkRevision.mockResolvedValueOnce({
    kind: "verified",
    file: { ...file, version: "new-document" },
  });
  h.prepareOffice.mockRejectedValueOnce({ code: "readPending" });
  await vi.advanceTimersByTimeAsync(0);
  expect(render().html).toContain('data-document-version="v1"');
  expect(render().html).toContain(S.revisionNotices.pending);
  render({ ...props, active: false });
  render({ ...props, active: true });
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.checkRevision).toHaveBeenCalledOnce();
});

it("opens the exact clicked path through the common inspector and renders verified Markdown", async () => {
  await ready();
  expect(h.inspectLink).toHaveBeenCalledWith("/work", "result.md");
  expect(h.readText).toHaveBeenCalledWith(receipt);
  expect(render().html).toContain("<h1>Real disk content</h1>");
  expect(h.open).not.toHaveBeenCalled();
  expect(props.onOpenHtml).not.toHaveBeenCalled();
});

it.each([
  ["inspect", D.checkWaitExpired],
  ["inspect", D.checkBusy],
  ["read", D.checkWaitExpired],
  ["read", D.checkBusy],
])(
  "keeps the fixed recovery guidance when %s reports %s",
  async (stage, notice) => {
    const rejected = stage === "inspect" ? h.inspectLink : h.readText;
    rejected.mockRejectedValueOnce(notice);
    render();
    await vi.waitFor(() => expect(button(S.retry)).toBeDefined());
    expect(render().html).toContain(notice);
    expect(render().html).not.toContain("Real disk content");
    expect(h.open).not.toHaveBeenCalled();
    expect(h.inspectLink).toHaveBeenCalledOnce();
  },
);

it("does not display arbitrary inspection errors as recovery guidance", async () => {
  h.inspectLink.mockRejectedValueOnce(new Error("private-path-and-secret"));
  render();
  await vi.waitFor(() => expect(button(S.retry)).toBeDefined());
  expect(render().html).toContain(S.failed);
  expect(render().html).not.toContain("private-path-and-secret");
});

it("renders code and CSV as literal text instead of executing their contents", async () => {
  const file = { ...receipt, name: "result.csv" };
  h.inspectLink.mockResolvedValue(file);
  h.readText.mockResolvedValue({
    file,
    text: '<script>alert("x")</script>,value',
  });
  await ready();
  expect(render().html).toContain("&lt;script&gt;");
  expect(render().html).not.toContain("<script>");
});
it("routes a verified workbook to its snapshot preview and refreshes to the new exact version", async () => {
  const file = {
    ...receipt,
    name: "result.XLSX",
    path: "/work/result.XLSX",
    resolvedPath: "/work/result.XLSX",
  };
  props.path = "result.XLSX";
  h.inspectLink.mockResolvedValueOnce(file);
  await ready();
  expect(render().html).toContain('data-workbook-version="v1"');
  expect(h.readText).not.toHaveBeenCalled();
  expect(h.readVisual).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
  expect(button(S.feedback)).toBeUndefined();
  h.inspectLink.mockResolvedValueOnce({
    ...file,
    version: "v2",
    sha256: "sha-b",
  });
  click(S.refresh);
  expect(render().html).not.toContain("data-workbook-version");
  await drain();
  expect(render().html).toContain('data-workbook-version="v2"');
  expect(render({ ...props, active: false }).html).toContain(
    'data-active="false"',
  );
});
it("does not send unsupported spreadsheet formats into the XLSX parser", async () => {
  h.inspectLink.mockResolvedValueOnce({ ...receipt, name: "legacy.xls" });
  await ready();
  expect(render().html).not.toContain("data-workbook-version");
  expect(render().html).toContain(S.other);
  expect(h.open).not.toHaveBeenCalled();
});

it("opens only the inspected DOCX version and refreshes it without handing the file to another app", async () => {
  const file = {
    ...receipt,
    name: "result.DOCX",
    path: "/work/result.DOCX",
    resolvedPath: "/work/result.DOCX",
  };
  props.path = "result.DOCX";
  h.inspectLink.mockResolvedValueOnce(file);
  await ready();
  expect(render().html).toContain('data-document-version="v1"');
  expect(h.readText).not.toHaveBeenCalled();
  expect(h.readVisual).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
  expect(button(S.feedback)).toBeUndefined();
  h.inspectLink.mockResolvedValueOnce({
    ...file,
    version: "v2",
    sha256: "sha-b",
  });
  click(S.refresh);
  expect(render().html).not.toContain("data-document-version");
  await drain();
  expect(render().html).toContain('data-document-version="v2"');
  expect(render({ ...props, active: false }).html).toContain(
    'data-document-active="false"',
  );
});

it.each(["legacy.doc", "macros.docm", "slides.pptx"])(
  "does not interpret %s as DOCX",
  async (name) => {
    h.inspectLink.mockResolvedValueOnce({ ...receipt, name });
    await ready();
    expect(render().html).not.toContain("data-document-version");
    expect(render().html).toContain(S.other);
    expect(h.open).not.toHaveBeenCalled();
  },
);

it("does not load links, images or raw HTML from a Markdown file", async () => {
  h.readText.mockResolvedValue({
    file: receipt,
    text: "[remote](https://example.com) ![picture](https://example.com/p.png)\n<script>bad()</script>",
  });
  await ready();
  const html = render().html;
  expect(html).not.toContain('href="https:');
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script");
});

it("hands verified HTML to the browser once and does not repeat after hide and return", async () => {
  const file = { ...receipt, name: "game.HTML" };
  h.inspectLink.mockResolvedValue(file);
  render();
  await vi.waitFor(() => expect(props.onOpenHtml).toHaveBeenCalledWith(file));
  const active = props;
  render({ ...active, active: false });
  render(active);
  await drain();
  expect(active.onOpenHtml).toHaveBeenCalledOnce();
  expect(h.readText).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
  click(S.openHtml);
  await vi.waitFor(() => expect(active.onOpenHtml).toHaveBeenCalledTimes(2));
  expect(h.inspectLink).toHaveBeenCalledTimes(2);
});

it("does not automatically launch another application for binary or executable files", async () => {
  const file = { ...receipt, name: "program.bin" };
  h.inspectLink.mockResolvedValue(file);
  await ready();
  expect(render().html).toContain(S.other);
  expect(h.readText).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
  click(S.open);
  await vi.waitFor(() => expect(h.open).toHaveBeenCalledWith(file));
  await vi.waitFor(() => expect(render().html).toContain(S.opened));
});

it("routes large Markdown to an explicit source fragment, retaining verified file actions", async () => {
  const file = { ...receipt, size: 1024 * 1024 + 1 };
  h.inspectLink.mockResolvedValue(file);
  h.readBlock.mockResolvedValue({
    file,
    blockIndex: 0,
    blockCount: 10,
    byteStart: 0,
    byteEnd: 18,
    startLine: 1,
    endLine: 1,
    startsMidLine: false,
    endsMidLine: true,
    text: "# partial Markdown",
  });
  await ready();
  expect(h.readBlock).toHaveBeenCalledWith(file, 0, true);
  expect(render().html).toContain("# partial Markdown");
  expect(render().html).not.toContain("<h1>");
  expect(button(S.feedback)).toBeDefined();
  expect(button(T.save)).toBeDefined();
  expect(h.readText).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
});

it("keeps the original path and retries after inspection failure", async () => {
  h.inspectLink.mockRejectedValueOnce(new Error("sensitive backend details"));
  render();
  await vi.waitFor(() => expect(button(S.retry)).toBeDefined());
  expect(render().html).toContain("result.md");
  expect(render().html).not.toContain("sensitive backend details");
  expect(button(S.open)).toBeUndefined();
  click(S.retry);
  await vi.waitFor(() => expect(button(S.open)).toBeDefined());
  expect(h.inspectLink).toHaveBeenCalledTimes(2);
});

it.each(["read failure", "changed version"])(
  "invalidates the receipt on %s",
  async (mode) => {
    if (mode === "read failure")
      h.readText.mockRejectedValueOnce(new Error("changed"));
    else
      h.readText.mockResolvedValueOnce({
        file: { ...receipt, version: "v2" },
        text: "must not display",
      });
    render();
    await vi.waitFor(() => expect(button(S.retry)).toBeDefined());
    expect(button(S.open)).toBeUndefined();
    expect(render().html).not.toContain("must not display");
    expect(h.open).not.toHaveBeenCalled();
  },
);

it("discards HTML inspection completed after hiding, with explicit retry on return", async () => {
  const pending = deferred<typeof receipt>();
  h.inspectLink.mockReturnValueOnce(pending.promise);
  render();
  const active = props;
  render({ ...active, active: false });
  render(active);
  pending.resolve({ ...receipt, name: "game.html" });
  await drain();
  expect(active.onOpenHtml).not.toHaveBeenCalled();
  expect(h.inspectLink).toHaveBeenCalledOnce();
  expect(button(S.retry)).toBeDefined();
});

it("never revives the old inspection after A to B to A selection changes", async () => {
  const old = deferred<typeof receipt>();
  const newer = deferred<typeof receipt>();
  h.inspectLink
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(newer.promise);
  render();
  const a = props;
  render({ ...a, selectionKey: "task-b:1", active: false });
  render({ ...a, selectionKey: "task-a:2" });
  old.resolve({ ...receipt, name: "old.html" });
  await drain();
  expect(a.onOpenHtml).not.toHaveBeenCalled();
  expect(render().html).toContain(S.loading);
  newer.resolve({ ...receipt, name: "new.html" });
  await vi.waitFor(() =>
    expect(a.onOpenHtml).toHaveBeenCalledWith(
      expect.objectContaining({ name: "new.html" }),
    ),
  );
  expect(a.onOpenHtml).toHaveBeenCalledOnce();
});

it("does not inspect or open an initially inactive selection", async () => {
  render({ ...props, active: false });
  const active = { ...props, active: true };
  render(active);
  await drain();
  expect(h.inspectLink).not.toHaveBeenCalled();
  expect(button(S.retry)).toBeDefined();
});

it("discards a delayed text result on unmount", async () => {
  const text = deferred<{ file: typeof receipt; text: string }>();
  h.readText.mockReturnValueOnce(text.promise);
  render();
  await vi.waitFor(() => expect(h.readText).toHaveBeenCalledOnce());
  for (const slot of h.slots) slot.cleanup?.();
  text.resolve({ file: receipt, text: "late private text" });
  await drain();
  expect(props.onOpenHtml).not.toHaveBeenCalled();
  expect(render().html).not.toContain("late private text");
});

it("copies only after explicit destination selection and passes the exact receipt", async () => {
  await ready();
  h.save.mockResolvedValue("/out/copy.md");
  click(T.save);
  await vi.waitFor(() =>
    expect(h.copy).toHaveBeenCalledWith(receipt, "/out/copy.md"),
  );
  expect(h.save).toHaveBeenCalledWith({
    title: T.saveTitle,
    defaultPath: "result.md",
  });
  expect(render().html).toContain("data-copy-jobs");
  expect(render().html).not.toContain(S.saved);
});

it("never copies after the destination picker returns to a hidden view", async () => {
  await ready();
  const destination = deferred<string | null>();
  h.save.mockReturnValueOnce(destination.promise);
  click(T.save);
  const active = props;
  render({ ...active, active: false });
  render(active);
  destination.resolve("/out/copy.md");
  await drain();
  expect(h.copy).not.toHaveBeenCalled();
  expect(button(S.retry)).toBeDefined();
});

it("invalidates displayed text and file actions after a delivery failure", async () => {
  await ready();
  h.reveal.mockRejectedValueOnce(new Error("file changed"));
  click(S.reveal);
  await vi.waitFor(() => expect(button(S.retry)).toBeDefined());
  expect(render().html).not.toContain("Real disk content");
  expect(button(S.open)).toBeUndefined();
});

it("retains a completed text view across hiding without automatically reading it again", async () => {
  await ready();
  const active = props;
  render({ ...active, active: false });
  render(active);
  await drain();
  expect(render().html).toContain("Real disk content");
  expect(h.readText).toHaveBeenCalledOnce();
});

function editFeedback(text: string) {
  if (!render().nodes.some((node) => node.type === "textarea"))
    click(S.feedback);
  const field = render().nodes.find((node) => node.type === "textarea")!;
  expect(field).toBeDefined();
  (field.props.onChange as (event: unknown) => void)({
    target: { value: text },
  });
}
function feedbackForm() {
  return render().nodes.find((node) => node.type === "form")!;
}
function submitFeedback(form = feedbackForm()) {
  expect(form).toBeDefined();
  (form.props.onSubmit as (event: unknown) => void)({
    preventDefault: () => {},
  });
}

it("explicitly rereads the disk file and replaces the displayed version without launching anything", async () => {
  await ready();
  const next = { ...receipt, version: "v2", sha256: "sha-b" };
  h.inspectLink.mockResolvedValueOnce(next);
  h.readText.mockResolvedValueOnce({ file: next, text: "# New disk content" });
  click(S.refresh);
  expect(render().html).not.toContain("Real disk content");
  await vi.waitFor(() => expect(render().html).toContain("New disk content"));
  expect(h.inspectLink).toHaveBeenCalledTimes(2);
  expect(h.readText).toHaveBeenLastCalledWith(next);
  expect(h.open).not.toHaveBeenCalled();
  expect(props.onOpenHtml).not.toHaveBeenCalled();
});

it("appends whole-file feedback once to the original composer and preserves its send protections", async () => {
  await ready();
  const original = {
    text: "Original input",
    attachments: [
      { id: "attachment", name: "notes.txt", kind: "file" as const },
    ],
    sendPending: true,
    queueEdit: {
      index: 2,
      original: [{ type: "text" as const, text: "Queued" }],
    },
  };
  composerDrafts.update("session:opened-file-test", () => original);
  editFeedback("Please clarify the conclusion.");
  const entries = Object.values(fileFeedbackDrafts.entries(props.threadKey));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    path: receipt.resolvedPath,
    selection: null,
    scope: "file",
    contentId: `disk:${JSON.stringify([receipt.resolvedPath, receipt.version, receipt.sha256])}`,
  });
  const form = feedbackForm();
  submitFeedback(form);
  const composed = composerDrafts.read("session:opened-file-test");
  expect(composed).toEqual({
    ...original,
    text: `Original input\n\n关于 ${receipt.resolvedPath}（当时查看的内容）：\nPlease clarify the conclusion.`,
  });
  expect(composerDrafts.read("session:other-file-test").text).toBe("");
  expect(
    Object.values(fileFeedbackDrafts.entries(props.threadKey)),
  ).toHaveLength(0);
  submitFeedback(form);
  expect(composerDrafts.read("session:opened-file-test")).toBe(composed);
  // A completion for an earlier send cannot erase the newly appended feedback.
  composerDrafts.clearIfUnchanged("session:opened-file-test", original);
  expect(composerDrafts.read("session:opened-file-test")).toBe(composed);
  expect(render().html).toContain(W.feedbackAdded);
  expect(h.inspectLink).toHaveBeenCalledOnce();
  expect(h.readText).toHaveBeenCalledOnce();
  expect(h.open).not.toHaveBeenCalled();
});

it("keeps the earlier version's opinion separate after a refresh and exposes the existing saved-draft control", async () => {
  await ready();
  editFeedback("Opinion for version one");
  const first = Object.values(fileFeedbackDrafts.entries(props.threadKey))[0];
  const next = { ...receipt, version: "v2", sha256: "sha-b" };
  h.inspectLink.mockResolvedValueOnce(next);
  h.readText.mockResolvedValueOnce({ file: next, text: "# Version two" });
  click(S.refresh);
  await vi.waitFor(() => expect(render().html).toContain("Version two"));
  expect(render().nodes.some((node) => node.type === "textarea")).toBe(false);
  const saved = render().nodes.find(
    (node) => node.type === FileFeedbackDrafts,
  )!;
  expect(saved.props).toMatchObject({
    threadKey: props.threadKey,
    path: receipt.resolvedPath,
  });
  expect(saved.props.excludeContentId).not.toBe(first.contentId);
  expect(render().html).toContain("Opinion for version one");
  editFeedback("Opinion for version two");
  const both = Object.values(fileFeedbackDrafts.entries(props.threadKey));
  expect(both).toHaveLength(2);
  expect(both.map((entry) => entry.contentId)).toEqual([
    first.contentId,
    `disk:${JSON.stringify([next.resolvedPath, next.version, next.sha256])}`,
  ]);
  submitFeedback();
  expect(composerDrafts.read(`session:${props.threadKey}`).text).toContain(
    "Opinion for version two",
  );
  expect(composerDrafts.read(`session:${props.threadKey}`).text).not.toContain(
    "Opinion for version one",
  );
  expect(Object.values(fileFeedbackDrafts.entries(props.threadKey))).toEqual([
    first,
  ]);
});

it("restores the same unsent opinion after rereading the unchanged version", async () => {
  await ready();
  editFeedback("Still editing");
  click(S.refresh);
  await vi.waitFor(() => expect(h.readText).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(
      render().nodes.find((node) => node.type === "textarea")?.props.value,
    ).toBe("Still editing"),
  );
  expect(
    Object.values(fileFeedbackDrafts.entries(props.threadKey)),
  ).toHaveLength(1);
  expect(composerDrafts.read(`session:${props.threadKey}`).text).toBe("");
});

it.each([
  "hidden",
  "task changed",
  "unmounted",
  "refreshing",
  "refresh failed",
  "new version",
])(
  "rejects a stale feedback form or editor when %s without losing the original opinion",
  async (mode) => {
    await ready();
    editFeedback("Retained opinion");
    const originalKey = props.threadKey;
    const form = feedbackForm();
    const field = render().nodes.find((node) => node.type === "textarea")!;
    if (mode === "hidden") render({ ...props, active: false });
    if (mode === "task changed")
      render({ ...props, threadKey: "other-file-test" });
    if (mode === "unmounted") for (const slot of h.slots) slot.cleanup?.();
    if (mode === "refreshing") {
      h.inspectLink.mockReturnValueOnce(deferred<typeof receipt>().promise);
      click(S.refresh);
    }
    if (mode === "refresh failed") {
      h.inspectLink.mockRejectedValueOnce(new Error("Changed file"));
      click(S.refresh);
      await vi.waitFor(() => expect(button(S.retry)).toBeDefined());
      expect(render().html).not.toContain("Real disk content");
    }
    if (mode === "new version") {
      const next = { ...receipt, version: "v2", sha256: "sha-b" };
      h.inspectLink.mockResolvedValueOnce(next);
      h.readText.mockResolvedValueOnce({ file: next, text: "New version" });
      click(S.refresh);
      await vi.waitFor(() => expect(render().html).toContain("New version"));
    }
    (field.props.onChange as (event: unknown) => void)({
      target: { value: "Late replacement" },
    });
    submitFeedback(form);
    expect(composerDrafts.read(`session:${originalKey}`).text).toBe("");
    expect(composerDrafts.read("session:other-file-test").text).toBe("");
    expect(
      Object.values(fileFeedbackDrafts.entries(originalKey)).map(
        (entry) => entry.text,
      ),
    ).toEqual(["Retained opinion"]);
  },
);

it.each(["project.html", "archive.zip"])(
  "keeps text-feedback and reread controls out of %s delivery",
  async (name) => {
    h.inspectLink.mockResolvedValue({ ...receipt, name });
    await ready();
    expect(button(S.refresh)).toBeUndefined();
    expect(button(S.feedback)).toBeUndefined();
    expect(Boolean(button(S.openHtml))).toBe(name.endsWith(".html"));
  },
);

it("does not move a blank opinion into the composer even if the form is submitted directly", async () => {
  await ready();
  editFeedback("   ");
  submitFeedback();
  expect(composerDrafts.read(`session:${props.threadKey}`).text).toBe("");
  expect(
    Object.values(fileFeedbackDrafts.entries(props.threadKey))[0].text,
  ).toBe("   ");
});

it("loads visual bytes from the exact verified receipt and offers a fresh read", async () => {
  const file = { ...receipt, name: "result.pdf", size: 6 };
  h.inspectLink.mockResolvedValue(file);
  h.readVisual.mockResolvedValue({
    file,
    mimeType: "application/pdf",
    data: btoa("%PDF-1"),
  });
  await ready();
  expect(h.readVisual).toHaveBeenCalledWith(file);
  expect(render().html).toContain('data-visual-version="v1"');
  expect(button(S.refresh)).toBeDefined();
});

it("does not display mismatched or late visual bytes from a prior selection", async () => {
  const first = { ...receipt, name: "first.pdf", size: 6 },
    second = { ...first, name: "second.pdf", version: "v2", sha256: "sha2" };
  const late = deferred<{
    file: typeof first;
    mimeType: string;
    data: string;
  }>();
  h.inspectLink.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  h.readVisual.mockReturnValueOnce(late.promise).mockResolvedValueOnce({
    file: second,
    mimeType: "application/pdf",
    data: btoa("%PDF-2"),
  });
  render();
  await vi.waitFor(() => expect(h.readVisual).toHaveBeenCalledOnce());
  props = { ...props, selectionKey: "next-visual" };
  await ready();
  late.resolve({
    file: first,
    mimeType: "application/pdf",
    data: btoa("%PDF-1"),
  });
  await drain();
  expect(render().html).toContain('data-visual-version="v2"');
  expect(render().html).not.toContain('data-visual-version="v1"');
});

it("keeps verified external-file actions when a large image cannot be previewed", async () => {
  h.inspectLink.mockResolvedValue({
    ...receipt,
    name: "large.png",
    size: 9 * 1024 * 1024,
  });
  await ready();
  expect(h.readVisual).not.toHaveBeenCalled();
  expect(render().html).toContain("文件超过当前预览限制");
  expect(button(S.open)).toBeDefined();
  expect(button(S.refresh)).toBeDefined();
});

it("never hands a changed visual receipt to the renderer", async () => {
  const file = { ...receipt, name: "result.pdf", size: 6 };
  h.inspectLink.mockResolvedValue(file);
  h.readVisual.mockResolvedValue({
    file: { ...file, sha256: "different" },
    mimeType: "application/pdf",
    data: btoa("%PDF-1"),
  });
  await ready();
  expect(render().html).not.toContain("data-visual-version");
  expect(render().html).toContain("未能预览这份文件");
});

const visualReceipt = {
  ...receipt,
  path: "/work/result.pdf",
  resolvedPath: "/work/result.pdf",
  name: "result.pdf",
  size: 6,
  sha256: "a".repeat(64),
};
async function visualReady() {
  h.inspectLink.mockResolvedValue(visualReceipt);
  h.readVisual.mockResolvedValue({
    file: visualReceipt,
    mimeType: "application/pdf",
    data: btoa("%PDF-1"),
  });
  await ready();
  return render().nodes.find((node) => node.props.preview)!;
}
function reportPage(
  node: Element,
  location: unknown,
  source = node.props.preview,
) {
  expect(typeof node.props.onReadiness).toBe("function");
  (node.props.onReadiness as (value: unknown) => void)({ source, location });
  render();
}
it("offers PDF feedback only from a rendered current page and preserves its chosen page across navigation", async () => {
  const visual = await visualReady();
  expect(button(S.feedback)?.props.disabled).toBe(true);
  reportPage(visual, { kind: "pdf", page: 1, pageCount: 3 });
  editFeedback("Keep this opinion");
  click("针对当前第 1 页");
  let draft = Object.values(fileFeedbackDrafts.entries(props.threadKey))[0];
  expect(draft).toMatchObject({
    anchor: { kind: "pdf-page", page: 1, pageCount: 3 },
  });
  reportPage(visual, null);
  reportPage(visual, { kind: "pdf", page: 2, pageCount: 3 });
  expect(Object.values(fileFeedbackDrafts.entries(props.threadKey))[0]).toBe(
    draft,
  );
  expect(render().html).toContain("意见针对第 1 / 3 页");
  submitFeedback();
  const composed = composerDrafts.read(`session:${props.threadKey}`).text;
  expect(composed).toContain("第 1 / 3 页");
  expect(composed).toContain(visualReceipt.sha256);
  expect(composed).toContain("Keep this opinion");
  expect(h.open).not.toHaveBeenCalled();
});
it("keeps a current visual opinion reachable when the page fails, but removes the current-page option", async () => {
  const visual = await visualReady();
  reportPage(visual, { kind: "pdf", page: 1, pageCount: 3 });
  editFeedback("Retain on failure");
  click("针对当前第 1 页");
  reportPage(visual, null);
  expect(button("针对当前第 1 页")).toBeUndefined();
  expect(
    render().nodes.find((node) => node.type === "textarea")?.props.value,
  ).toBe("Retain on failure");
  expect(
    Object.values(fileFeedbackDrafts.entries(props.threadKey))[0].text,
  ).toBe("Retain on failure");
});
it("does not accept a visible-page report from another source or after hiding", async () => {
  const visual = await visualReady();
  reportPage(
    visual,
    { kind: "pdf", page: 2, pageCount: 3 },
    { ...(visual.props.preview as object) },
  );
  expect(button(S.feedback)?.props.disabled).toBe(true);
  render({ ...props, active: false });
  reportPage(visual, { kind: "pdf", page: 2, pageCount: 3 });
  expect(button(S.feedback)?.props.disabled).toBe(true);
  expect(
    Object.values(fileFeedbackDrafts.entries(props.threadKey)),
  ).toHaveLength(0);
});

it("rejects a stale page-target button after navigation and preserves its existing text", async () => {
  const visual = await visualReady();
  reportPage(visual, { kind: "pdf", page: 1, pageCount: 3 });
  editFeedback("keep opinion");
  const oldButton = render().nodes.find(
    (n) => n.type === "button" && n.props.children === "针对当前第 1 页",
  )!;
  reportPage(visual, null);
  reportPage(visual, { kind: "pdf", page: 2, pageCount: 3 });
  (oldButton.props.onClick as () => void)();
  const saved = Object.values(fileFeedbackDrafts.entries(props.threadKey))[0];
  expect(saved.text).toBe("keep opinion");
  expect(saved.anchor).toBeUndefined();
  click("针对当前第 2 页");
  expect(
    Object.values(fileFeedbackDrafts.entries(props.threadKey))[0].anchor?.page,
  ).toBe(2);
});
it.each([
  { kind: "pdf", page: 0, pageCount: 3 },
  { kind: "pdf", page: 4, pageCount: 3 },
  { kind: "pdf", page: 1, pageCount: 1001 },
  { kind: "image" },
])(
  "does not allow a malformed or mismatched ready location %j",
  async (location) => {
    const visual = await visualReady();
    reportPage(visual, location);
    expect(button(S.feedback)!.props.disabled).toBe(true);
    expect(
      Object.values(fileFeedbackDrafts.entries(props.threadKey)),
    ).toHaveLength(0);
  },
);
it("keeps old-version page opinions after refresh and rejects old-source readiness", async () => {
  const visual = await visualReady();
  reportPage(visual, { kind: "pdf", page: 2, pageCount: 3 });
  editFeedback("old version");
  click("针对当前第 2 页");
  const old = Object.values(fileFeedbackDrafts.entries(props.threadKey))[0];
  const next = { ...visualReceipt, version: "v2", sha256: "b".repeat(64) };
  h.inspectLink.mockResolvedValue(next);
  h.readVisual.mockResolvedValue({
    file: next,
    mimeType: "application/pdf",
    data: btoa("%PDF-1"),
  });
  click(S.refresh);
  await drain();
  render();
  reportPage(visual, { kind: "pdf", page: 3, pageCount: 3 });
  expect(button(S.feedback)!.props.disabled).toBe(true);
  const retained = render().nodes.find((n) => n.type === FileFeedbackDrafts)!;
  expect(retained.props.excludeContentId).not.toBe(old.contentId);
  expect(
    fileFeedbackDrafts.entries(props.threadKey)[
      JSON.stringify([old.path, old.contentId])
    ],
  ).toBe(old);
});
it("provides image file feedback with exact version but no PDF page control", async () => {
  const image = {
    ...visualReceipt,
    path: "/work/result.png",
    resolvedPath: "/work/result.png",
    name: "result.png",
  };
  props.path = image.path;
  h.inspectLink.mockResolvedValue(image);
  h.readVisual.mockResolvedValue({
    file: image,
    mimeType: "image/png",
    data: "fixture",
  });
  await ready();
  const visual = render().nodes.find((n) => n.props.preview)!;
  reportPage(visual, { kind: "image" });
  editFeedback("change contrast");
  expect(render().html).toContain("意见针对整个文件");
  expect(render().html).not.toContain("针对当前第");
  submitFeedback();
  const text = composerDrafts.read(`session:${props.threadKey}`).text;
  expect(text).toContain("change contrast");
  expect(text).toContain(image.sha256);
  expect(text).not.toContain(" 页");
});
it("withdraws stale current-page actions while hidden and retains a blank selected-page draft", async () => {
  const visual = await visualReady();
  reportPage(visual, { kind: "pdf", page: 1, pageCount: 3 });
  click(S.feedback);
  render();
  click("针对当前第 1 页");
  const draft = Object.values(fileFeedbackDrafts.entries(props.threadKey))[0];
  expect(draft.anchor?.page).toBe(1);
  expect(draft.text).toBe("");
  props.active = false;
  render();
  expect(render().html).not.toContain("针对当前第 1 页");
  expect(Object.values(fileFeedbackDrafts.entries(props.threadKey))[0]).toBe(
    draft,
  );
});

function largeBlock(version = "v1", blockIndex = 0) {
  const file = {
    ...receipt,
    size: 2 * 1024 * 1024,
    version,
    sha256: `sha-${version}`,
  };
  return {
    file,
    blockIndex,
    blockCount: 20,
    byteStart: blockIndex * 10,
    byteEnd: blockIndex * 10 + 10,
    startLine: 1,
    endLine: 1,
    startsMidLine: blockIndex > 0,
    endsMidLine: true,
    text: `contents-${version}`,
  };
}
it("retains old large-file text until a complete replacement block succeeds, then restores approximate position", async () => {
  const first = largeBlock();
  h.inspectLink.mockResolvedValue(first.file);
  h.readBlock.mockResolvedValue(first);
  await ready();
  const child = render().nodes.find((n) => n.props.initial === first)!;
  (child.props.readingPosition as { current: unknown }).current = {
    root: first.file.root,
    resolvedPath: first.file.resolvedPath,
    kind: "text",
    blockIndex: 9,
  };
  const next = largeBlock("v2", 4),
    pending = deferred<typeof next>();
  h.inspectLink.mockResolvedValue(next.file);
  h.readBlock.mockReturnValue(pending.promise);
  click(S.refresh);
  await drain();
  expect(h.readBlock).toHaveBeenLastCalledWith(next.file, 9, true);
  expect(render().html).toContain(first.text);
  expect(render().html).not.toContain(next.text);
  pending.resolve(next);
  await drain();
  expect(render().html).toContain(next.text);
  expect(render().html).not.toContain(first.text);
});
it("keeps file-level feedback and its original version when navigating and refreshing fragments", async () => {
  const first = largeBlock();
  h.inspectLink.mockResolvedValue(first.file);
  h.readBlock.mockResolvedValue(first);
  await ready();
  editFeedback("review whole file");
  expect(render().html).toContain(T.feedback);
  const old = Object.values(fileFeedbackDrafts.entries(props.threadKey))[0];
  expect(old.scope).toBe("file");
  expect(old.selection).toBeNull();
  expect(old.anchor).toBeUndefined();
  const next = largeBlock("v2");
  h.inspectLink.mockResolvedValue(next.file);
  h.readBlock.mockResolvedValue(next);
  click(S.refresh);
  await drain();
  render();
  expect(Object.values(fileFeedbackDrafts.entries(props.threadKey))).toContain(
    old,
  );
  expect(old.contentId).toContain("v1");
  expect(old.contentId).not.toContain("v2");
});
it("does not replace old fragment on failed revision reading and exposes fixed unsupported-text notice initially", async () => {
  const first = largeBlock();
  h.inspectLink.mockResolvedValue(first.file);
  h.readBlock.mockRejectedValue({
    code: "unsupportedText",
    message: "PRIVATE OS DATA",
  });
  render();
  await drain();
  expect(render().html).toContain(T.failures.unsupportedText);
  expect(render().html).not.toContain("PRIVATE OS DATA");
  expect(h.readText).not.toHaveBeenCalled();
});

it("provides only explicit location actions when inspection is too large, without inventing a verified file", async () => {
  h.inspectLink.mockRejectedValue({ code: "tooLarge" });
  render();
  await drain();
  expect(render().html).toContain(T.failures.tooLarge);
  expect(render().html).toContain(T.locationScope);
  expect(h.openLocation).not.toHaveBeenCalled();
  expect(h.revealLocation).not.toHaveBeenCalled();
  expect(h.readBlock).not.toHaveBeenCalled();
  expect(button(T.save)).toBeUndefined();
  click(T.openLocation);
  await drain();
  expect(h.openLocation).toHaveBeenCalledWith(
    props.workingDirectory,
    props.path,
  );
  expect(h.open).not.toHaveBeenCalled();
  expect(render().html).toContain(T.openedLocation);
  click(T.revealLocation);
  await drain();
  expect(h.revealLocation).toHaveBeenCalledWith(
    props.workingDirectory,
    props.path,
  );
});
it("a stale location fallback callback cannot open another selected file", async () => {
  h.inspectLink.mockRejectedValue({ code: "tooLarge" });
  render();
  await drain();
  const old = button(T.openLocation)!;
  render({ ...props, path: "other.txt", selectionKey: "new" });
  await drain();
  (old.props.onClick as () => void)();
  await drain();
  expect(h.openLocation).not.toHaveBeenCalled();
});
