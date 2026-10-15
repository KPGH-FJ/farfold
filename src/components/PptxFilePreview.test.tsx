import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  pptxDisplayFixture,
  pptxTestCapture,
  pptxTestFile,
} from "../runtime/pptx_display_fixture";
import { PptxError } from "../runtime/pptx_types";
import { PPTX_STRINGS as S } from "../runtime/pptx_strings";
const h = vi.hoisted(() => ({
  owner: "",
  cursor: 0,
  slots: new Map<
    string,
    {
      value?: unknown;
      deps?: unknown[];
      cleanup?: () => void;
      setup?: () => void | (() => void);
    }[]
  >(),
  effects: [] as (() => void)[],
  capture: vi.fn(),
  parse: vi.fn(),
}));
vi.mock("react", async (original) => {
  const api = await original<typeof import("react")>();
  const slot = () => {
    let all = h.slots.get(h.owner);
    if (!all) h.slots.set(h.owner, (all = []));
    const index = h.cursor++;
    return { all, index, old: all[index] };
  };
  const effect = (setup: () => void | (() => void), deps?: unknown[]) => {
    const { all, index, old } = slot();
    if (!old || !deps || deps.some((x, i) => !Object.is(x, old.deps?.[i]))) {
      const next = (all[index] = { deps, setup, cleanup: old?.cleanup });
      h.effects.push(() => {
        old?.cleanup?.();
        next.cleanup = setup() || undefined;
      });
    }
  };
  return {
    ...api,
    useState: (initial: unknown) => {
      const { all, index, old } = slot();
      const state =
        old ??
        (all[index] = {
          value: typeof initial === "function" ? initial() : initial,
        });
      return [
        state.value,
        (v: unknown) => {
          state.value = typeof v === "function" ? v(state.value) : v;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const { all, index, old } = slot();
      return (old ?? (all[index] = { value: { current: initial } })).value;
    },
    useLayoutEffect: effect,
  };
});
vi.mock("../runtime/pptx_preview", () => ({
  readPptxCapture: h.capture,
  readPptxPreview: h.parse,
}));
import { PptxFilePreview } from "./PptxFilePreview";
type Element = ReactElement<Record<string, unknown>>;
let props: Parameters<typeof PptxFilePreview>[0];
const status = vi.fn(),
  createUrl = vi.fn(),
  revokeUrl = vi.fn();
function render() {
  const visited = new Set<string>(),
    all: Element[] = [];
  const resolve = (node: ReactNode, path: string): ReactNode => {
    if (!isValidElement<Record<string, unknown>>(node)) return node;
    const key = `${path}:${node.key ?? ""}`;
    if (typeof node.type === "function") {
      const owner = `${key}:${node.type.name}`;
      visited.add(owner);
      h.owner = owner;
      h.cursor = 0;
      return resolve(
        (node.type as (p: unknown) => ReactNode)(node.props),
        owner,
      );
    }
    if (node.props.className === "pptx-viewport")
      (node.props.ref as { current: unknown }).current = { clientWidth: 480 };
    const children = Children.toArray(node.props.children as ReactNode).map(
      (child, i) => resolve(child, `${key}/${i}`),
    );
    const result = createElement(node.type, node.props, ...children);
    all.push(result as Element);
    return result;
  };
  const tree = resolve(createElement(PptxFilePreview, props), "root");
  for (const [owner, slots] of h.slots)
    if (!visited.has(owner)) {
      slots.forEach((slot) => slot.cleanup?.());
      h.slots.delete(owner);
    }
  for (const effect of h.effects.splice(0)) effect();
  return { all, html: renderToStaticMarkup(tree) };
}
const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function click(label: string) {
  const button = render().all.find(
    (node) => node.type === "button" && node.props.children === label,
  );
  expect(button).toBeDefined();
  (button!.props.onClick as () => void)();
  render();
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
}
beforeEach(() => {
  h.slots.forEach((slots) => slots.forEach((slot) => slot.cleanup?.()));
  h.slots.clear();
  h.effects = [];
  h.capture.mockReset();
  h.parse.mockReset();
  status.mockReset();
  createUrl.mockReset();
  revokeUrl.mockReset();
  createUrl.mockImplementation(
    () => `blob:controlled-${createUrl.mock.calls.length}`,
  );
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createUrl;
      static revokeObjectURL = revokeUrl;
    },
  );
  props = {
    file: { ...pptxTestFile },
    active: true,
    onStatus: status,
    readingPosition: { current: null },
  };
  h.capture.mockImplementation(async () => ({
    ...pptxTestCapture(),
    file: props.file,
  }));
  h.parse.mockImplementation(async () => ({
    ...pptxDisplayFixture(),
    file: props.file,
  }));
});
afterEach(() => {
  h.slots.forEach((slots) => slots.forEach((slot) => slot.cleanup?.()));
  h.slots.clear();
  vi.unstubAllGlobals();
});

it("paints one slide in order, keeps literal text inert and retains page across hide/show", async () => {
  render();
  await drain();
  const first = render();
  expect(first.html).toContain(
    "&lt;script&gt;literal &amp; 中文🙂&lt;/script&gt;",
  );
  expect(first.html).not.toContain("<script>");
  expect(first.html).not.toContain("foreignObject");
  expect(first.html).toContain('fill="#123456"');
  expect(first.html).not.toContain("第二页文字");
  render();
  expect(render().html).toContain("scale(0.5)");
  const oldNext = first.all.find(
    (n) => n.type === "button" && n.props.children === S.next,
  )!;
  click(S.next);
  expect(render().html).toContain("第二页文字");
  expect(render().html).not.toContain("literal");
  (oldNext.props.onClick as () => void)();
  expect(render().html).toContain(S.page(2, 2));
  props = { ...props, active: false };
  render();
  props = { ...props, active: true };
  render();
  await drain();
  expect(render().html).toContain(S.page(2, 2));
  expect(h.capture).toHaveBeenCalledOnce();
});
it("StrictMode effect replay starts one actual capture", async () => {
  render();
  for (const slots of h.slots.values())
    for (const slot of slots)
      if (slot.setup) {
        slot.cleanup?.();
        slot.cleanup = slot.setup() || undefined;
      }
  await drain();
  render();
  expect(h.capture).toHaveBeenCalledOnce();
  expect(h.parse).toHaveBeenCalledOnce();
});
it("cancel/retry keeps awaiting the same native read instead of claiming cancellation", async () => {
  const pending = deferred<ReturnType<typeof pptxTestCapture>>();
  h.capture.mockReturnValue(pending.promise);
  render();
  await drain();
  click(S.cancel);
  expect(status.mock.calls.at(-1)?.[0]).toMatchObject({
    state: "paused",
    readInFlight: true,
  });
  expect(h.capture.mock.calls[0][1].aborted).toBe(false);
  click(S.retry);
  await drain();
  expect(h.capture).toHaveBeenCalledOnce();
  pending.resolve({ ...pptxTestCapture(), file: props.file });
  await drain();
  expect(render().html).toContain(S.page(1, 2));
  expect(h.parse).toHaveBeenCalledOnce();
});
it("a hidden readPending receipt remains failed and is never automatically retried", async () => {
  const pending = deferred<ReturnType<typeof pptxTestCapture>>();
  h.capture.mockReturnValue(pending.promise);
  render();
  await drain();
  props = { ...props, active: false };
  render();
  pending.reject(new PptxError("readPending"));
  await drain();
  expect(status.mock.calls.at(-1)?.[0]).toMatchObject({
    state: "failed",
    code: "readPending",
    readInFlight: false,
  });
  props = { ...props, active: true };
  render();
  await drain();
  render();
  expect(h.capture).toHaveBeenCalledOnce();
  expect(h.parse).not.toHaveBeenCalled();
});
it("retired file and parser replies cannot populate another source", async () => {
  const pending = deferred<
    { file: typeof pptxTestFile } & ReturnType<typeof pptxDisplayFixture>
  >();
  h.parse.mockReturnValueOnce(pending.promise);
  render();
  await drain();
  const parserSignal = h.parse.mock.calls[0][1] as AbortSignal;
  const oldFile = props.file;
  props = {
    ...props,
    file: { ...props.file, version: "two", sha256: "b".repeat(64) },
  };
  render();
  await drain();
  expect(parserSignal.aborted).toBe(true);
  pending.resolve({ ...pptxDisplayFixture(), file: oldFile });
  await drain();
  expect(status.mock.calls.at(-1)?.[0].file.version).toBe("two");
  expect(h.capture).toHaveBeenCalledTimes(2);
});
it("uses prepared snapshots without new reads and blocks retired page controls", async () => {
  const value = { ...pptxDisplayFixture(), file: props.file };
  props = { ...props, prepared: { kind: "pptx", file: props.file, value } };
  render();
  await drain();
  const first = render();
  const next = first.all.find(
    (n) => n.type === "button" && n.props.children === S.next,
  )!;
  props = { ...props, interactionBlocked: true };
  render();
  (next.props.onClick as () => void)();
  expect(render().html).toContain(S.page(1, 2));
  expect(h.capture).not.toHaveBeenCalled();
  expect(h.parse).not.toHaveBeenCalled();
});
it("releases only its own local bitmap URLs and reports actual image failure", async () => {
  h.parse.mockImplementation(async () => ({
    ...pptxDisplayFixture(true),
    file: props.file,
  }));
  render();
  await drain();
  render();
  const first = render();
  const image = first.all.find((n) => n.type === "img")!;
  expect(image.props.src).toBe("blob:controlled-1");
  expect(createUrl.mock.calls[0][0]).toBeInstanceOf(Blob);
  props = { ...props, interactionBlocked: true };
  render();
  (image.props.onError as () => void)();
  expect(render().html).toContain(S.imageFailed);
  expect(status.mock.calls.at(-1)?.[0]).toMatchObject({
    state: "failed",
    code: "invalid",
  });
  expect(revokeUrl).toHaveBeenCalledWith("blob:controlled-1");
});
it("never revives retired image or page handlers after page A/B/A", async () => {
  h.parse.mockImplementation(async () => ({
    ...pptxDisplayFixture(true),
    file: props.file,
  }));
  render();
  await drain();
  render();
  const first = render(),
    oldImage = first.all.find((node) => node.type === "img")!,
    oldNext = first.all.find(
      (node) => node.type === "button" && node.props.children === S.next,
    )!;
  click(S.next);
  click(S.previous);
  render();
  expect(render().all.find((node) => node.type === "img")?.props.src).toBe(
    "blob:controlled-2",
  );
  (oldImage.props.onError as () => void)();
  (oldNext.props.onClick as () => void)();
  expect(render().html).toContain(S.page(1, 2));
  expect(render().html).not.toContain(S.imageFailed);
  expect(status.mock.calls.at(-1)?.[0]).toMatchObject({ state: "ready" });
});
