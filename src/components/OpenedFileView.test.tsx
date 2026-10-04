import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  cursor: 0,
  effects: [] as (() => void)[],
  inspectLink: vi.fn(),
  readText: vi.fn(),
  open: vi.fn(),
  reveal: vi.fn(),
  copy: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: h.save }));
vi.mock("../runtime/file_delivery", () => ({
  fileDelivery: {
    inspectLink: h.inspectLink,
    readText: h.readText,
    open: h.open,
    reveal: h.reveal,
    copy: h.copy,
  },
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
    useEffect: effect,
    useLayoutEffect: effect,
  };
});

import { OpenedFileView, type OpenedFileViewProps } from "./OpenedFileView";
import { FILE_OPEN_STRINGS as S } from "../runtime/file_open_strings";

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
  h.slots.length = 0;
  h.effects.length = 0;
  h.cursor = 0;
  for (const mock of [
    h.inspectLink,
    h.readText,
    h.open,
    h.reveal,
    h.copy,
    h.save,
  ])
    mock.mockReset();
  h.inspectLink.mockResolvedValue(receipt);
  h.readText.mockResolvedValue({ file: receipt, text: "# Real disk content" });
  props = {
    path: "result.md",
    workingDirectory: "/work",
    active: true,
    selectionKey: "task-a:1",
    onOpenHtml: vi.fn(),
  };
});

it("opens the exact clicked path through the common inspector and renders verified Markdown", async () => {
  await ready();
  expect(h.inspectLink).toHaveBeenCalledWith("/work", "result.md");
  expect(h.readText).toHaveBeenCalledWith(receipt);
  expect(render().html).toContain("<h1>Real disk content</h1>");
  expect(h.open).not.toHaveBeenCalled();
  expect(props.onOpenHtml).not.toHaveBeenCalled();
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

it("offers manual delivery for a text file above the reader limit", async () => {
  h.inspectLink.mockResolvedValue({ ...receipt, size: 1024 * 1024 + 1 });
  await ready();
  expect(render().html).toContain(S.large);
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
  click(S.save);
  await vi.waitFor(() =>
    expect(h.copy).toHaveBeenCalledWith(receipt, "/out/copy.md"),
  );
  expect(h.save).toHaveBeenCalledWith({
    title: S.saveTitle,
    defaultPath: "result.md",
  });
  expect(render().html).toContain(S.saved);
});

it("never copies after the destination picker returns to a hidden view", async () => {
  await ready();
  const destination = deferred<string | null>();
  h.save.mockReturnValueOnce(destination.promise);
  click(S.save);
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
