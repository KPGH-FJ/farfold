import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DocxPreview } from "../runtime/docx_types";

const h = vi.hoisted(() => ({
  owner: "",
  cursor: 0,
  slots: new Map<
    string,
    { value?: unknown; deps?: unknown[]; cleanup?: () => void }[]
  >(),
  effects: [] as (() => void)[],
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
      const next = (all[index] = { deps, cleanup: old?.cleanup });
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
    useMemo: (read: () => unknown, deps: unknown[]) => {
      const { all, index, old } = slot();
      if (!old || deps.some((x, i) => !Object.is(x, old.deps?.[i])))
        all[index] = { value: read(), deps };
      return all[index].value;
    },
    useLayoutEffect: effect,
    useEffect: effect,
  };
});
import { DocxDocumentView } from "./DocxDocumentView";
import { DOCUMENT_STRINGS as S } from "../runtime/document_strings";

// This reuses the persistent keyed hook/effect resolver from the existing
// DocxReadingWindows tests. Real production components and DocumentImages run;
// only React scheduling/DOM and URL registry observation are controlled seams.
// This is neither browser image decoding nor a physical memory measurement.
type Element = ReactElement<Record<string, unknown>>;
function render(node: ReactNode) {
  const visited = new Set<string>(),
    all: Element[] = [];
  const resolve = (node: ReactNode, path: string): ReactNode => {
    if (Array.isArray(node))
      return node.map((child, i) => resolve(child, `${path}/array-${i}`));
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
    const children = Children.toArray(node.props.children as ReactNode).map(
      (child, i) => resolve(child, `${key}/${i}`),
    );
    const result = createElement(node.type, node.props, ...children);
    all.push(result as Element);
    return result;
  };
  const result = resolve(node, "root");
  for (const [owner, slots] of h.slots)
    if (!visited.has(owner)) {
      slots.forEach((s) => s.cleanup?.());
      h.slots.delete(owner);
    }
  for (const fn of h.effects.splice(0)) fn();
  return { all, html: renderToStaticMarkup(result) };
}
const file = {
  root: "/controlled",
  path: "/controlled/sample.docx",
  resolvedPath: "/controlled/sample.docx",
  name: "sample.docx",
  size: 4,
  version: "one",
  sha256: "a".repeat(64),
};
function documentWithImages(consumers = 1): DocxPreview {
  return {
    file,
    warnings: [],
    partial: false,
    stories: [],
    images: [
      {
        id: "shared",
        mimeType: "image/png",
        bytes: new Uint8Array([1, 2, 3, 4]),
        width: 1,
        height: 1,
      },
    ],
    blocks: [
      {
        kind: "paragraph",
        id: "image-paragraph",
        source: { part: "word/document.xml", elementPath: [0, 0] },
        style: {},
        runs: Array.from({ length: consumers }, (_, i) => ({
          kind: "image" as const,
          imageId: "shared",
          widthPt: 1,
          heightPt: 1,
          alt: `consumer-${i}`,
        })),
      },
    ],
  };
}
let document: DocxPreview;
let sequence = 0;
let live: Set<string>, created: string[], revoked: string[];
const view = () => render(createElement(DocxDocumentView, { document }));
const images = (value: ReturnType<typeof view>) =>
  value.all.filter((n) => n.type === "img");
function ready() {
  view();
  return view();
}
function fail(node: Element) {
  // A controlled late event is intentionally allowed to call the original
  // callback after its keyed component has unmounted, matching queued callbacks.
  let source = node.props.src;
  const remove = vi.fn(() => {
    source = null;
  });
  (node.props.onError as (e: unknown) => void)({
    currentTarget: {
      isConnected: true,
      getAttribute: (name: string) => (name === "src" ? source : null),
      removeAttribute: remove,
    },
  });
  return { remove, source: () => source };
}
function cleanup() {
  for (const slots of h.slots.values()) for (const s of slots) s.cleanup?.();
  h.slots.clear();
  h.effects = [];
}
beforeEach(() => {
  h.slots.clear();
  h.effects = [];
  h.cursor = 0;
  document = documentWithImages();
  live = new Set();
  created = [];
  revoked = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    expect(blob).toBeInstanceOf(Blob);
    const value = `blob:controlled-docx-${++sequence}`;
    created.push(value);
    live.add(value);
    return value;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((value) => {
    revoked.push(value);
    expect(live.delete(value)).toBe(true);
  });
});
afterEach(() => {
  try {
    cleanup();
    expect(live.size).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
});

it("a visible image owns one URL and ordinary unmount releases exactly once", () => {
  const original = JSON.stringify(document);
  const n = images(ready());
  expect(n).toHaveLength(1);
  expect(n[0].props.src).toBe(created[0]);
  expect(live.size).toBe(1);
  render(null);
  render(null);
  expect(revoked).toEqual(created);
  expect(live.size).toBe(0);
  expect(JSON.stringify(document)).toBe(original);
});
it("error removes the failed image and releases its now-undisplayed consumer URL", () => {
  const original = JSON.stringify(document);
  const n = images(ready())[0];
  const retired = fail(n);
  expect(retired.remove).toHaveBeenCalledExactlyOnceWith("src");
  expect(retired.source()).toBeNull();
  const failed = view();
  expect(images(failed)).toHaveLength(0);
  expect(failed.html).toContain(S.imageFailed);
  view();
  expect(created).toHaveLength(1);
  expect(JSON.stringify(document)).toBe(original);
  expect(revoked).toEqual(created);
  expect(live.size).toBe(0);
});
it("shared URL survives the first failed consumer and is released after the last one fails", () => {
  document = documentWithImages(2);
  const n = images(ready());
  expect(n).toHaveLength(2);
  expect(created).toHaveLength(1);
  expect(n[0].props.src).toBe(n[1].props.src);
  fail(n[0]);
  fail(n[0]);
  const firstFailed = view();
  expect(images(firstFailed)).toHaveLength(1);
  expect(revoked).toHaveLength(0);
  expect(live.size).toBe(1);
  fail(images(firstFailed)[0]);
  expect(images(view())).toHaveLength(0);
  expect(revoked).toEqual(created);
  expect(live.size).toBe(0);
});
it("source replacement retires the old owner and an old error cannot affect the new one", () => {
  const old = images(ready())[0],
    oldUrl = old.props.src;
  document = documentWithImages();
  const next = images(ready())[0],
    nextUrl = next.props.src;
  expect(nextUrl).not.toBe(oldUrl);
  expect(revoked).toEqual([oldUrl]);
  fail(old);
  expect(images(view()).map((n) => n.props.src)).toEqual([nextUrl]);
  expect(live.has(nextUrl as string)).toBe(true);
  expect(revoked).toEqual([oldUrl]);
  render(null);
  fail(old);
  expect(live.size).toBe(0);
  expect(created).toEqual(revoked);
});

it.each([
  { connected: false, source: "current" },
  { connected: true, source: "another" },
])("ignores an error from a non-current node %#", ({ connected, source }) => {
  const n = images(ready())[0];
  const remove = vi.fn();
  (n.props.onError as (event: unknown) => void)({
    currentTarget: {
      isConnected: connected,
      getAttribute: () => (source === "current" ? n.props.src : "blob:other"),
      removeAttribute: remove,
    },
  });
  expect(images(view()).map((node) => node.props.src)).toEqual([n.props.src]);
  expect(remove).not.toHaveBeenCalled();
  expect(revoked).toHaveLength(0);
  expect(live.size).toBe(1);
});
