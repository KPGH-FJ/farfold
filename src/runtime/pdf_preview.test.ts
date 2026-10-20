import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PREVIEW_WAIT_MS, VISUAL_PREVIEW_STRINGS as S } from "./visual_preview";
import { renderPdfPage } from "./pdf_preview";
class Bitmap {
  close = vi.fn();
  constructor(
    public width = 600,
    public height = 800,
  ) {}
}
class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor(
    public url: URL,
    public options: WorkerOptions,
  ) {
    super();
    FakeWorker.instances.push(this);
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
const start = (
  signal = new AbortController().signal,
  target = canvas(),
  ready = vi.fn(),
) => renderPdfPage(new Uint8Array([1, 2]), target, 2, 800, signal, ready);
beforeEach(() => {
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("ImageBitmap", Bitmap);
  FakeWorker.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("transfers only a copied byte buffer and displays a validated pixel response", async () => {
  const target = canvas(),
    ready = vi.fn(),
    pending = start(undefined, target, ready);
  const worker = FakeWorker.instances[0];
  expect(worker.postMessage).toHaveBeenCalledWith(
    { data: new Uint8Array([1, 2]), pageNumber: 2, displayWidth: 800 },
    [expect.any(ArrayBuffer)],
  );
  const bitmap = new Bitmap();
  worker.receive({ kind: "ready", pages: 3, bitmap });
  await pending;
  expect(target.width).toBe(600);
  expect(ready).toHaveBeenCalledWith(3);
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it("terminates a nonresponsive rendering worker on timeout without waiting for any library acknowledgement", async () => {
  vi.useFakeTimers();
  const target = canvas();
  target.width = 99;
  const pending = expect(start(undefined, target)).rejects.toThrow(S.timeout);
  await vi.advanceTimersByTimeAsync(PREVIEW_WAIT_MS);
  await pending;
  expect(target.width).toBe(0);
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  const late = new Bitmap();
  FakeWorker.instances[0].receive({ kind: "ready", pages: 3, bitmap: late });
  expect(target.width).toBe(0);
  expect(late.close).toHaveBeenCalledOnce();
});
it("cancels and does not draw a late pixel reply", async () => {
  const abort = new AbortController(),
    target = canvas(),
    ready = vi.fn();
  const pending = expect(start(abort.signal, target, ready)).rejects.toThrow(
    S.cancelled,
  );
  abort.abort();
  await pending;
  const bitmap = new Bitmap();
  FakeWorker.instances[0].receive({ kind: "ready", pages: 3, bitmap });
  expect(target.width).toBe(0);
  expect(ready).not.toHaveBeenCalled();
  expect(bitmap.close).toHaveBeenCalledOnce();
});
it.each([
  "password",
  "incomplete",
  "limit",
  "unsupported",
  "<script>secret</script>",
])("maps worker failure %s to fixed UI text only", async (code) => {
  const pending = expect(start()).rejects.toThrow(
    code === "password"
      ? S.password
      : code === "limit"
        ? S.limit
        : code === "unsupported"
          ? S.unsupported
          : S.failed,
  );
  FakeWorker.instances[0].receive({ kind: "error", code });
  await pending;
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
});
it("rejects oversized pixels, malformed replies and worker failures", async () => {
  for (const reply of [
    { kind: "ready", pages: 2, bitmap: new Bitmap(10000, 10000) },
    { kind: "ready", pages: 2, bitmap: { width: 1, height: 1 } },
    { kind: "ready", pages: 1, bitmap: new Bitmap() },
    { kind: "other" },
  ]) {
    const pending = expect(start()).rejects.toThrow(S.failed);
    FakeWorker.instances.at(-1)!.receive(reply);
    await pending;
  }
  const pending = expect(start()).rejects.toThrow(S.failed);
  FakeWorker.instances.at(-1)!.dispatchEvent(new Event("error"));
  await pending;
});
it("bounds concurrent rendering trees and releases capacity after cancellation", async () => {
  const first = new AbortController(),
    second = new AbortController();
  const a = expect(start(first.signal)).rejects.toThrow(S.cancelled),
    b = expect(start(second.signal)).rejects.toThrow(S.cancelled);
  await expect(start()).rejects.toThrow(S.busy);
  first.abort();
  second.abort();
  await Promise.all([a, b]);
  const next = start();
  FakeWorker.instances
    .at(-1)!
    .receive({ kind: "ready", pages: 2, bitmap: new Bitmap() });
  await next;
});
it.each(["error", "messageerror"])(
  "retires only its own worker on %s and permits a fresh preview before timeout",
  async (event) => {
    vi.useFakeTimers();
    const first = new AbortController(),
      second = new AbortController(),
      replacement = new AbortController();
    const target = canvas(),
      ready = vi.fn();
    target.width = 120;
    target.height = 160;
    let outcome: unknown = "pending";
    const a = start(first.signal, target, ready).catch((error: unknown) => {
      outcome = error;
    });
    const b = start(second.signal).catch(() => {});
    let c: Promise<void> | undefined;
    try {
      const [failed, other] = FakeWorker.instances;
      await expect(start()).rejects.toThrow(S.busy);
      failed.dispatchEvent(new Event(event));
      await Promise.resolve();
      await Promise.resolve();
      expect(outcome).toEqual(new Error(S.failed));
      await a;
      expect([target.width, target.height]).toEqual([0, 0]);
      expect(ready).not.toHaveBeenCalled();
      expect(failed.terminate).toHaveBeenCalledOnce();
      expect(other.terminate).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      failed.dispatchEvent(new Event(event));
      const late = new Bitmap();
      failed.receive({ kind: "ready", pages: 3, bitmap: late });
      expect(late.close).toHaveBeenCalledOnce();
      expect(failed.terminate).toHaveBeenCalledOnce();
      c = start(replacement.signal);
      await expect(start()).rejects.toThrow(S.busy);
      FakeWorker.instances
        .at(-1)!
        .receive({ kind: "ready", pages: 3, bitmap: new Bitmap() });
      await c;
      expect(other.terminate).not.toHaveBeenCalled();
    } finally {
      first.abort();
      second.abort();
      replacement.abort();
      await Promise.all([a, b, c]);
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("gives an explicit unsupported-environment outcome and allocates nothing for cancellation", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(start(abort.signal)).rejects.toThrow(S.cancelled);
  vi.stubGlobal("OffscreenCanvas", undefined);
  await expect(start()).rejects.toThrow(S.unsupported);
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("ImageBitmap", undefined);
  await expect(start()).rejects.toThrow(S.unsupported);
  expect(FakeWorker.instances).toHaveLength(0);
});

it("accepts an explicitly restored clamped page only with the exact page receipt", async () => {
  const target = canvas(),
    ready = vi.fn();
  const pending = renderPdfPage(
    new Uint8Array([1]),
    target,
    9,
    800,
    new AbortController().signal,
    ready,
    true,
  );
  const worker = FakeWorker.instances[0];
  expect(worker.postMessage.mock.calls[0][0]).toMatchObject({
    pageNumber: 9,
    restorePage: true,
  });
  worker.receive({
    kind: "ready",
    pages: 3,
    pageNumber: 3,
    bitmap: new Bitmap(),
  });
  await pending;
  expect(ready).toHaveBeenCalledWith(3, 3);
  for (const actual of [undefined, 1, 2, 4, NaN]) {
    const refused = expect(
      renderPdfPage(
        new Uint8Array([1]),
        canvas(),
        9,
        800,
        new AbortController().signal,
        ready,
        true,
      ),
    ).rejects.toThrow(S.failed);
    FakeWorker.instances.at(-1)!.receive({
      kind: "ready",
      pages: 3,
      pageNumber: actual,
      bitmap: new Bitmap(),
    });
    await refused;
  }
  expect(ready).toHaveBeenCalledOnce();
});
