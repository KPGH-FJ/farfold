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
  readText: vi.fn(),
  readVisual: vi.fn(),
  open: vi.fn(),
  reveal: vi.fn(),
  copy: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: h.save }));
vi.mock("../runtime/file_delivery", () => ({
  fileDelivery: {
    inspectLink: h.inspectLink,
    checkRevision: h.checkRevision,
    readText: h.readText,
    readVisual: h.readVisual,
    open: h.open,
    reveal: h.reveal,
    copy: h.copy,
  },
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
    h.readText,
    h.readVisual,
    h.open,
    h.reveal,
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Independent P20 review: exercise the actual parent and monitor during the
// second asynchronous read, after checkRevision has already found a new file.
it.each(["success", "failure", "pending"])(
  "keeps the previous verified snapshot if hidden during automatic reread (%s)",
  async (outcome) => {
    vi.useFakeTimers();
    await ready();
    const next = { ...receipt, version: "review-v2", sha256: "review-sha2" };
    const read = deferred<{ file: typeof receipt; text: string }>();
    h.checkRevision.mockResolvedValueOnce({ kind: "verified", file: next });
    h.readText.mockReturnValueOnce(read.promise);
    await vi.advanceTimersByTimeAsync(5000);
    render();
    expect(h.readText).toHaveBeenLastCalledWith(next);
    render({ ...props, active: false });
    render();
    render({ ...props, active: true });
    if (outcome === "success")
      read.resolve({ file: next, text: "late version two" });
    else
      read.reject(
        new Error(
          outcome === "pending"
            ? D.checkWaitExpired
            : "controlled old read failure",
        ),
      );
    await vi.advanceTimersByTimeAsync(0);
    const current = render().html;
    expect(current).toContain("Real disk content");
    expect(current).not.toContain("late version two");
    if (outcome === "pending") {
      expect(current).toContain(S.revisionNotices.pending);
      await vi.advanceTimersByTimeAsync(120000);
      expect(h.checkRevision).toHaveBeenCalledOnce();
    }
  },
);

it("does not publish an automatic reread after window visibility invalidates its owner", async () => {
  vi.useFakeTimers();
  const listeners = new Map<string, () => void>();
  const doc = {
    visibilityState: "visible",
    addEventListener: (name: string, callback: () => void) =>
      listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", {
    addEventListener: (name: string, callback: () => void) =>
      listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
  });
  {
    await ready();
    const next = { ...receipt, version: "review-v2", sha256: "review-sha2" };
    const read = deferred<{ file: typeof receipt; text: string }>();
    h.checkRevision.mockResolvedValueOnce({ kind: "verified", file: next });
    h.readText.mockReturnValueOnce(read.promise);
    await vi.advanceTimersByTimeAsync(5000);
    render();
    expect(h.readText).toHaveBeenLastCalledWith(next);
    doc.visibilityState = "hidden";
    expect(listeners.has("visibilitychange")).toBe(true);
    listeners.get("visibilitychange")!();
    read.resolve({ file: next, text: "late version two" });
    await vi.advanceTimersByTimeAsync(0);
    const current = render().html;
    expect(current).toContain("Real disk content");
    expect(current).not.toContain("late version two");
  }
});

it("keeps the pending outcome of an automatic content read distinct from a finished failure", async () => {
  vi.useFakeTimers();
  await ready();
  const next = { ...receipt, version: "review-v2", sha256: "review-sha2" };
  h.checkRevision.mockResolvedValueOnce({ kind: "verified", file: next });
  h.readText.mockRejectedValueOnce(new Error(D.checkWaitExpired));
  await vi.advanceTimersByTimeAsync(5000);
  expect(render().html).toContain("Real disk content");
  expect(render().html).toContain(S.revisionNotices.pending);
  render({ ...props, active: false });
  render({ ...props, active: true });
  await vi.advanceTimersByTimeAsync(120000);
  expect(h.checkRevision).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "retains the visible old PDF page's readiness after failed automatic refresh (navigate=%s)",
  async (navigate) => {
    vi.useFakeTimers();
    const file = {
      ...receipt,
      path: "/work/result.pdf",
      resolvedPath: "/work/result.pdf",
      name: "result.pdf",
      size: 6,
      sha256: "a".repeat(64),
    };
    const visual = { file, mimeType: "application/pdf", data: btoa("%PDF-1") };
    h.inspectLink.mockResolvedValue(file);
    h.readVisual.mockResolvedValue(visual);
    await ready();
    const node = render().nodes.find((item) => item.props.preview)!;
    const report = node.props.onReadiness as (value: unknown) => void;
    report({
      source: visual,
      location: { kind: "pdf", page: 1, pageCount: 3 },
    });
    render();
    expect(button(S.feedback)?.props.disabled).toBe(false);
    const next = { ...file, version: "review-v2", sha256: "b".repeat(64) };
    const read = deferred<typeof visual>();
    h.checkRevision.mockResolvedValueOnce({ kind: "verified", file: next });
    h.readVisual.mockReturnValueOnce(read.promise);
    await vi.advanceTimersByTimeAsync(5000);
    render();
    if (navigate) {
      report({ source: visual, location: null });
      report({
        source: visual,
        location: { kind: "pdf", page: 2, pageCount: 3 },
      });
      render();
    }
    read.reject(new Error("controlled visual refresh failure"));
    await vi.advanceTimersByTimeAsync(0);
    render();
    expect(button(S.feedback)?.props.disabled).toBe(false);
    click(S.feedback);
    expect(button(`针对当前第 ${navigate ? 2 : 1} 页`)).toBeDefined();
  },
);
