import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkbookCapture, readWorkbookPreview } from "./xlsx_preview";
import { parseWorkbook } from "./xlsx_parse";
import { workbookFixture } from "./xlsx_fixture";
import type { WorkbookCapture } from "./xlsx_types";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const file = {
  root: "/fixture",
  path: "/fixture/a.xlsx",
  resolvedPath: "/fixture/a.xlsx",
  name: "a.xlsx",
  sha256: "fixture",
  size: 20,
  version: "version-a",
};
const input = workbookFixture("<row><c><v>1</v></c></row>");
const capture: WorkbookCapture = { file, ...input, inflatedBytes: 10000 };
class ControlledWorker extends EventTarget {
  static instances: ControlledWorker[] = [];
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    super();
    ControlledWorker.instances.push(this);
  }
  ready() {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: { kind: "ready", workbook: parseWorkbook(input) },
      }),
    );
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  invoke.mockReset();
  ControlledWorker.instances = [];
});
describe("XLSX captured version and worker ownership", () => {
  it("only accepts the exact requested VerifiedFile receipt", async () => {
    invoke.mockResolvedValue({
      ...capture,
      file: { ...file, sha256: "other" },
    });
    await expect(
      readWorkbookCapture(file, new AbortController().signal),
    ).rejects.toMatchObject({ code: "changed" });
    invoke.mockResolvedValue(capture);
    await expect(
      readWorkbookCapture(file, new AbortController().signal),
    ).resolves.toBe(capture);
  });
  it.each([
    "changed",
    "unreadable",
    "encrypted",
    "invalid",
    "limit",
    "unsupported",
    "readPending",
    "readBusy",
  ])(
    "normalizes the structured backend %s code without exposing raw errors",
    async (code) => {
      invoke.mockRejectedValue({ code, message: "private-untrusted-error" });
      await expect(
        readWorkbookCapture(file, new AbortController().signal),
      ).rejects.toMatchObject({ code, message: code });
    },
  );
  it("normalizes an unexpected capture error to unreadable", async () => {
    invoke.mockRejectedValue("untrusted private path");
    await expect(
      readWorkbookCapture(file, new AbortController().signal),
    ).rejects.toMatchObject({ code: "unreadable", message: "unreadable" });
  });
  it("abandons capture wait on abort without claiming to abort the OS read", async () => {
    let finish: (v: WorkbookCapture) => void = () => {};
    invoke.mockImplementation(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const controller = new AbortController(),
      pending = readWorkbookCapture(file, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    finish(capture);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("terminates after success and allows the next preview", async () => {
    vi.stubGlobal("Worker", ControlledWorker);
    const first = readWorkbookPreview(
        capture,
        undefined,
        new AbortController().signal,
      ),
      worker = ControlledWorker.instances[0];
    worker.ready();
    expect((await first).sheet?.cells[0].display).toBe("1");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    const second = readWorkbookPreview(
      capture,
      "sheet1",
      new AbortController().signal,
    );
    ControlledWorker.instances[1].ready();
    await second;
  });
  it("limits concurrent parse, cancels and ignores late results", async () => {
    vi.stubGlobal("Worker", ControlledWorker);
    const controller = new AbortController();
    const pending = readWorkbookPreview(capture, undefined, controller.signal);
    await expect(
      readWorkbookPreview(capture, undefined, new AbortController().signal),
    ).rejects.toMatchObject({ code: "busy" });
    const first = ControlledWorker.instances[0];
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    const next = readWorkbookPreview(
      capture,
      undefined,
      new AbortController().signal,
    );
    first.ready();
    ControlledWorker.instances[1].ready();
    await next;
    expect(first.terminate).toHaveBeenCalledTimes(1);
  });
  it("releases cancellation synchronously before an immediate replacement read", async () => {
    vi.stubGlobal("Worker", ControlledWorker);
    const controller = new AbortController();
    const pending = readWorkbookPreview(capture, undefined, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({
      code: "cancelled",
    });
    controller.abort();
    const next = readWorkbookPreview(
      capture,
      "sheet1",
      new AbortController().signal,
    );
    const result = next.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    ControlledWorker.instances.at(-1)!.ready();
    await cancelled;
    expect(await result).toHaveProperty("value.sheet.id", "sheet1");
    expect(ControlledWorker.instances).toHaveLength(2);
    expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });
  it("enforces a deadline and releases the slot even if constructor fails", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", ControlledWorker);
    const pending = readWorkbookPreview(
      capture,
      undefined,
      new AbortController().signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(ControlledWorker.instances[0].terminate).toHaveBeenCalled();
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw Error("fixture");
        }
      },
    );
    await expect(
      readWorkbookPreview(capture, undefined, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid" });
    vi.stubGlobal("Worker", ControlledWorker);
    const next = readWorkbookPreview(
      capture,
      undefined,
      new AbortController().signal,
    );
    ControlledWorker.instances[1].ready();
    await next;
  });
  it("rejects a reply belonging to a different selected sheet", async () => {
    vi.stubGlobal("Worker", ControlledWorker);
    const pending = readWorkbookPreview(
      capture,
      "different",
      new AbortController().signal,
    );
    ControlledWorker.instances[0].ready();
    await expect(pending).rejects.toMatchObject({ code: "invalid" });
  });
});
