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
import { VisualFilePreview } from "./VisualFilePreview";
import { renderPdfPage } from "../runtime/pdf_preview";
import {
  MAX_VISUAL_BYTES,
  VISUAL_PREVIEW_STRINGS as S,
} from "../runtime/visual_preview";
import type { VisualPreview } from "../runtime/file_delivery";
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
function commit() {
  h.cursor = 0;
  const all = nodes(VisualFilePreview({ preview, active: true }));
  const element = all.find((n) => n.type === "canvas");
  if (element) (element.props.ref as { current: unknown }).current = target;
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
