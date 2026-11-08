import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { firstSheetFailureFixture } from "./xlsx_directory.test-support";
import { corruptGlobalStyles } from "./xlsx_directory.test-support";
import { replacePart } from "./xlsx_fixture";
import { parseWorkbook } from "./xlsx_parse";
import { prepareOfficePreview } from "./office_preview_prepare";
import {
  restoredWorkbookSheet,
  type PreviewReadingPositionRef,
} from "./preview_reading_position";
import type { WorkbookCapture, XlsxWorkerInput } from "./xlsx_types";
import type { PreparedWorkbookPreview } from "./office_preview_prepare";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

const a = firstSheetFailureFixture();
const b = replacePart(a, "xl/worksheets/sheet2.xml", (xml) =>
  xml.replace("<v>42</v>", "<v>43</v>"),
);
function capture(input: XlsxWorkerInput, version: string): WorkbookCapture {
  return {
    ...input,
    inflatedBytes: 10000,
    file: {
      root: "/authored",
      path: "/authored/refresh.xlsx",
      resolvedPath: "/authored/refresh.xlsx",
      name: "refresh.xlsx",
      size: 2000,
      // Authored capture receipt only; native ZIP capture is a separate layer.
      sha256: createHash("sha256")
        .update(JSON.stringify(input.parts))
        .digest("hex"),
      version,
    },
  };
}
const oldCapture = capture(a, "version-a");
const newCapture = capture(b, "version-b");
const position: PreviewReadingPositionRef = {
  current: {
    root: oldCapture.file.root,
    resolvedPath: oldCapture.file.resolvedPath,
    kind: "workbook",
    sheet: { id: "sheet2", name: "Good second sheet" },
    row: 1,
    column: 1,
    showHidden: false,
  },
};
class ParserWorker extends EventTarget {
  static instances: ParserWorker[] = [];
  terminate = vi.fn();
  payload?: XlsxWorkerInput;
  constructor() {
    super();
    ParserWorker.instances.push(this);
  }
  postMessage = (payload: XlsxWorkerInput) => {
    this.payload = payload;
  };
  parse() {
    const reply = (data: unknown) =>
      this.dispatchEvent(new MessageEvent("message", { data }));
    try {
      const workbook = parseWorkbook(this.payload!, (directory) =>
        reply({ kind: "directory", directory }),
      );
      reply({ kind: "ready", workbook });
    } catch {
      reply({ kind: "error", code: "invalid" });
    }
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  h.invoke.mockReset();
  ParserWorker.instances = [];
});

it("the new same-path version has a valid retained second sheet and a bad unrelated default", () => {
  expect(newCapture.file.resolvedPath).toBe(oldCapture.file.resolvedPath);
  expect(newCapture.file.sha256).not.toBe(oldCapture.file.sha256);
  expect(() => parseWorkbook(b)).toThrow("invalid");
  const actual = parseWorkbook({ ...b, sheetId: "sheet2" });
  expect(restoredWorkbookSheet(newCapture.file, actual, position)).toBe(
    "sheet2",
  );
  expect(actual.sheet?.cells[0].value).toBe(43);
});

it("prepares the retained readable second sheet of version B even when its default first sheet is bad", async () => {
  vi.stubGlobal("Worker", ParserWorker);
  h.invoke.mockResolvedValue(newCapture);
  const old: PreparedWorkbookPreview = {
    kind: "workbook",
    file: oldCapture.file,
    capture: oldCapture,
    value: parseWorkbook({ ...a, sheetId: "sheet2" }),
  };
  const oldOpinion = {
    version: oldCapture.file.version,
    sha256: oldCapture.file.sha256,
    sheetId: "sheet2",
    sheetName: "Good second sheet",
    text: "Keep this version's opinion",
  };
  const opinionBefore = structuredClone(oldOpinion);
  let visible = old;
  const pending = prepareOfficePreview(
    newCapture.file,
    position,
    new AbortController().signal,
    () => true,
  ).then(
    (value) => {
      if (value.kind !== "workbook") throw new Error("wrong format");
      visible = value;
      return { state: "ready", value };
    },
    (error: { code?: string }) => ({ state: "failed", code: error.code }),
  );
  await vi.waitFor(() => expect(ParserWorker.instances).toHaveLength(1));
  expect(visible).toBe(old);
  ParserWorker.instances[0].parse();
  const result = await pending;
  expect(oldOpinion).toEqual(opinionBefore);
  expect(old.value.sheet?.cells[0].value).toBe(42);
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
    "file_delivery_read_workbook",
    { file: newCapture.file },
  );
  expect(
    result,
    `requested sheets: ${JSON.stringify(ParserWorker.instances.map((worker) => worker.payload?.sheetId))}`,
  ).toMatchObject({
    state: "ready",
    value: { file: newCapture.file, value: { sheet: { id: "sheet2" } } },
  });
  expect(visible.value.sheet?.cells[0].value).toBe(43);
  expect(visible.file.sha256).toBe(newCapture.file.sha256);
  expect(ParserWorker.instances).toHaveLength(1);
  expect(ParserWorker.instances[0].payload?.restoreSheet).toEqual(
    position.current?.kind === "workbook" ? position.current.sheet : undefined,
  );
});

it.each(["root", "resolvedPath"] as const)(
  "does not lend a retained sheet from a different %s",
  async (field) => {
    vi.stubGlobal("Worker", ParserWorker);
    h.invoke.mockResolvedValue(newCapture);
    const foreign = structuredClone(position);
    foreign.current![field] = "/different";
    const pending = prepareOfficePreview(
      newCapture.file,
      foreign,
      new AbortController().signal,
      () => true,
    );
    await vi.waitFor(() => expect(ParserWorker.instances).toHaveLength(1));
    expect(ParserWorker.instances[0].payload?.restoreSheet).toBeUndefined();
    ParserWorker.instances[0].parse();
    await expect(pending).rejects.toMatchObject({ code: "invalid" });
    expect(ParserWorker.instances).toHaveLength(1);
  },
);

it.each(["selected-sheet", "global"])(
  "fails once without publishing or falling back after bad %s data",
  async (failure) => {
    vi.stubGlobal("Worker", ParserWorker);
    const input =
      failure === "global"
        ? corruptGlobalStyles(b)
        : replacePart(b, "xl/worksheets/sheet2.xml", () => "<worksheet>");
    h.invoke.mockResolvedValue(capture(input, "bad-version"));
    const file = capture(input, "bad-version").file;
    const pending = prepareOfficePreview(
      file,
      position,
      new AbortController().signal,
      () => true,
    );
    await vi.waitFor(() => expect(ParserWorker.instances).toHaveLength(1));
    ParserWorker.instances[0].parse();
    await expect(pending).rejects.toMatchObject({ code: "invalid" });
    expect(ParserWorker.instances).toHaveLength(1);
    expect(h.invoke).toHaveBeenCalledOnce();
  },
);

it("does not retry an unknown native capture result", async () => {
  vi.stubGlobal("Worker", ParserWorker);
  h.invoke.mockRejectedValue({ code: "readPending" });
  await expect(
    prepareOfficePreview(
      newCapture.file,
      position,
      new AbortController().signal,
      () => true,
    ),
  ).rejects.toMatchObject({ code: "readPending" });
  expect(ParserWorker.instances).toHaveLength(0);
  expect(h.invoke).toHaveBeenCalledOnce();
});

it("a cancellation rejects late target bytes without a replacement read", async () => {
  vi.stubGlobal("Worker", ParserWorker);
  h.invoke.mockResolvedValue(newCapture);
  const control = new AbortController();
  const pending = prepareOfficePreview(
    newCapture.file,
    position,
    control.signal,
    () => true,
  );
  await vi.waitFor(() => expect(ParserWorker.instances).toHaveLength(1));
  control.abort();
  ParserWorker.instances[0].parse();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  expect(ParserWorker.instances).toHaveLength(1);
  expect(ParserWorker.instances[0].terminate).toHaveBeenCalledOnce();
});

it("a target timeout is not a reason to try the default or another sheet", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", ParserWorker);
  h.invoke.mockResolvedValue(newCapture);
  const pending = prepareOfficePreview(
    newCapture.file,
    position,
    new AbortController().signal,
    () => true,
  );
  const result = expect(pending).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(10000);
  await result;
  expect(ParserWorker.instances).toHaveLength(1);
  expect(ParserWorker.instances[0].terminate).toHaveBeenCalledOnce();
});
