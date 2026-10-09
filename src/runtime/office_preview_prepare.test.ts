import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  dc: vi.fn(),
  dp: vi.fn(),
  wc: vi.fn(),
  wp: vi.fn(),
}));
vi.mock("./docx_preview", () => ({
  readDocxCapture: h.dc,
  readDocxPreview: h.dp,
}));
vi.mock("./xlsx_preview", () => ({
  readWorkbookCapture: h.wc,
  readWorkbookPreview: h.wp,
}));
import { prepareOfficePreview } from "./office_preview_prepare";
const file = {
  root: "/work",
  path: "/work/a.docx",
  resolvedPath: "/work/a.docx",
  name: "a.docx",
  size: 3,
  sha256: "one",
  version: "one",
};
beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
});

it("does not replace a document until its capture and parser finish", async () => {
  let resolve!: (v: unknown) => void;
  h.dc.mockResolvedValue({ file });
  h.dp.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  let ready = false;
  const task = prepareOfficePreview(
    file,
    { current: null },
    new AbortController().signal,
    () => true,
  ).then((v) => {
    ready = true;
    return v;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  const value = { file, blocks: [] };
  resolve(value);
  expect(await task).toEqual({ kind: "docx", file, value });
});
it("continues awaiting bounded capture after presentation cancellation and preserves pending", async () => {
  let reject!: (v: unknown) => void;
  h.dc.mockImplementation(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  const parser = new AbortController();
  const task = prepareOfficePreview(
    file,
    { current: null },
    parser.signal,
    () => !parser.signal.aborted,
  );
  parser.abort();
  expect(h.dc.mock.calls[0][1].aborted).toBe(false);
  reject({ code: "readPending" });
  await expect(task).rejects.toEqual({ code: "readPending" });
  expect(h.dp).not.toHaveBeenCalled();
});
it("discards a late captured file without starting its parser after hiding", async () => {
  let resolve!: (v: unknown) => void;
  h.dc.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  let active = true;
  const task = prepareOfficePreview(
    file,
    { current: null },
    new AbortController().signal,
    () => active,
  );
  active = false;
  resolve({ file });
  await expect(task).rejects.toEqual({ code: "cancelled" });
  expect(h.dp).not.toHaveBeenCalled();
});
it("propagates a document parsing failure instead of returning a prepared receipt", async () => {
  h.dc.mockResolvedValue({ file });
  h.dp.mockRejectedValue({ code: "invalid" });
  await expect(
    prepareOfficePreview(
      file,
      { current: null },
      new AbortController().signal,
      () => true,
    ),
  ).rejects.toEqual({ code: "invalid" });
});
it("fully prepares the retained worksheet from the new capture before replacement", async () => {
  const workbookFile = { ...file, name: "a.xlsx" };
  const capture = { file: workbookFile };
  h.wc.mockResolvedValue(capture);
  h.wp.mockResolvedValueOnce({
    sheets: [
      { id: "1", name: "First", state: "visible" },
      { id: "2", name: "Notes", state: "visible" },
    ],
    sheet: { id: "1" },
  });
  const value = {
    sheets: [{ id: "2", name: "Notes", state: "visible" }],
    sheet: { id: "2" },
  };
  h.wp.mockResolvedValueOnce(value);
  const prepared = await prepareOfficePreview(
    workbookFile,
    {
      current: {
        root: file.root,
        resolvedPath: file.resolvedPath,
        kind: "workbook",
        sheet: { id: "2", name: "Notes" },
        row: 1,
        column: 1,
        showHidden: false,
      },
    },
    new AbortController().signal,
    () => true,
  );
  expect(h.wc).toHaveBeenCalledOnce();
  expect(h.wp.mock.calls.map((c) => c[1])).toEqual([undefined, "2"]);
  expect(prepared).toEqual({
    kind: "workbook",
    file: workbookFile,
    capture,
    value,
  });
});
