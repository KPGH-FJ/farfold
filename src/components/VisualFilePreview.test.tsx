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
