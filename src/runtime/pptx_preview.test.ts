import { afterEach, describe, expect, it, vi } from "vitest";
import { readPptxCapture, readPptxPreview } from "./pptx_preview";
import {
  pptxDisplayFixture,
  pptxTestCapture,
  pptxTestFile,
} from "./pptx_display_fixture";
import type { PptxCapture } from "./pptx_types";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
class ControlledWorker extends EventTarget {
  static instances: ControlledWorker[] = [];
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    super();
    ControlledWorker.instances.push(this);
  }
  ready(document: unknown = pptxDisplayFixture()) {
    this.dispatchEvent(
      new MessageEvent("message", { data: { kind: "ready", document } }),
    );
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  invoke.mockReset();
  ControlledWorker.instances = [];
});
describe("PPTX exact capture and disposable Worker boundary", () => {
  it.each([
    "root",
    "path",
    "resolvedPath",
    "name",
    "size",
    "version",
    "sha256",
  ] as const)("rejects changed %s", async (field) => {
    const capture = pptxTestCapture();
    invoke.mockResolvedValue({
      ...capture,
      file: { ...capture.file, [field]: field === "size" ? 5 : "other" },
    });
    await expect(
      readPptxCapture(pptxTestFile, new AbortController().signal),
    ).rejects.toMatchObject({ code: "changed" });
  });
  it.each([
    "changed",
    "invalid",
    "unreadable",
    "encrypted",
    "limit",
    "unsupported",
    "readPending",
    "readBusy",
  ])("keeps fixed %s without private error text", async (code) => {
    invoke.mockRejectedValue({ code, message: "PRIVATE ERROR" });
    await expect(
      readPptxCapture(pptxTestFile, new AbortController().signal),
    ).rejects.toMatchObject({ code, message: code });
  });
  it("cancels a wait without claiming that the underlying read finished", async () => {
    let resolve!: (value: PptxCapture) => void;
    invoke.mockImplementation(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    const control = new AbortController(),
      promise = readPptxCapture(pptxTestFile, control.signal);
    control.abort();
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
    resolve(pptxTestCapture());
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("does no work on pre-abort", async () => {
    vi.stubGlobal("Worker", ControlledWorker);
    const control = new AbortController();
    control.abort();
    await expect(
      readPptxCapture(pptxTestFile, control.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      readPptxPreview(pptxTestCapture(), control.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(invoke).not.toHaveBeenCalled();
    expect(ControlledWorker.instances).toHaveLength(0);
  });
  it("isolates cancellation and late replies from the next worker", async () => {
    vi.stubGlobal("Worker", ControlledWorker);
    const control = new AbortController(),
      first = readPptxPreview(pptxTestCapture(), control.signal);
    const rejected = expect(first).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      readPptxPreview(pptxTestCapture(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "busy" });
    control.abort();
    const second = readPptxPreview(
      pptxTestCapture(),
      new AbortController().signal,
    );
    ControlledWorker.instances[0].ready({ malicious: true });
    ControlledWorker.instances[1].ready();
    await rejected;
    expect((await second).file).toEqual(pptxTestFile);
    expect(
      ControlledWorker.instances.every(
        (worker) => worker.terminate.mock.calls.length === 1,
      ),
    ).toBe(true);
  });
  it("retains source and part snapshots even if the caller mutates capture", async () => {
    vi.stubGlobal("Worker", ControlledWorker);
    const capture = pptxTestCapture(),
      promise = readPptxPreview(capture, new AbortController().signal);
    capture.file.version = "MUTATED";
    capture.parts.push({ name: "other.xml", data: "" });
    const d = pptxDisplayFixture();
    d.slides[0].part = "other.xml";
    ControlledWorker.instances[0].ready(d);
    await expect(promise).rejects.toMatchObject({ code: "invalid" });
    const next = readPptxPreview(
      pptxTestCapture(),
      new AbortController().signal,
    );
    ControlledWorker.instances[1].ready();
    expect((await next).file.version).toBe("one");
  });
  it("timeout, constructor and message errors release exactly their Worker", async () => {
    vi.stubGlobal("Worker", ControlledWorker);
    vi.useFakeTimers();
    const timed = readPptxPreview(
        pptxTestCapture(),
        new AbortController().signal,
      ),
      rejected = expect(timed).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledOnce();
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw Error("private");
        }
      },
    );
    await expect(
      readPptxPreview(pptxTestCapture(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid" });
    vi.stubGlobal("Worker", ControlledWorker);
    const next = readPptxPreview(
      pptxTestCapture(),
      new AbortController().signal,
    );
    ControlledWorker.instances[1].dispatchEvent(new Event("messageerror"));
    await expect(next).rejects.toMatchObject({ code: "invalid" });
    expect(ControlledWorker.instances[1].terminate).toHaveBeenCalledOnce();
  });
});
