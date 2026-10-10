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
vi.mock("./VisualAreaSelection", async () => {
  const { createElement, Fragment } = await import("react");
  return {
    VisualAreaSelection: ({
      display,
      children,
    }: {
      display: unknown;
      children: ReactNode;
    }) =>
      createElement(
        Fragment,
        null,
        display ? createElement("button", null, "选择意见区域") : null,
        children,
      ),
  };
});
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
  sha256: "a".repeat(64),
};
let props: { preview: VisualPreview; active: boolean };
const target = { width: 0, height: 0, parentElement: { clientWidth: 800 } };
const viewport = { clientWidth: 864 };
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
  const root = all.find((x) => x.props.className === "visual-file-preview");
  if (root?.props.ref)
    (root.props.ref as { current: unknown }).current = viewport;
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
  target.parentElement.clientWidth = 800;
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  vi.stubGlobal("getComputedStyle", () => ({
    paddingLeft: "16px",
    paddingRight: "16px",
  }));
  props = {
    active: true,
    preview: {
      file: source,
      mimeType: "application/pdf",
      data: btoa("%PDF-1"),
    },
  };
});

it("only offers a region after successful PDF pixels, never on a page count alone", async () => {
  const draw = deferred<void>();
  h.render.mockReturnValue(draw.promise);
  Object.assign(props, { onVisualTargetConfirm: vi.fn() });
  render();
  expect(render().html).not.toContain("选择意见区域");
  h.render.mock.calls[0][5](3);
  expect(render().html).not.toContain("选择意见区域");
  target.width = 400;
  target.height = 200;
  draw.resolve();
  await drain();
  expect(render().html).toContain("选择意见区域");
});
it("interaction blocking keeps ready pixels and does not repeat rendering", async () => {
  h.render.mockImplementation(
    async (
      _bytes: unknown,
      canvas: typeof target,
      _page: unknown,
      _width: unknown,
      _signal: unknown,
      ready: (pages: number) => void,
    ) => {
      canvas.width = 400;
      canvas.height = 200;
      ready(3);
    },
  );
  Object.assign(props, {
    onVisualTargetConfirm: vi.fn(),
    interactionBlocked: false,
  });
  render();
  await drain();
  render();
  Object.assign(props, { interactionBlocked: true });
  const result = render();
  expect(result.html).toContain('inert=""');
  expect(h.render).toHaveBeenCalledOnce();
  expect(target.width).toBe(400);
  expect(result.html).toContain(S.snapshot);
});

it("an old page control cannot act on a later completed draw of the same file", async () => {
  h.render.mockImplementation(
    async (
      _bytes: unknown,
      canvas: typeof target,
      _page: unknown,
      _width: unknown,
      _signal: unknown,
      ready: (pages: number) => void,
    ) => {
      canvas.width = 400;
      canvas.height = 200;
      ready(5);
    },
  );
  render();
  await drain();
  const firstNext = render().all.find(
    (n) => n.type === "button" && n.props.children === S.next,
  )!.props.onClick as () => void;
  firstNext();
  render();
  await drain();
  click(S.next);
  await drain();
  expect(render().html).toContain("第 3 / 5 页");
  expect(h.render).toHaveBeenCalledTimes(3);
  firstNext();
  render();
  await drain();
  expect(h.render).toHaveBeenCalledTimes(3);
  expect(render().html).toContain("第 3 / 5 页");
});

it("measures the stable preview content width while the hidden canvas stage has no intrinsic width", () => {
  Object.assign(props, { onVisualTargetConfirm: vi.fn() });
  target.parentElement.clientWidth = 0;
  vi.stubGlobal("window", { devicePixelRatio: 3 });
  h.render.mockReturnValue(new Promise(() => {}));
  render();
  // The real region stage is fit-content, and its only canvas is hidden until
  // drawing succeeds. Its width is therefore zero before the first draw.
  expect(h.render.mock.calls[0][3]).toBe((864 - 16 - 16) * 2);
});
