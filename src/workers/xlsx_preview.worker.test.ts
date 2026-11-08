import { afterEach, expect, it, vi } from "vitest";
import { firstSheetFailureFixture } from "../runtime/xlsx_directory.test-support";
import { workbookFixture } from "../runtime/xlsx_fixture";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function worker() {
  vi.resetModules();
  const postMessage = vi.fn();
  vi.stubGlobal("postMessage", postMessage);
  vi.stubGlobal("onmessage", undefined);
  vi.stubGlobal("fetch", vi.fn());
  await import("./xlsx_preview.worker");
  return {
    postMessage,
    send: (data: unknown) => {
      const handle = globalThis.onmessage as
        ((event: MessageEvent) => unknown) | null;
      return handle?.(new MessageEvent("message", { data }));
    },
  };
}

it("the actual packaged worker publishes directory then the actual first-sheet error exactly once", async () => {
  const w = await worker();
  w.send(firstSheetFailureFixture());
  expect(w.postMessage.mock.calls.map(([packet]) => packet.kind)).toEqual([
    "directory",
    "error",
  ]);
  expect(w.postMessage.mock.calls[0][0].directory).toMatchObject({
    sheets: [{ id: "sheet1" }, { id: "sheet2" }],
    selectedId: "sheet1",
  });
  expect(w.postMessage.mock.calls[1][0]).toEqual({
    kind: "error",
    code: "invalid",
  });
  w.send({ ...firstSheetFailureFixture(), sheetId: "sheet2" });
  expect(w.postMessage).toHaveBeenCalledTimes(2);
});

it("the actual packaged worker publishes a complete second sheet after its directory", async () => {
  const w = await worker();
  w.send({ ...firstSheetFailureFixture(), sheetId: "sheet2" });
  expect(w.postMessage.mock.calls.map(([packet]) => packet.kind)).toEqual([
    "directory",
    "ready",
  ]);
  expect(w.postMessage.mock.calls[1][0].workbook.sheet.cells[0].value).toBe(42);
});

it("the unchanged complete-input mode never publishes a preview directory", async () => {
  const w = await worker();
  w.send({
    ...workbookFixture('<row r="1"><c r="A1"><v>7</v></c></row>'),
    kind: "input",
    request: { mode: "visible-saved-cells" },
  });
  expect(w.postMessage.mock.calls.map(([packet]) => packet.kind)).toEqual([
    "inputReady",
  ]);
});
