import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readWorkbookCapture,
  readWorkbookInput,
  readWorkbookPreview,
} from "./xlsx_preview";
import { parseWorkbookInput } from "./xlsx_input_parse";
import { inputZipFixture } from "./xlsx_input_fixture.test-support";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const capture = inputZipFixture("01-values-scope"),
  request = { mode: "visible-saved-cells" as const };
class ControlledWorker extends EventTarget {
  static instances: ControlledWorker[] = [];
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    super();
    ControlledWorker.instances.push(this);
  }
  reply(
    data = {
      kind: "inputReady",
      workbook: parseWorkbookInput(capture, request),
    },
  ) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  invoke.mockReset();
  ControlledWorker.instances = [];
});
describe("XLSX input read capture, shared Worker lifecycle and immutable scope", () => {
  it("requires original file receipt and normalizes actual backend change/busy without exposing raw errors", async () => {
    invoke.mockResolvedValue({
      ...capture,
      file: { ...capture.file, version: "new" },
    });
    await expect(
      readWorkbookCapture(capture.file, new AbortController().signal),
    ).rejects.toMatchObject({ code: "changed" });
    invoke.mockRejectedValue({
      code: "readBusy",
      detail: "private diagnostic",
    });
    await expect(
      readWorkbookCapture(capture.file, new AbortController().signal),
    ).rejects.toMatchObject({ code: "readBusy", message: "readBusy" });
  });
  it("input and preview share one slot, cancellation kills stale Worker and releases synchronously for explicit replacement scope", async () => {
    vi.stubGlobal("Worker", ControlledWorker);
    const controller = new AbortController(),
      pending = readWorkbookInput(capture, request, controller.signal),
      failed = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    const first = ControlledWorker.instances[0];
    await expect(
      readWorkbookPreview(capture, undefined, new AbortController().signal),
    ).rejects.toMatchObject({ code: "busy" });
    controller.abort();
    const nextRequest = { mode: "all-saved-cells" as const },
      next = readWorkbookInput(
        capture,
        nextRequest,
        new AbortController().signal,
      ),
      second = ControlledWorker.instances[1];
    first.reply();
    second.reply({
      kind: "inputReady",
      workbook: parseWorkbookInput(capture, nextRequest),
    });
    await failed;
    expect((await next).scope.sheetIds).toHaveLength(4);
    expect(first.terminate).toHaveBeenCalledTimes(1);
    expect(second.terminate).toHaveBeenCalledTimes(1);
  });
  it("reply/request range must match; wrong kind/closed shape do not pass a preview as whole input", async () => {
    vi.stubGlobal("Worker", ControlledWorker);
    const pending = readWorkbookInput(
      capture,
      { mode: "all-saved-cells" },
      new AbortController().signal,
    );
    ControlledWorker.instances[0].reply();
    await expect(pending).rejects.toMatchObject({ code: "invalid" });
    const next = readWorkbookInput(
      capture,
      request,
      new AbortController().signal,
    );
    ControlledWorker.instances[1].reply({
      kind: "ready",
      workbook: parseWorkbookInput(capture, request),
    });
    await expect(next).rejects.toMatchObject({ code: "invalid" });
  });
  it("scopeEmpty is known input failure; all other unexpected private Worker errors stay invalid", async () => {
    vi.stubGlobal("Worker", ControlledWorker);
    const first = readWorkbookInput(
      capture,
      request,
      new AbortController().signal,
    );
    ControlledWorker.instances[0].dispatchEvent(
      new MessageEvent("message", {
        data: { kind: "error", code: "scopeEmpty" },
      }),
    );
    await expect(first).rejects.toMatchObject({ code: "scopeEmpty" });
    const next = readWorkbookInput(
      capture,
      request,
      new AbortController().signal,
    );
    ControlledWorker.instances[1].dispatchEvent(
      new MessageEvent("message", {
        data: { kind: "error", code: "private path" },
      }),
    );
    await expect(next).rejects.toMatchObject({
      code: "invalid",
      message: "invalid",
    });
  });
  it("timeout and constructor failure both release the resource; abort before call performs no Worker work", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", ControlledWorker);
    const pending = readWorkbookInput(
        capture,
        request,
        new AbortController().signal,
      ),
      failed = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10000);
    await failed;
    expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("private");
        }
      },
    );
    await expect(
      readWorkbookInput(capture, request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid" });
    const c = new AbortController();
    c.abort();
    vi.stubGlobal("Worker", ControlledWorker);
    await expect(
      readWorkbookInput(capture, request, c.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(ControlledWorker.instances).toHaveLength(1);
    const next = readWorkbookInput(
      capture,
      request,
      new AbortController().signal,
    );
    ControlledWorker.instances[1].reply();
    await next;
  });
});
