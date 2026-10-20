import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderPdfPage } from "./pdf_preview";
import { VISUAL_PREVIEW_STRINGS as S } from "./visual_preview";

// The real render/slot ownership runs; only worker delivery and canvas are controlled.
class WorkerPeer extends EventTarget {
  static created: WorkerPeer[] = [];
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    super();
    WorkerPeer.created.push(this);
  }
}
const canvas = () => ({ width: 9, height: 12 }) as HTMLCanvasElement;
const pending: { controller: AbortController; task: Promise<string> }[] = [];
function hold() {
  const controller = new AbortController();
  const task = renderPdfPage(
    new Uint8Array([1, 2]),
    canvas(),
    1,
    800,
    controller.signal,
    () => {},
  ).then(
    () => "ready",
    (error: Error) => error.message,
  );
  pending.push({ controller, task });
}
beforeEach(() => {
  WorkerPeer.created = [];
  vi.stubGlobal("Worker", WorkerPeer);
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("ImageBitmap", class {});
});
afterEach(async () => {
  for (const owner of pending) owner.controller.abort();
  await Promise.all(pending.map((owner) => owner.task));
  pending.length = 0;
  expect(
    WorkerPeer.created.every((peer) => peer.terminate.mock.calls.length === 1),
  ).toBe(true);
  vi.unstubAllGlobals();
});

it("full shared render capacity never invokes a deferred byte producer", async () => {
  hold();
  hold();
  const prepare = vi.fn(() => new Uint8Array([3]));
  await expect(
    renderPdfPage(
      prepare,
      canvas(),
      1,
      800,
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow(S.busy);
  expect(prepare).not.toHaveBeenCalled();
  expect(WorkerPeer.created).toHaveLength(2);
  expect(
    WorkerPeer.created.every(
      (peer) => peer.postMessage.mock.calls.length === 1,
    ),
  ).toBe(true);
});

it.each(["throw", "abort"])(
  "a deferred producer that %s releases only its own slot before starting a worker",
  async (outcome) => {
    const controller = new AbortController();
    const target = canvas();
    const prepare = vi.fn(() => {
      if (outcome === "throw") throw new Error(S.changed);
      controller.abort();
      return new Uint8Array([3]);
    });
    await expect(
      renderPdfPage(prepare, target, 1, 800, controller.signal, () => {}),
    ).rejects.toThrow(outcome === "throw" ? S.changed : S.cancelled);
    expect(prepare).toHaveBeenCalledOnce();
    expect(WorkerPeer.created).toHaveLength(0);
    expect([target.width, target.height]).toEqual([0, 0]);

    // Both original slots must remain usable, with no over-release of capacity.
    hold();
    hold();
    expect(WorkerPeer.created).toHaveLength(2);
    await expect(
      renderPdfPage(
        new Uint8Array([4]),
        canvas(),
        1,
        800,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow(S.busy);
    expect(WorkerPeer.created).toHaveLength(2);
  },
);
