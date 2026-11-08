import { afterEach, expect, it, vi } from "vitest";
import { readWorkbookPreview, readWorkbookInput } from "./xlsx_preview";
import { parseWorkbook } from "./xlsx_parse";
import { firstSheetFailureFixture } from "./xlsx_directory.test-support";
import type { WorkbookCapture, WorkbookDirectory } from "./xlsx_types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const input = firstSheetFailureFixture();
const capture: WorkbookCapture = {
  ...input,
  file: {
    root: "/authored",
    path: "/authored/two.xlsx",
    resolvedPath: "/authored/two.xlsx",
    name: "two.xlsx",
    sha256: "authored-package",
    size: 2000,
    version: "one",
  },
  inflatedBytes: 10000,
};
const directory: WorkbookDirectory = {
  sheets: [
    { id: "sheet1", name: "样本", state: "visible" },
    { id: "sheet2", name: "Good second sheet", state: "visible" },
  ],
  selectedId: "sheet1",
};
class ControlledWorker extends EventTarget {
  static instances: ControlledWorker[] = [];
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    super();
    ControlledWorker.instances.push(this);
  }
  reply(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  directory(value: unknown = directory) {
    this.reply({ kind: "directory", directory: value });
  }
  ready() {
    this.reply({
      kind: "ready",
      workbook: parseWorkbook({ ...input, sheetId: "sheet2" }),
    });
  }
}
class ParserWorker extends ControlledWorker {
  override postMessage = vi.fn((payload) => {
    try {
      const workbook = parseWorkbook(payload, (value) => this.directory(value));
      this.reply({ kind: "ready", workbook });
    } catch {
      this.reply({ kind: "error", code: "invalid" });
    }
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  ControlledWorker.instances = [];
});
const read = (
  onDirectory = vi.fn(),
  signal = new AbortController().signal,
  sheetId?: string,
) => readWorkbookPreview(capture, sheetId, signal, onDirectory);

it("passes the actual parser directory through the public port, then fails without fake preview success", async () => {
  vi.stubGlobal("Worker", ParserWorker);
  const receive = vi.fn();
  await expect(read(receive)).rejects.toMatchObject({ code: "invalid" });
  expect(receive).toHaveBeenCalledExactlyOnceWith(directory);
  const recovered = await read(receive, new AbortController().signal, "sheet2");
  expect(recovered.sheet?.cells[0].value).toBe(42);
  expect(ControlledWorker.instances).toHaveLength(2);
  expect(
    ControlledWorker.instances.every(
      (w) => w.terminate.mock.calls.length === 1,
    ),
  ).toBe(true);
});

it.each([
  null,
  { ...directory, selectedId: "absent" },
  { ...directory, selectedId: "sheet2" },
  { ...directory, extra: true },
  { ...directory, sheets: [] },
  { ...directory, sheets: [directory.sheets[0], directory.sheets[0]] },
  { ...directory, sheets: [{ ...directory.sheets[0], state: "future" }] },
  { ...directory, sheets: [{ ...directory.sheets[0], name: "x".repeat(129) }] },
  { ...directory, sheets: [{ ...directory.sheets[0], extra: true }] },
])(
  "rejects malformed or mismatched directory without calling UI: %j",
  async (value) => {
    vi.stubGlobal("Worker", ControlledWorker);
    const receive = vi.fn();
    const pending = read(receive);
    ControlledWorker.instances[0].directory(value);
    await expect(pending).rejects.toMatchObject({ code: "invalid" });
    expect(receive).not.toHaveBeenCalled();
    expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledOnce();
  },
);

it("rejects duplicate directory and releases its slot for an explicit next read", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const receive = vi.fn();
  const pending = read(receive);
  ControlledWorker.instances[0].directory();
  ControlledWorker.instances[0].directory();
  await expect(pending).rejects.toMatchObject({ code: "invalid" });
  expect(receive).toHaveBeenCalledOnce();
  const next = read(vi.fn(), new AbortController().signal, "sheet2");
  ControlledWorker.instances[1].directory({
    ...directory,
    selectedId: "sheet2",
  });
  ControlledWorker.instances[1].ready();
  await expect(next).resolves.toHaveProperty("sheet.id", "sheet2");
});

it.each([
  { kind: "directory", directory, extra: true },
  { kind: "directory", workbook: directory },
  { kind: "future", directory },
])("rejects an unexpected or dirty intermediate packet: %j", async (packet) => {
  vi.stubGlobal("Worker", ControlledWorker);
  const receive = vi.fn();
  const pending = read(receive);
  ControlledWorker.instances[0].reply(packet);
  await expect(pending).rejects.toMatchObject({ code: "invalid" });
  expect(receive).not.toHaveBeenCalled();
  expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledOnce();
});

it("a callback cancellation ends that exact read and releases its slot synchronously", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const control = new AbortController();
  const pending = read(
    vi.fn(() => control.abort()),
    control.signal,
  );
  ControlledWorker.instances[0].directory();
  const next = read(vi.fn(), new AbortController().signal, "sheet2");
  ControlledWorker.instances[1].ready();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  await expect(next).resolves.toHaveProperty("sheet.id", "sheet2");
});

it("rejects a final preview whose directory differs from its intermediate packet", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const pending = read(vi.fn(), new AbortController().signal, "sheet2");
  ControlledWorker.instances[0].directory({
    ...directory,
    selectedId: "sheet2",
    sheets: [directory.sheets[1]],
  });
  ControlledWorker.instances[0].ready();
  await expect(pending).rejects.toMatchObject({ code: "invalid" });
});

it("cancellation after directory keeps the original cancelled result and ignores late packets", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const receive = vi.fn();
  const control = new AbortController();
  const pending = read(receive, control.signal);
  const first = ControlledWorker.instances[0];
  first.directory();
  control.abort();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  const next = read(vi.fn(), new AbortController().signal, "sheet2");
  first.directory();
  first.ready();
  ControlledWorker.instances[1].ready();
  await next;
  expect(receive).toHaveBeenCalledOnce();
  expect(first.terminate).toHaveBeenCalledOnce();
});

it("directory is not completion and does not extend the existing deadline", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", ControlledWorker);
  const pending = read();
  const failed = expect(pending).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(9000);
  ControlledWorker.instances[0].directory();
  await expect(read()).rejects.toMatchObject({ code: "busy" });
  await vi.advanceTimersByTimeAsync(1000);
  await failed;
  expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledOnce();
  ControlledWorker.instances[0].directory();
  ControlledWorker.instances[0].ready();
});

it("cannot introduce a preview directory into complete-input mode", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const pending = readWorkbookInput(
    capture,
    { mode: "visible-saved-cells" },
    new AbortController().signal,
  );
  ControlledWorker.instances[0].directory();
  await expect(pending).rejects.toMatchObject({ code: "invalid" });
});

it("rechecks the original capture identity before delivering any directory", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const owned = { ...capture, file: { ...capture.file } };
  const receive = vi.fn();
  const pending = readWorkbookPreview(
    owned,
    undefined,
    new AbortController().signal,
    receive,
  );
  owned.file.version = "replaced";
  ControlledWorker.instances[0].directory();
  await expect(pending).rejects.toMatchObject({ code: "invalid" });
  expect(receive).not.toHaveBeenCalled();
});
