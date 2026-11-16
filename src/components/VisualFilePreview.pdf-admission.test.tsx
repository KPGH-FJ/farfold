// Actual production PDF component/check/render/slots. Only React scheduling,
// canvas surface and owned Worker replies are controlled. No PDF parse/browser/RSS proof.
import { readFileSync } from "node:fs";
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
}));
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
import {
  VisualFilePreview,
  type DrawnPdfPreview,
  type PdfPreviewCandidate,
} from "./VisualFilePreview";
import { renderPdfPage } from "../runtime/pdf_preview";
import {
  MAX_VISUAL_BYTES,
  VISUAL_PREVIEW_STRINGS as S,
} from "../runtime/visual_preview";
import type { VisualPreview } from "../runtime/file_delivery";
import type { PreviewReadingPositionRef } from "../runtime/preview_reading_position";
const bytes = new Uint8Array(
  readFileSync(
    new URL(
      "../runtime/fixtures/pdf-preview/mixed-two-pages.pdf",
      import.meta.url,
    ),
  ),
);
const encoded = Buffer.from(bytes).toString("base64");
const file = {
  root: "/owned",
  path: "/owned/mixed-two-pages.pdf",
  resolvedPath: "/owned/mixed-two-pages.pdf",
  name: "mixed-two-pages.pdf",
  size: bytes.length,
  sha256: "bound-in-preparation",
  version: "owned-v1",
};
const original: VisualPreview = {
  file,
  mimeType: "application/pdf",
  data: encoded,
};
let preview: VisualPreview;
class Bitmap {
  close = vi.fn();
  constructor(
    public width = 8,
    public height = 8,
  ) {}
}
class OwnedWorker extends EventTarget {
  static instances: OwnedWorker[] = [];
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor(
    public url: URL,
    public options: WorkerOptions,
  ) {
    super();
    OwnedWorker.instances.push(this);
  }
  receive(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }
}
const canvas = () =>
  ({
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage: vi.fn() })),
  }) as unknown as HTMLCanvasElement;
let target: HTMLCanvasElement;
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
  candidateTarget?: HTMLCanvasElement,
) {
  h.cursor = 0;
  const all = nodes(VisualFilePreview({ preview, active: true, ...options }));
  for (const element of all.filter((n) => n.type === "canvas")) {
    const ref = element.props.ref as { current: HTMLCanvasElement | null };
    if (ref === options.pdfCandidate?.surface.canvas)
      ref.current = candidateTarget ?? null;
    else if (ref !== options.drawnPdf?.surface.canvas) ref.current = target;
  }
  for (const effect of h.effects.splice(0)) effect();
  return all;
}
function text(all: E[]) {
  return all
    .flatMap((n) =>
      Children.toArray(n.props.children as ReactNode).filter(
        (x) => typeof x === "string",
      ),
    )
    .join(" ");
}
function cleanup() {
  for (const slot of h.slots) slot.cleanup?.();
  h.slots = [];
  h.cursor = 0;
  h.effects = [];
}
async function tick() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}
const pending: { controller: AbortController; task: Promise<string> }[] = [];
function holdRender() {
  const controller = new AbortController();
  const task = renderPdfPage(
    bytes,
    canvas(),
    1,
    800,
    controller.signal,
    () => {},
  ).then(
    () => "ready",
    (error: Error) => error.message,
  );
  const held = { controller, task };
  pending.push(held);
  return held;
}
async function releaseHeld() {
  for (const p of pending) p.controller.abort();
  const outcomes = await Promise.all(pending.map((p) => p.task));
  pending.length = 0;
  return outcomes;
}
beforeEach(() => {
  cleanup();
  preview = original;
  target = canvas();
  OwnedWorker.instances = [];
  vi.stubGlobal("Worker", OwnedWorker);
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("ImageBitmap", Bitmap);
  vi.stubGlobal("window", { devicePixelRatio: 1 });
});
afterEach(async () => {
  cleanup();
  await releaseHeld();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("two actual pending render trees reject a third component before Base64 expansion", async () => {
  holdRender();
  holdRender();
  const atob = vi.spyOn(globalThis, "atob");
  try {
    expect(OwnedWorker.instances).toHaveLength(2);
    commit();
    await tick();
    const view = commit();
    // These priority/worker/feedback assertions precede the intended RED.
    expect(text(view)).toContain(S.busy);
    expect(OwnedWorker.instances).toHaveLength(2);
    expect(
      OwnedWorker.instances.every((w) => w.postMessage.mock.calls.length === 1),
    ).toBe(true);
    expect(atob).not.toHaveBeenCalled();
  } finally {
    cleanup();
    expect(await releaseHeld()).toEqual([S.cancelled, S.cancelled]);
    expect(
      OwnedWorker.instances.every((w) => w.terminate.mock.calls.length === 1),
    ).toBe(true);
    // Verify the same slot pool admits a new actual render after both originals settle.
    const next = renderPdfPage(
      bytes,
      canvas(),
      1,
      800,
      new AbortController().signal,
      () => {},
    );
    const bitmap = new Bitmap();
    OwnedWorker.instances.at(-1)!.receive({ kind: "ready", pages: 2, bitmap });
    await next;
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(OwnedWorker.instances.at(-1)!.terminate).toHaveBeenCalledOnce();
  }
});
it("cheap oversized metadata keeps limit priority over the full PDF pool without expansion", async () => {
  holdRender();
  holdRender();
  preview = { ...original, file: { ...file, size: MAX_VISUAL_BYTES + 1 } };
  const atob = vi.spyOn(globalThis, "atob");
  try {
    commit();
    await tick();
    const view = commit();
    expect(text(view)).toContain(S.limit);
    expect(atob).not.toHaveBeenCalled();
    expect(OwnedWorker.instances).toHaveLength(2);
  } finally {
    cleanup();
    expect(await releaseHeld()).toEqual([S.cancelled, S.cancelled]);
  }
});
it("idle actual component expands once, transfers the original file bytes and closes its validated bitmap", async () => {
  const atob = vi.spyOn(globalThis, "atob");
  commit();
  expect(OwnedWorker.instances).toHaveLength(1);
  const worker = OwnedWorker.instances[0];
  expect(atob).toHaveBeenCalledOnce();
  expect(worker.postMessage.mock.calls[0][0].data).toEqual(bytes);
  expect(preview.data).toBe(encoded);
  const bitmap = new Bitmap();
  worker.receive({ kind: "ready", pages: 2, pageNumber: 1, bitmap });
  await tick();
  const view = commit();
  expect(text(view)).toContain(S.snapshot);
  expect(view.find((n) => n.type === "canvas")?.props.hidden).toBe(false);
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

function newPdf(name: string): VisualPreview {
  const captured = readFileSync(
    new URL(`../runtime/fixtures/pdf-preview/${name}`, import.meta.url),
  );
  return {
    ...original,
    file: {
      ...file,
      version: "owned-v2",
      sha256: "replacement",
      size: captured.length,
    },
    data: captured.toString("base64"),
  };
}

async function readySecondPage() {
  const readingPosition: PreviewReadingPositionRef = {
    current: {
      kind: "pdf",
      page: 2,
      root: file.root,
      resolvedPath: file.resolvedPath,
    },
  };
  const options = { readingPosition, onReadiness: vi.fn() };
  commit(options);
  const worker = OwnedWorker.instances[0];
  expect(worker.postMessage.mock.calls[0][0]).toMatchObject({
    pageNumber: 2,
    restorePage: true,
  });
  worker.receive({
    kind: "ready",
    pages: 2,
    pageNumber: 2,
    bitmap: new Bitmap(64, 48),
  });
  await tick();
  expect(text(commit(options))).toContain(S.page(2, 2));
  return options;
}

function candidateFor(next: VisualPreview): PdfPreviewCandidate {
  return {
    preview: next,
    page: 2,
    surface: { slot: 1, canvas: { current: null } },
    controller: new AbortController(),
    current: () => true,
    settle: vi.fn(),
  };
}

it.each(["password", "draw error"])(
  "keeps only the old PDF surface visible after the staged %s outcome",
  async (outcome) => {
    const options = await readySecondPage();
    const candidate = candidateFor(
      newPdf(outcome === "password" ? "password.pdf" : "embedded-chinese.pdf"),
    );
    const staged = canvas();
    const pending = commit(
      { ...options, interactionBlocked: true, pdfCandidate: candidate },
      staged,
    );
    expect(
      pending.filter((n) => n.type === "canvas").map((n) => n.props.hidden),
    ).toEqual([false, true]);
    const worker = OwnedWorker.instances[1];
    expect(worker.postMessage.mock.calls[0][0]).toMatchObject({
      pageNumber: 2,
      restorePage: true,
    });
    const bitmap = new Bitmap();
    if (outcome === "password")
      worker.receive({ kind: "error", code: "password" });
    else {
      vi.mocked(staged.getContext).mockImplementationOnce(() => {
        throw new Error("Controlled draw failure");
      });
      worker.receive({ kind: "ready", pages: 1, pageNumber: 1, bitmap });
    }
    await tick();
    expect(candidate.settle).toHaveBeenCalledExactlyOnceWith(
      new Error(outcome === "password" ? S.password : S.failed),
    );
    if (outcome !== "password") expect(bitmap.close).toHaveBeenCalledOnce();
    const finished = commit(options);
    expect(text(finished)).toContain(S.page(2, 2));
    expect(
      finished.filter((n) => n.type === "canvas").map((n) => n.props.hidden),
    ).toEqual([false]);
    expect(target).toMatchObject({ width: 64, height: 48 });
    expect(staged).toMatchObject({ width: 0, height: 0 });
    expect(options.onReadiness).toHaveBeenLastCalledWith({
      source: original,
      location: { kind: "pdf", page: 2, pageCount: 2 },
    });
    expect(OwnedWorker.instances).toHaveLength(2);
    expect(worker.terminate).toHaveBeenCalledOnce();
  },
);

it("promotes the already-drawn clamped PDF surface and disposes only the old canvas", async () => {
  const options = await readySecondPage();
  const next = newPdf("embedded-chinese.pdf");
  const candidate = candidateFor(next);
  const staged = canvas();
  const pending = commit(
    { ...options, interactionBlocked: true, pdfCandidate: candidate },
    staged,
  );
  const stagedNode = pending.find((n) => n.type === "canvas" && n.props.hidden);
  const worker = OwnedWorker.instances[1];
  const bitmap = new Bitmap(40, 30);
  worker.receive({ kind: "ready", pages: 1, pageNumber: 1, bitmap });
  await tick();
  const page = vi.mocked(candidate.settle).mock.calls[0][0];
  expect(page).toEqual({
    element: staged,
    page: 1,
    pageCount: 1,
  });
  if (page instanceof Error) throw page;
  const drawn: DrawnPdfPreview = {
    ...page,
    preview: next,
    surface: candidate.surface,
  };
  expect(target).toMatchObject({ width: 64, height: 48 });
  const replacement = { ...options, preview: next, drawnPdf: drawn };
  commit(replacement);
  await tick();
  const shown = commit(replacement);
  expect(text(shown)).toContain(S.page(1, 1));
  expect(shown.filter((n) => n.type === "canvas")).toHaveLength(1);
  const displayed = shown.find((n) => n.type === "canvas");
  expect(displayed?.props.hidden).toBe(false);
  expect(displayed?.key).toBe(stagedNode?.key);
  expect(displayed?.props.ref).toBe(stagedNode?.props.ref);
  expect(target).toMatchObject({ width: 0, height: 0 });
  expect(staged).toMatchObject({ width: 40, height: 30 });
  expect(options.onReadiness).toHaveBeenLastCalledWith({
    source: next,
    location: { kind: "pdf", page: 1, pageCount: 1 },
  });
  expect(OwnedWorker.instances).toHaveLength(2);
  expect(staged.getContext).toHaveBeenCalledOnce();
  expect(bitmap.close).toHaveBeenCalledOnce();
  // A remounted DOM node cannot inherit the first node's draw receipt.
  cleanup();
  const remounted = canvas();
  drawn.surface.canvas.current = remounted;
  commit(replacement);
  expect(OwnedWorker.instances).toHaveLength(3);
  expect(remounted).toMatchObject({ width: 0, height: 0 });
});

it("ends the staged PDF draw when hidden and closes a late bitmap", async () => {
  const options = await readySecondPage();
  const candidate = candidateFor(newPdf("embedded-chinese.pdf"));
  const staged = canvas();
  commit({ ...options, pdfCandidate: candidate }, staged);
  const worker = OwnedWorker.instances[1];
  commit({ ...options, active: false });
  await tick();
  const bitmap = new Bitmap();
  worker.receive({ kind: "ready", pages: 1, pageNumber: 1, bitmap });
  expect(candidate.settle).toHaveBeenCalledExactlyOnceWith(
    new Error(S.cancelled),
  );
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(staged).toMatchObject({ width: 0, height: 0 });
  expect(options.onReadiness).toHaveBeenLastCalledWith({
    source: original,
    location: null,
  });
});

it("releases the drawn PDF surface when its promotion and hide share a commit", async () => {
  const options = await readySecondPage();
  const next = newPdf("embedded-chinese.pdf");
  const candidate = candidateFor(next);
  const staged = canvas();
  commit({ ...options, pdfCandidate: candidate }, staged);
  const bitmap = new Bitmap(40, 30);
  OwnedWorker.instances[1].receive({
    kind: "ready",
    pages: 1,
    pageNumber: 1,
    bitmap,
  });
  await tick();
  const page = vi.mocked(candidate.settle).mock.calls[0][0];
  if (page instanceof Error) throw page;
  expect(staged).toMatchObject({ width: 40, height: 30 });
  const drawnPdf: DrawnPdfPreview = {
    ...page,
    preview: next,
    surface: candidate.surface,
  };

  commit({ ...options, preview: next, drawnPdf, active: false });
  expect(staged).toMatchObject({ width: 0, height: 0 });
  expect(target).toMatchObject({ width: 0, height: 0 });
  expect(options.onReadiness).toHaveBeenLastCalledWith({
    source: next,
    location: null,
  });
  expect(OwnedWorker.instances).toHaveLength(2);
  expect(bitmap.close).toHaveBeenCalledOnce();
  commit({ ...options, preview: next, drawnPdf, active: true });
  expect(OwnedWorker.instances).toHaveLength(3);
});
