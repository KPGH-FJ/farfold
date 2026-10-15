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
import { SourceTextSelection } from "./SourceTextSelection";
import {
  TextBlockPreview,
  type TextBlockPreviewProps,
} from "./TextBlockPreview";
import { FILE_OPEN_STRINGS as S } from "../runtime/file_open_strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { VISUAL_FEEDBACK_STRINGS as V } from "../runtime/visual_feedback_strings";
import {
  createTextFeedbackSource,
  textFeedbackRange,
  type TextFeedbackSource,
} from "../runtime/text_feedback_range";
import type { TextRangeAnchor } from "../runtime/file_feedback_anchor";
import type { TextBlockPreview as Block } from "../runtime/text_block_preview";
import { composerDrafts, fileFeedbackDrafts } from "../runtime/drafts";
import { FileFeedbackDrafts } from "./FileFeedbackDrafts";

const text = "\ufeff# repeat\r\n中🙂e\u0301 repeat\r\n尾";
const file = {
  root: "/work",
  path: "/work/result.md",
  resolvedPath: "/work/result.md",
  name: "result.md",
  size: new TextEncoder().encode(text).length,
  sha256: "a".repeat(64),
  version: "v1",
};
const contentId = (value = file) =>
  `disk:${JSON.stringify([value.resolvedPath, value.version, value.sha256])}`;
let props: OpenedFileViewProps;
type Element = ReactElement<Record<string, unknown>>;
type SelectionProps = {
  source: TextFeedbackSource;
  enabled: boolean;
  onAvailability: (v: {
    source: TextFeedbackSource;
    available: boolean;
  }) => void;
  onConfirm: (v: {
    source: TextFeedbackSource;
    anchor: TextRangeAnchor;
  }) => void;
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
function click(label: string) {
  const button = render().nodes.find(
    (n) => n.type === "button" && n.props.children === label,
  );
  expect(button, label).toBeDefined();
  (button!.props.onClick as () => void)();
}
const selection = () =>
  render().nodes.find((n) => n.type === SourceTextSelection)?.props as
    SelectionProps | undefined;
const saved = () =>
  fileFeedbackDrafts.read(props.threadKey, file.resolvedPath, contentId());
function announce(p: SelectionProps, available = true) {
  p.onAvailability({ source: p.source, available });
}
function confirm(p: SelectionProps, start = 2, end = 8) {
  const anchor = textFeedbackRange(p.source, start, end)!;
  expect(anchor).not.toBeNull();
  p.onConfirm({ source: p.source, anchor });
  return anchor;
}
async function ready() {
  render();
  await vi.waitFor(() =>
    expect(
      render().nodes.some(
        (n) => n.type === "button" && n.props.children === S.open,
      ),
    ).toBe(true),
  );
}
async function sourceReady() {
  await ready();
  click(S.markdownSource);
  return selection()!;
}

beforeEach(() => {
  for (const key of ["text-feedback-parent", "other-text-feedback"]) {
    for (const entry of Object.values(fileFeedbackDrafts.entries(key)))
      fileFeedbackDrafts.clear(key, entry.path);
    composerDrafts.clear(`session:${key}`);
  }
  h.slots.length = 0;
  h.effects.length = 0;
  h.cursor = 0;
  for (const mock of [h.inspect, h.read, h.block, h.monitor]) mock.mockReset();
  h.inspect.mockResolvedValue(file);
  h.read.mockResolvedValue({ file, text });
  props = {
    threadKey: "text-feedback-parent",
    path: "result.md",
    workingDirectory: "/work",
    active: true,
    selectionKey: "a",
    onOpenHtml: vi.fn(),
  };
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
});

it("never derives ranges from rendered Markdown; source view retains exact receipt text", async () => {
  await ready();
  expect(selection()).toBeUndefined();
  expect(render().html).toContain("<h1>");
  click(S.markdownSource);
  const p = selection()!;
  expect(p.source.text).toBe(text);
  expect(p.enabled).toBe(true);
  click(S.markdownRendered);
  expect(selection()).toBeUndefined();
  announce(p);
  confirm(p);
  expect(saved().anchor).toBeUndefined();
});

it("only an explicit current selection confirmation retargets existing text", async () => {
  const p = await sourceReady();
  fileFeedbackDrafts.update(props.threadKey, file.resolvedPath, {
    text: "保留意见",
    selection: null,
    scope: "file",
    contentId: contentId(),
  });
  confirm(p);
  expect(saved().anchor).toBeUndefined();
  announce(p);
  expect(saved().anchor).toBeUndefined();
  const anchor = confirm(
    p,
    text.lastIndexOf("repeat"),
    text.lastIndexOf("repeat") + 6,
  );
  expect(saved()).toMatchObject({ text: "保留意见", anchor });
  expect(render().html).toContain(S.textTarget(2, 2));
  announce(p, false);
  expect(saved().anchor).toEqual(anchor);
  click(V.wholeFile);
  expect(saved().text).toBe("保留意见");
  expect(saved().anchor).toBeUndefined();
});

it("retires callbacks on hide, file change, and a different view of the same path", async () => {
  const p = await sourceReady();
  announce(p);
  render({ ...props, active: false });
  confirm(p);
  expect(saved().anchor).toBeUndefined();
  render({ ...props, active: true, selectionKey: "another-selection" });
  announce(p);
  confirm(p);
  expect(saved().anchor).toBeUndefined();
  await ready();
  expect(selection()).toBeUndefined();
});

it("defer-refresh protects an unconfirmed selection; withdrawal lets the real new version load", async () => {
  const p = await sourceReady();
  announce(p);
  const next = { ...file, version: "v2", sha256: "b".repeat(64) };
  const monitor = h.monitor.mock.lastCall![0];
  expect(await monitor.apply(next, () => true)).toBe("deferred");
  expect(h.read).toHaveBeenCalledTimes(1);
  announce(p, false);
  h.read.mockResolvedValueOnce({ file: next, text });
  expect(await monitor.apply(next, () => true)).toBe("applied");
  render();
  announce(p);
  confirm(p);
  expect(saved().anchor).toBeUndefined();
  expect(selection()!.source.file.version).toBe("v2");
});

it("retains historical range and text when same pathname is reread with a different version", async () => {
  const p = await sourceReady();
  announce(p);
  const anchor = confirm(p);
  fileFeedbackDrafts.update(props.threadKey, file.resolvedPath, {
    ...saved(),
    text: "旧版本意见",
  });
  const next = { ...file, version: "v2", sha256: "b".repeat(64), size: 1 };
  h.inspect.mockResolvedValueOnce(next);
  h.read.mockResolvedValueOnce({ file: next, text: "x" });
  click(S.refresh);
  await vi.waitFor(() => expect(selection()?.source.file.version).toBe("v2"));
  expect(saved()).toMatchObject({ text: "旧版本意见", anchor });
  expect(
    renderToStaticMarkup(
      <FileFeedbackDrafts
        threadKey={props.threadKey}
        path={file.resolvedPath}
        excludeContentId={contentId(next)}
      />,
    ),
  ).toContain("旧版本意见");
  expect(
    fileFeedbackDrafts.read(props.threadKey, file.resolvedPath, contentId(next))
      .anchor,
  ).toBeUndefined();
});

it("takes the selected version once into its original composer without sending", async () => {
  const p = await sourceReady();
  announce(p);
  const anchor = confirm(p);
  const textarea = render().nodes.find((n) => n.type === "textarea")!;
  (textarea.props.onChange as (event: unknown) => void)({
    target: { value: "请修改" },
  });
  composerDrafts.update(`session:${props.threadKey}`, (old) => ({
    ...old,
    text: "已有输入",
    attachments: [],
  }));
  const form = render().nodes.find((n) => n.type === "form")!;
  const submit = () =>
    (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  submit();
  const draft = composerDrafts.read(`session:${props.threadKey}`);
  expect(draft.text).toContain("已有输入");
  expect(draft.text).toContain("请修改");
  expect(draft.text).toContain(file.sha256);
  expect(draft.text).not.toContain("第 undefined");
  expect(saved().anchor).toBeUndefined();
  submit();
  expect(composerDrafts.read(`session:${props.threadKey}`)).toEqual(draft);
  expect(anchor.byteEnd).toBeGreaterThan(anchor.byteStart);
  expect(render().html).toContain(W.feedbackAdded);
});

it("uses the child's current global block source, not the parent's first block", async () => {
  const big = { ...file, name: "big.txt", size: 2 * 1024 * 1024 };
  const first: Block = {
    file: big,
    text: "a".repeat(131072),
    blockIndex: 0,
    blockCount: 17,
    byteStart: 0,
    byteEnd: 131072,
    startLine: 1,
    endLine: 1,
    startsMidLine: false,
    endsMidLine: true,
  };
  const second = {
    ...first,
    text: "中🙂END",
    blockIndex: 1,
    byteStart: 131072,
    byteEnd: 131082,
    startsMidLine: true,
  };
  h.inspect.mockResolvedValueOnce(big);
  h.block.mockResolvedValueOnce(first);
  await ready();
  const child = render().nodes.find((n) => n.type === TextBlockPreview)!
    .props as unknown as TextBlockPreviewProps;
  const source = createTextFeedbackSource(second, big)!;
  expect(source).not.toBeNull();
  child.onTextSelectionAvailability!({ source, available: true });
  const anchor = textFeedbackRange(source, 1, 6)!;
  child.onTextSelectionConfirm!({ source, anchor });
  expect(saved().anchor).toEqual({
    kind: "text-range",
    byteStart: 131075,
    byteEnd: 131082,
    startLine: 1,
    endLine: 1,
  });
  child.onStatus!({ file: big, state: "loading", readInFlight: true });
  child.onTextSelectionConfirm!({
    source,
    anchor: textFeedbackRange(source, 0, 1)!,
  });
  expect(saved().anchor).toEqual(anchor);
});

it("does not offer coordinate selection for an inconsistent small-text receipt", async () => {
  h.read.mockResolvedValueOnce({ file, text: "wrong byte count" });
  await ready();
  click(S.markdownSource);
  expect(selection()).toBeUndefined();
  expect(render().html).toContain("wrong byte count");
});
