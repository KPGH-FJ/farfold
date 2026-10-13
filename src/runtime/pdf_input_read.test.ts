import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { readPdfInput } from "./pdf_input_read";
import { renderPdfPage } from "./pdf_preview";
import { PDF_INPUT_LIMITS } from "./pdf_input_types";
import { VISUAL_PREVIEW_STRINGS } from "./visual_preview";
import {
  pdfCapture,
  pdfFixture,
  pdfRequest,
  pdfResult,
} from "./pdf_input_fixture.test-support";
class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  static created: ((worker: FakeWorker) => void) | undefined;
  static wait() {
    return new Promise<FakeWorker>((resolve) => {
      FakeWorker.created = resolve;
    });
  }
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor(
    public url: URL,
    public options: WorkerOptions,
  ) {
    super();
    FakeWorker.instances.push(this);
    FakeWorker.created?.(this);
    FakeWorker.created = undefined;
  }
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
beforeEach(() => {
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("crypto", webcrypto);
  FakeWorker.instances = [];
  FakeWorker.created = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const begin = async (signal = new AbortController().signal) => {
  const created = FakeWorker.wait();
  const pending = readPdfInput(
    pdfCapture(await pdfFixture()),
    pdfRequest,
    signal,
  );
  return { pending, worker: await created };
};

it("hands a verified whole buffer to its dedicated worker and accepts only a complete checked result", async () => {
  const { pending, worker } = await begin();
  const data = worker.postMessage.mock.calls[0][0];
  expect(data.request).toEqual(pdfRequest);
  expect(data.data).toEqual(await pdfFixture());
  expect(worker.postMessage.mock.calls[0][1]).toEqual([data.data.buffer]);
  const result = pdfResult("literal", 3);
  worker.receive({ kind: "inputReady", result });
  expect(await pending).toEqual(result);
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it("rejects worker death, malformed replies, extra data and late prefixes instead of reviewing them", async () => {
  for (const mode of [
    "error",
    "messageerror",
    "prefix",
    "extra",
    "unknownCode",
  ] as const) {
    const { pending, worker } = await begin();
    const checked = expect(pending).rejects.toBeDefined();
    if (mode === "error" || mode === "messageerror")
      worker.dispatchEvent(new Event(mode));
    else if (mode === "prefix")
      worker.receive({
        kind: "inputReady",
        result: { ...pdfResult("x", 2), pages: pdfResult().pages },
      });
    else if (mode === "extra")
      worker.receive({
        kind: "inputReady",
        result: pdfResult(),
        complete: true,
      });
    else worker.receive({ kind: "error", code: "private document text" });
    await checked;
    worker.receive({ kind: "inputReady", result: pdfResult() });
    expect(worker.terminate).toHaveBeenCalledOnce();
  }
});
it("uses one deadline and ends its tree before freeing the slot, ignoring late output", async () => {
  const { pending, worker } = await begin();
  vi.useFakeTimers();
  // This job already started under real timers. A second fresh job is checked
  // separately so timers are never reset by progress or by pages.
  worker.receive({ kind: "inputReady", result: pdfResult() });
  await pending;
  const fresh = await begin();
  const rejected = expect(fresh.pending).rejects.toMatchObject({
    code: "timeout",
  });
  await vi.advanceTimersByTimeAsync(PDF_INPUT_LIMITS.wait);
  await rejected;
  fresh.worker.receive({ kind: "inputReady", result: pdfResult() });
  expect(fresh.worker.terminate).toHaveBeenCalledOnce();
});
it("cancels immediately during parsing and never accepts a late result", async () => {
  const abort = new AbortController();
  const { pending, worker } = await begin(abort.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  abort.abort();
  await rejected;
  worker.receive({ kind: "inputReady", result: pdfResult() });
  expect(worker.terminate).toHaveBeenCalledOnce();
  const next = await begin();
  next.worker.receive({ kind: "inputReady", result: pdfResult() });
  await next.pending;
});
it("does not allocate a tree after cancellation while hashing, unsupported Worker or scope omission", async () => {
  const capture = pdfCapture(await pdfFixture()),
    abort = new AbortController();
  let finish!: (bytes: ArrayBuffer) => void;
  vi.spyOn(webcrypto.subtle, "digest").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = expect(
    readPdfInput(capture, pdfRequest, abort.signal),
  ).rejects.toMatchObject({ code: "cancelled" });
  abort.abort();
  await pending;
  finish(new Uint8Array(32).buffer);
  await Promise.resolve();
  await Promise.resolve();
  expect(FakeWorker.instances).toHaveLength(0);
  await expect(
    readPdfInput(capture, {} as never, new AbortController().signal),
  ).rejects.toMatchObject({ code: "scopeRequired" });
  vi.stubGlobal("Worker", undefined);
  await expect(
    readPdfInput(capture, pdfRequest, new AbortController().signal),
  ).rejects.toMatchObject({ code: "unsupported" });
});
it("shares capacity with real preview entry points and permits only one input tree", async () => {
  const Bitmap = class {
    width = 10;
    height = 10;
    close = vi.fn();
  };
  vi.stubGlobal("ImageBitmap", Bitmap);
  vi.stubGlobal("OffscreenCanvas", class {});
  const target = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
  } as unknown as HTMLCanvasElement;
  const previewAbort = new AbortController(),
    inputAbort = new AbortController();
  const preview = expect(
    renderPdfPage(
      new Uint8Array([1]),
      target,
      1,
      100,
      previewAbort.signal,
      () => {},
    ),
  ).rejects.toThrow(VISUAL_PREVIEW_STRINGS.cancelled);
  const input = await begin(inputAbort.signal);
  const cancelled = expect(input.pending).rejects.toMatchObject({
    code: "cancelled",
  });
  await expect(
    readPdfInput(
      pdfCapture(await pdfFixture()),
      pdfRequest,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "busy" });
  await expect(
    renderPdfPage(
      new Uint8Array([1]),
      target,
      1,
      100,
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow(VISUAL_PREVIEW_STRINGS.busy);
  previewAbort.abort();
  await preview;
  await expect(
    readPdfInput(
      pdfCapture(await pdfFixture()),
      pdfRequest,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "busy" });
  inputAbort.abort();
  await cancelled;
  const next = await begin();
  next.worker.receive({ kind: "inputReady", result: pdfResult() });
  await next.pending;
});
it("releases leases when Worker construction fails or full-content verification rejects", async () => {
  const capture = pdfCapture(await pdfFixture());
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error("private startup failure");
      }
    },
  );
  await expect(
    readPdfInput(capture, pdfRequest, new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid" });
  vi.stubGlobal("Worker", FakeWorker);
  await expect(
    readPdfInput(
      { ...capture, data: capture.data.slice(4) },
      pdfRequest,
      new AbortController().signal,
    ),
  ).rejects.toBeDefined();
  const next = await begin();
  next.worker.receive({ kind: "inputReady", result: pdfResult() });
  await next.pending;
});
