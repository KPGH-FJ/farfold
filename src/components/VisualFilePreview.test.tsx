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
  render: vi.fn(),
  decode: vi.fn(),
}));
vi.mock("../runtime/pdf_preview", () => ({ renderPdfPage: h.render }));
vi.mock("../runtime/draft_images", () => ({ validateDraftImage: h.decode }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
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
  useLayoutEffect: (callback: () => void | (() => void), deps: unknown[]) => {
    const index = h.cursor++,
      slot = h.slots[index];
    if (!slot || deps.some((v, i) => !Object.is(v, slot.deps?.[i])))
      h.effects.push(() => {
        slot?.cleanup?.();
        h.slots[index].cleanup = callback() || undefined;
      });
    h.slots[index] = { deps, cleanup: slot?.cleanup };
  },
}));
import { VisualFilePreview } from "./VisualFilePreview";
import { VISUAL_PREVIEW_STRINGS as S } from "../runtime/visual_preview";
import type { VisualPreview } from "../runtime/file_delivery";
const source = {
  root: "/work",
  path: "/work/a.pdf",
  resolvedPath: "/work/a.pdf",
  name: "a.pdf",
  size: 6,
  version: "v1",
  sha256: "hash1",
};
let props: { preview: VisualPreview; active: boolean };
const target = { width: 0, height: 0, parentElement: { clientWidth: 800 } };
type Element = ReactElement<Record<string, unknown>>;
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child)) {
      result.push(child);
      result.push(...nodes(child.props.children as ReactNode));
    }
  });
  return result;
}
function render() {
  h.cursor = 0;
  const tree = VisualFilePreview(props),
    all = nodes(tree);
  const node = all.find((x) => x.type === "canvas");
  if (node) (node.props.ref as { current: unknown }).current = target;
  for (const effect of h.effects.splice(0)) effect();
  return { html: renderToStaticMarkup(tree), all };
}
function click(label: string) {
  const button = render().all.find(
    (n) => n.type === "button" && n.props.children === label,
  );
  expect(button).toBeDefined();
  (button!.props.onClick as () => void)();
  render();
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  h.slots = [];
  h.cursor = 0;
  h.effects = [];
  h.render.mockReset();
  h.decode.mockReset();
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  props = {
    active: true,
    preview: {
      file: source,
      mimeType: "application/pdf",
      data: btoa("%PDF-1"),
    },
  };
});
it("shows one requested page and clears the previous canvas before starting the next", async () => {
  const first = deferred<void>(),
    next = deferred<void>();
  h.render.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
  render();
  expect(h.render).toHaveBeenCalledOnce();
  (h.render.mock.calls[0][5] as (pages: number) => void)(3);
  first.resolve();
  await drain();
  expect(render().html).toContain("第 1 / 3 页");
  target.width = 500;
  click(S.next);
  expect(target.width).toBe(0);
  expect(h.render.mock.calls[0][4].aborted).toBe(true);
  expect(h.render.mock.calls[1][2]).toBe(2);
  expect(render().html).toContain("hidden");
  h.render.mock.calls[1][5](3);
  next.resolve();
  await drain();
  expect(render().html).toContain("第 2 / 3 页");
});
it("cancelled and hidden previews ignore late completion", async () => {
  const first = deferred<void>();
  h.render.mockReturnValue(first.promise);
  render();
  click(S.cancel);
  expect(h.render.mock.calls[0][4].aborted).toBe(true);
  first.resolve();
  await drain();
  expect(render().html).toContain(S.cancelled);
  expect(render().html).toContain("hidden");
  props.active = false;
  render();
  expect(render().html).toContain(S.paused);
});
it("does not display an image whose decode finishes after leaving this preview", async () => {
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DA0PAfAAgAAn+cRUBOAAAAAElFTkSuQmCC";
  props.preview = {
    file: { ...source, name: "a.png", size: atob(data).length },
    mimeType: "image/png",
    data,
  };
  const decode = deferred<{ data: string; mimeType: string }>();
  h.decode.mockReturnValue(decode.promise);
  render();
  expect(h.decode).toHaveBeenCalledOnce();
  props.active = false;
  render();
  decode.resolve({ data, mimeType: "image/png" });
  await drain();
  expect(render().html).not.toContain("<img");
});
it("does not start decoding invalid bytes and never displays a raw parser error", async () => {
  props.preview = { ...props.preview, data: btoa("script") };
  render();
  await drain();
  expect(h.render).not.toHaveBeenCalled();
  expect(render().html).toContain(S.failed);
});
it("shows only a fixed password outcome, never library details", async () => {
  h.render.mockRejectedValue(new Error(S.password));
  render();
  await drain();
  expect(render().html).toContain(S.password);
});

it("reports a PDF page only after that operation drew successfully, then withdraws it before page navigation", async () => {
  const report = vi.fn();
  Object.assign(props, { onReadiness: report });
  const first = deferred<void>(),
    next = deferred<void>();
  h.render.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
  render();
  expect(report).toHaveBeenLastCalledWith({
    source: props.preview,
    location: null,
  });
  h.render.mock.calls[0][5](4);
  expect(
    report.mock.calls.some(([value]) => value.location?.kind === "pdf"),
  ).toBe(false);
  first.resolve();
  await drain();
  render();
  expect(report).toHaveBeenLastCalledWith({
    source: props.preview,
    location: { kind: "pdf", page: 1, pageCount: 4 },
  });
  click(S.next);
  expect(report).toHaveBeenLastCalledWith({
    source: props.preview,
    location: null,
  });
  h.render.mock.calls[0][5](99); // Late callback from the completed prior operation.
  h.render.mock.calls[1][5](4);
  next.resolve();
  await drain();
  render();
  expect(report).toHaveBeenLastCalledWith({
    source: props.preview,
    location: { kind: "pdf", page: 2, pageCount: 4 },
  });
  props.active = false;
  render();
  expect(report).toHaveBeenLastCalledWith({
    source: props.preview,
    location: null,
  });
});
it("withdraws cancelled or failed page eligibility and ignores their late success", async () => {
  const report = vi.fn();
  Object.assign(props, { onReadiness: report });
  const pending = deferred<void>();
  h.render.mockReturnValue(pending.promise);
  render();
  click(S.cancel);
  h.render.mock.calls[0][5](3);
  pending.resolve();
  await drain();
  render();
  expect(report).toHaveBeenLastCalledWith({
    source: props.preview,
    location: null,
  });
  expect(report.mock.calls.every(([value]) => value.location === null)).toBe(
    true,
  );
});

it("withdraws failed and unmounted PDF operations and rejects a success without valid page count", async () => {
  const report = vi.fn();
  Object.assign(props, { onReadiness: report });
  h.render.mockResolvedValue(undefined);
  render();
  await drain();
  expect(render().html).toContain(S.failed);
  expect(report.mock.calls.every(([value]) => value.location === null)).toBe(
    true,
  );
  const waiting = deferred<void>();
  h.render.mockReturnValue(waiting.promise);
  props.preview = { ...props.preview };
  render();
  for (const slot of h.slots) slot.cleanup?.();
  h.render.mock.calls[1][5](2);
  waiting.resolve();
  await drain();
  expect(report.mock.calls.every(([value]) => value.location === null)).toBe(
    true,
  );
});
it("reports image feedback only on actual image load and revokes it on image error", async () => {
  const report = vi.fn();
  Object.assign(props, { onReadiness: report });
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DA0PAfAAgAAn+cRUBOAAAAAElFTkSuQmCC";
  props.preview = {
    file: { ...source, name: "a.png", size: atob(data).length },
    mimeType: "image/png",
    data,
  };
  h.decode.mockResolvedValue({ data, mimeType: "image/png" });
  render();
  await drain();
  const image = render().all.find((node) => node.type === "img")!;
  expect(image).toBeDefined();
  expect(report.mock.calls.every(([value]) => value.location === null)).toBe(
    true,
  );
  (image.props.onLoad as () => void)();
  expect(report).toHaveBeenLastCalledWith({
    source: props.preview,
    location: { kind: "image" },
  });
  (image.props.onError as () => void)();
  expect(report).toHaveBeenLastCalledWith({
    source: props.preview,
    location: null,
  });
  (image.props.onLoad as () => void)(); // A later browser event cannot revive this image.
  expect(report).toHaveBeenLastCalledWith({
    source: props.preview,
    location: null,
  });
  expect(render().html).toContain(S.failed);
});
it("ignores an old image load when the same file is refreshed to a new read-result object", async () => {
  const report = vi.fn();
  Object.assign(props, { onReadiness: report });
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DA0PAfAAgAAn+cRUBOAAAAAElFTkSuQmCC";
  props.preview = {
    file: { ...source, name: "a.png", size: atob(data).length },
    mimeType: "image/png",
    data,
  };
  h.decode.mockResolvedValue({ data, mimeType: "image/png" });
  render();
  await drain();
  const oldImage = render().all.find((node) => node.type === "img")!;
  props.preview = { ...props.preview };
  render();
  (oldImage.props.onLoad as () => void)();
  expect(report.mock.calls.every(([value]) => value.location === null)).toBe(
    true,
  );
});

it("restores the last verified same-path PDF page after a revision remount without publishing stale readiness", async () => {
  const readingPosition = {
    current: {
      root: source.root,
      resolvedPath: source.resolvedPath,
      kind: "pdf",
      page: 3,
    },
  };
  const report = vi.fn();
  Object.assign(props, { readingPosition, onReadiness: report });
  const pending = deferred<void>();
  h.render.mockReturnValue(pending.promise);
  render();
  expect(h.render.mock.calls[0][2]).toBe(3);
  expect(report).toHaveBeenLastCalledWith({
    source: props.preview,
    location: null,
  });
  h.render.mock.calls[0][5](2, 2);
  expect(report.mock.calls.some(([v]) => v.location !== null)).toBe(false);
  pending.resolve();
  await drain();
  expect(render().html).toContain("第 2 / 2 页");
  expect(readingPosition.current).toEqual({
    root: source.root,
    resolvedPath: source.resolvedPath,
    kind: "pdf",
    page: 2,
  });
  expect(report).toHaveBeenLastCalledWith({
    source: props.preview,
    location: { kind: "pdf", page: 2, pageCount: 2 },
  });
});

it("does not let a failed or superseded revision overwrite the last successfully drawn reading position", async () => {
  const readingPosition = {
    current: {
      root: source.root,
      resolvedPath: source.resolvedPath,
      kind: "pdf",
      page: 3,
    },
  };
  const report = vi.fn();
  Object.assign(props, { readingPosition, onReadiness: report });
  const old = deferred<void>(),
    next = deferred<void>();
  h.render.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  render();
  const previous = props.preview;
  props.preview = {
    ...previous,
    file: { ...source, version: "v2", sha256: "h2" },
  };
  render();
  h.render.mock.calls[0][5](9, 3);
  old.resolve();
  await drain();
  expect(readingPosition.current.page).toBe(3);
  expect(report.mock.calls.filter(([v]) => v.location !== null)).toHaveLength(
    0,
  );
  click(S.cancel);
  h.render.mock.calls[1][5](2, 2);
  next.resolve();
  await drain();
  render();
  expect(readingPosition.current.page).toBe(3);
  expect(report.mock.calls.filter(([v]) => v.location !== null)).toHaveLength(
    0,
  );
});
