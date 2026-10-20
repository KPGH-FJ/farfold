// Real production validator and component; controlled React layout hooks and Image promises only.
// No DOM/browser decoder, App, Agent, IPC or resource/RSS acceptance claim.
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  cursor: 0,
  effects: [] as (() => void)[],
  pdf: vi.fn(() => {
    throw new Error("PDF must not execute");
  }),
}));
vi.mock("../runtime/pdf_preview", () => ({ renderPdfPage: h.pdf }));
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
import * as draft from "../runtime/draft_images";
import * as raster from "../runtime/image_bytes";
import {
  checkedVisualPreview,
  VISUAL_PREVIEW_STRINGS as S,
} from "../runtime/visual_preview";
const data =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DA0PAfAAgAAn+cRUBOAAAAAElFTkSuQmCC";
const file = {
  root: "/owned",
  path: "/owned/tiny.png",
  resolvedPath: "/owned/tiny.png",
  name: "tiny.png",
  size: Buffer.from(data, "base64").length,
  sha256: "owned-sha",
  version: "owned-v1",
};
const original = { file, mimeType: "image/png", data };
let preview: typeof original = original;
type E = ReactElement<Record<string, unknown>>;
function nodes(tree: ReactNode): E[] {
  const all: E[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child)) {
      all.push(child);
      all.push(...nodes(child.props.children as ReactNode));
    }
  });
  return all;
}
function commit() {
  h.cursor = 0;
  const tree = VisualFilePreview({ preview, active: true });
  for (const fn of h.effects.splice(0)) fn();
  return nodes(tree);
}
function text(elements: E[]): string {
  return elements
    .flatMap((n) =>
      Children.toArray(n.props.children as ReactNode).filter(
        (x) => typeof x === "string",
      ),
    )
    .join(" ");
}
function cleanup() {
  for (const s of h.slots) s.cleanup?.();
  h.slots = [];
  h.cursor = 0;
  h.effects = [];
}
function pending() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

let queue: Promise<void>[] = [],
  created = 0,
  decodeCalls = 0;
beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  preview = original;
  queue = [];
  created = 0;
  decodeCalls = 0;
  h.pdf.mockClear();
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      naturalWidth = 2;
      naturalHeight = 1;
      constructor() {
        created++;
      }
      decode() {
        decodeCalls++;
        return queue.shift() ?? Promise.resolve();
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("full common decode pool refuses a third ordinary file before any atob or raster inspection", async () => {
  const a = pending(),
    b = pending();
  queue = [a.promise, b.promise];
  const held = [
    draft.validateDraftImage(data, "image/png"),
    draft.validateDraftImage(data, "image/png"),
  ];
  try {
    await tick();
    expect(decodeCalls).toBe(2);
    expect(created).toBe(2);
    const atobSpy = vi.spyOn(globalThis, "atob");
    const inspectSpy = vi.spyOn(raster, "inspectImageBytes");
    const validateSpy = vi.spyOn(draft, "validateDraftImage");
    commit();
    await tick();
    const view = commit();
    expect(validateSpy).toHaveBeenCalledOnce();
    const outcome = await (
      validateSpy.mock.results[0].value as Promise<unknown>
    ).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    expect(created).toBe(2);
    expect(decodeCalls).toBe(2);
    expect(h.pdf).not.toHaveBeenCalled();
    expect(outcome).toBe(draft.IMAGE_INPUT_STRINGS.decodeBusy);
    expect(text(view)).toContain(S.busy);
    expect(view.filter((n) => n.type === "img")).toHaveLength(0);
    expect(atobSpy).not.toHaveBeenCalled();
    expect(inspectSpy).not.toHaveBeenCalled();
  } finally {
    cleanup();
    a.resolve();
    b.resolve();
    const settled = await Promise.allSettled(held);
    await tick();
    expect(settled.map((x) => x.status)).toEqual(["fulfilled", "fulfilled"]);
  }
});
it("idle ordinary file retains exact binding and PNG rejection, then validates and displays the bounded image", async () => {
  const atobSpy = vi.spyOn(globalThis, "atob");
  expect(() =>
    checkedVisualPreview({ ...file, version: "other" }, preview),
  ).toThrow(S.changed);
  expect(atobSpy).not.toHaveBeenCalled();
  const invalid = Buffer.from(data, "base64");
  invalid[invalid.length - 1] ^= 1;
  expect(() =>
    checkedVisualPreview(file, {
      ...preview,
      data: invalid.toString("base64"),
    }),
  ).toThrow(S.failed);
  expect(created).toBe(0);
  atobSpy.mockClear();
  const inspection = vi.spyOn(raster, "inspectImageBytes");
  commit();
  await tick();
  const view = commit();
  const images = view.filter((n) => n.type === "img");
  expect(atobSpy).toHaveBeenCalledOnce();
  expect(inspection).toHaveBeenCalledOnce();
  expect(images).toHaveLength(1);
  expect(images[0].props.src).toBe(`data:image/png;base64,${data}`);
  expect(created).toBe(1);
  expect(decodeCalls).toBe(1);
  expect(h.pdf).not.toHaveBeenCalled();
});

it("refuses actual byte count mismatch before raster inspection or native decode", async () => {
  preview = { ...original, file: { ...file, size: file.size + 1 } };
  const atobSpy = vi.spyOn(globalThis, "atob");
  const inspectSpy = vi.spyOn(raster, "inspectImageBytes");
  commit();
  await tick();
  const view = commit();
  expect(text(view)).toContain(S.failed);
  expect(atobSpy).toHaveBeenCalledOnce();
  expect(inspectSpy).not.toHaveBeenCalled();
  expect(created).toBe(0);
  expect(decodeCalls).toBe(0);
  expect(view.filter((n) => n.type === "img")).toHaveLength(0);
});

it.each([undefined, "", "image/gif"])(
  "does not infer away a missing or mismatched file MIME %s",
  async (mimeType) => {
    preview = { ...original, mimeType: mimeType as string };
    commit();
    await tick();
    const view = commit();
    expect(text(view)).toContain(S.failed);
    expect(created).toBe(0);
    expect(decodeCalls).toBe(0);
    expect(view.filter((n) => n.type === "img")).toHaveLength(0);
  },
);

it.each(["not base64!", data.slice(0, -4) + "AAAA"])(
  "does not display malformed or corrupt file bytes",
  async (changed) => {
    preview = { ...original, data: changed };
    commit();
    await tick();
    const view = commit();
    expect(text(view)).toContain(S.failed);
    expect(created).toBe(0);
    expect(decodeCalls).toBe(0);
    expect(view.filter((n) => n.type === "img")).toHaveLength(0);
  },
);

it("late successful image decode cannot publish after this actual preview becomes hidden", async () => {
  const ready = pending();
  queue = [ready.promise];
  h.cursor = 0;
  VisualFilePreview({ preview, active: true });
  for (const fn of h.effects.splice(0)) fn();
  await tick();
  expect(decodeCalls).toBe(1);
  h.cursor = 0;
  VisualFilePreview({ preview, active: false });
  for (const fn of h.effects.splice(0)) fn();
  try {
    ready.resolve();
    await tick();
    h.cursor = 0;
    const view = nodes(VisualFilePreview({ preview, active: false }));
    for (const fn of h.effects.splice(0)) fn();
    expect(view.filter((n) => n.type === "img")).toHaveLength(0);
    expect(text(view)).toContain(S.paused);
  } finally {
    ready.resolve();
    await tick();
  }
});
