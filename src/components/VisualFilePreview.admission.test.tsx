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
import type {
  ImagePreviewCandidate,
  LoadedImagePreview,
} from "./visual_file_replacement";
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
function commit(
  options: Partial<Parameters<typeof VisualFilePreview>[0]> = {},
  candidateElement?: HTMLImageElement,
) {
  h.cursor = 0;
  const all = nodes(VisualFilePreview({ preview, active: true, ...options }));
  for (const node of all.filter((n) => n.type === "img")) {
    const ref = node.props.ref as { current: HTMLImageElement | null };
    if (ref === options.imageCandidate?.surface.image)
      ref.current = candidateElement ?? null;
  }
  for (const fn of h.effects.splice(0)) fn();
  return all;
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
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = async () => {
  for (let i = 0; i < 14; i++) await Promise.resolve();
};

class MountedImage extends EventTarget {
  private source: string | null = null;
  writes = vi.fn();
  complete = false;
  naturalWidth = 0;
  naturalHeight = 0;
  request = pending();
  decode = vi.fn(() => this.request.promise);
  set src(url: string) {
    this.source = url;
    this.writes(url);
  }
  getAttribute() {
    return this.source;
  }
  removeAttribute() {
    this.source = null;
  }
  load() {
    this.complete = true;
    this.naturalWidth = 2;
    this.naturalHeight = 1;
    this.dispatchEvent(new Event("load"));
  }
}

async function oldImage() {
  const onReadiness = vi.fn();
  commit({ onReadiness });
  await tick();
  const displayed = commit({ onReadiness }).find(
    (node) => node.type === "img",
  )!;
  (displayed.props.onLoad as () => void)();
  expect(onReadiness).toHaveBeenLastCalledWith({
    source: original,
    location: { kind: "image" },
  });
  return onReadiness;
}

function replacement(data = original.data): ImagePreviewCandidate {
  return {
    preview: {
      ...original,
      data,
      file: {
        ...file,
        size: Buffer.from(data, "base64").length,
        version: "image-v2",
        sha256: "image-v2-sha",
      },
    },
    surface: { slot: 1, image: { current: null } },
    controller: new AbortController(),
    current: () => true,
    settle: vi.fn(),
  };
}

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

it("waits for the mounted candidate load after decode and promotes that node without a second source or decode", async () => {
  const onReadiness = await oldImage();
  const candidate = replacement();
  const mounted = new MountedImage();
  const target = mounted as unknown as HTMLImageElement;
  const options = {
    imageCandidate: candidate,
    interactionBlocked: true,
    onReadiness,
  };
  const staged = commit(options, target).filter((n) => n.type === "img");
  expect(staged.map((n) => n.props.hidden)).toEqual([false, true]);
  expect(staged[0].props.src).toBe(`data:image/png;base64,${data}`);
  expect(staged[1].props.src).toBeUndefined();
  await tick();
  expect(mounted.decode).toHaveBeenCalledOnce();
  mounted.request.resolve();
  await tick();
  expect(candidate.settle).not.toHaveBeenCalled();
  expect(
    commit(options, target)
      .filter((n) => n.type === "img")
      .map((n) => n.props.hidden),
  ).toEqual([false, true]);
  mounted.load();
  await tick();
  const result = vi.mocked(candidate.settle).mock.calls[0][0];
  expect(result).toEqual({
    element: target,
    url: `data:image/png;base64,${data}`,
  });
  if (result instanceof Error) throw result;
  const loadedImage: LoadedImagePreview = {
    ...result,
    preview: candidate.preview,
    surface: candidate.surface,
  };
  const next = { preview: candidate.preview, loadedImage, onReadiness };
  commit(next);
  await tick();
  const shown = commit(next).filter((n) => n.type === "img");
  expect(shown).toHaveLength(1);
  expect(shown[0].key).toBe(staged[1].key);
  expect(shown[0].props.ref).toBe(staged[1].props.ref);
  expect(shown[0].props.hidden).toBe(false);
  expect(shown[0].props.src).toBeUndefined();
  expect(mounted.getAttribute()).toBe(result.url);
  expect(mounted.writes).toHaveBeenCalledExactlyOnceWith(result.url);
  expect(mounted.decode).toHaveBeenCalledOnce();
  expect(created).toBe(1); // The first ordinary preview's preflight only.
  expect(onReadiness).toHaveBeenLastCalledWith({
    source: candidate.preview,
    location: { kind: "image" },
  });
});

it.each(["decode", "mounted load"])(
  "retains the old visible PNG if the candidate %s fails",
  async (failure) => {
    const onReadiness = await oldImage();
    const invalid =
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAB0lEQVR4nAcAAAAATlVPQAAAAABJRU5ErkJggg==";
    expect(
      raster.inspectImageBytes(Buffer.from(invalid, "base64")),
    ).toMatchObject({ mimeType: "image/png", width: 2, height: 1 });
    const candidate = replacement(failure === "decode" ? invalid : data);
    const mounted = new MountedImage();
    commit(
      { imageCandidate: candidate, interactionBlocked: true, onReadiness },
      mounted as unknown as HTMLImageElement,
    );
    await tick();
    expect(mounted.decode).toHaveBeenCalledOnce();
    if (failure === "decode")
      mounted.request.reject(new Error("Invalid deflate"));
    else {
      mounted.request.resolve();
      mounted.dispatchEvent(new Event("error"));
    }
    await tick();
    expect(candidate.settle).toHaveBeenCalledExactlyOnceWith(
      new Error(S.failed),
    );
    expect(mounted.getAttribute()).toBeNull();
    const shown = commit({ onReadiness }).filter((n) => n.type === "img");
    expect(shown).toHaveLength(1);
    expect(shown[0].props.src).toBe(`data:image/png;base64,${data}`);
    expect(shown[0].props.hidden).toBe(false);
    mounted.load();
    await tick();
    expect(candidate.settle).toHaveBeenCalledOnce();
    expect(onReadiness).toHaveBeenLastCalledWith({
      source: original,
      location: { kind: "image" },
    });
  },
);

it.each([false, true])(
  "cleans the candidate source when hidden %s with completed load",
  async (loaded) => {
    const onReadiness = await oldImage();
    const candidate = replacement();
    const mounted = new MountedImage();
    commit(
      { imageCandidate: candidate, onReadiness },
      mounted as unknown as HTMLImageElement,
    );
    await tick();
    if (loaded) {
      mounted.request.resolve();
      mounted.load();
      await tick();
      const result = vi.mocked(candidate.settle).mock.calls[0][0];
      if (result instanceof Error) throw result;
      commit({
        preview: candidate.preview,
        loadedImage: {
          ...result,
          preview: candidate.preview,
          surface: candidate.surface,
        },
        active: false,
        onReadiness,
      });
    } else {
      commit({ active: false, onReadiness });
      mounted.request.resolve();
      mounted.load();
    }
    await tick();
    expect(candidate.controller.signal.aborted).toBe(true);
    expect(mounted.getAttribute()).toBeNull();
    expect(
      onReadiness.mock.calls.filter(
        ([ready]) => ready.source === candidate.preview && ready.location,
      ),
    ).toHaveLength(0);
    expect(mounted.decode).toHaveBeenCalledOnce();
    expect(created).toBe(1);
  },
);
