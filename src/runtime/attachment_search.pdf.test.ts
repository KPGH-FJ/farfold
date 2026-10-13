import { expect, it } from "vitest";
import { pdfSetup } from "./attachment_search.pdf.test-support";

it("searches PDF decoded page text through the bounded capture, never raw file text", async () => {
  const h = pdfSetup();
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().matches).toBe(1);
  expect(h.services.readPdf).toHaveBeenCalledOnce();
  expect(h.services.read).not.toHaveBeenCalled();
  expect(h.search.snapshot().hits[0]).toMatchObject({
    location: { kind: "pdf", pageNumber: 1, itemIndex: 0, decodedRotation: 0 },
  });
});

import { vi } from "vitest";
import { deferred, tick } from "./attachment_search.test-support";
import { searchPdf } from "./attachment_search.pdf.test-support";
import {
  AttachmentSearch,
  ATTACHMENT_SEARCH_LIMITS as L,
} from "./attachment_search";
import type { PdfInputCapture, PdfInputResult } from "./pdf_input_types";
import { xlsxSetup } from "./attachment_search.xlsx.test-support";
import type { DocxPreview } from "./docx_types";

it("enumerating and selecting candidates does not inspect/read; only explicit Start does", async () => {
  const h = pdfSetup();
  h.refresh();
  expect(h.services.inspect).not.toHaveBeenCalled();
  expect(h.services.readPdf).not.toHaveBeenCalled();
  expect(h.services.parsePdf).not.toHaveBeenCalled();
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().matches).toBe(1);
  // A new query keeps the same valid current-file selection; no new consent box.
  await h.search.start("absent", h.candidates, h.current);
  expect(h.search.snapshot().matches).toBe(0);
  expect(h.services.readPdf).toHaveBeenCalledTimes(2);
});
it.each(["application/pdf", " Application/PDF ; charset=binary"])(
  "routes extensionless PDF MIME %s",
  async (mimeType) => {
    const h = pdfSetup(),
      item = h.s.items[0];
    if (item.kind !== "user") throw Error();
    const path = "/fixture/extensionless";
    item.attachments[0] = {
      name: "display.txt",
      uri: `file://${path}`,
      mimeType,
    };
    Object.assign(h.file, { path, resolvedPath: path, name: "extensionless" });
    h.files.set(path, h.file);
    h.captures.set(path, h.capture);
    h.results.set(path, h.pdf);
    await h.search.start("needle", h.refresh(), h.current);
    expect(h.search.snapshot().matches).toBe(1);
    expect(h.services.read).not.toHaveBeenCalled();
  },
);
it("uses uppercase actual PDF path, not a misleading display name", async () => {
  const h = pdfSetup(),
    item = h.s.items[0];
  if (item.kind !== "user") throw Error();
  item.attachments[0] = {
    name: "display.pdf",
    uri: "file:///fixture/file0.txt",
  };
  await h.search.start("controlled", h.refresh(), h.current);
  expect(h.services.readPdf).not.toHaveBeenCalled();
  expect(h.search.snapshot().matches).toBe(1);
  const path = "/fixture/UPPER.PDF";
  item.attachments[0] = { name: "display.txt", uri: `file://${path}` };
  Object.assign(h.file, { path, resolvedPath: path, name: "UPPER.PDF" });
  h.files.set(path, h.file);
  h.captures.set(path, h.capture);
  h.results.set(path, h.pdf);
  await h.search.start("needle", h.refresh(), h.current);
  expect(h.search.snapshot().matches).toBe(1);
});
it.each([
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "sha256",
  "version",
] as const)("rejects capture source field %s before parsing", async (key) => {
  const h = pdfSetup();
  h.services.readPdf.mockResolvedValue({
    ...h.capture,
    file: {
      ...h.file,
      [key]:
        key === "size" ? 9 : key === "sha256" ? "b".repeat(64) : "/changed",
    },
  });
  await h.search.start("needle", h.candidates, h.current);
  expect(h.services.parsePdf).not.toHaveBeenCalled();
  expect(h.search.snapshot().hits).toEqual([]);
});
it.each([
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "sha256",
  "version",
] as const)("rejects changed post-parse source %s", async (key) => {
  const h = pdfSetup();
  h.services.check.mockResolvedValue({
    kind: "verified",
    file: {
      ...h.file,
      [key]:
        key === "size" ? 9 : key === "sha256" ? "b".repeat(64) : "/changed",
    },
  });
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().hits).toEqual([]);
});
it.each([
  "bad base64",
  Buffer.from("%PDF-wrong-whole-bytes").toString("base64"),
])(
  "rejects invalid bytes before Worker without raw-text fallback",
  async (data) => {
    const h = pdfSetup();
    h.services.readPdf.mockResolvedValue({ ...h.capture, data });
    await h.search.start("needle", h.candidates, h.current);
    expect(h.services.parsePdf).not.toHaveBeenCalled();
    expect(h.services.read).not.toHaveBeenCalled();
    expect(h.search.snapshot().hits).toEqual([]);
  },
);
it("checks full SHA even when changed PDF bytes have the same length", async () => {
  const h = pdfSetup();
  h.services.readPdf.mockResolvedValue({
    ...h.capture,
    data: Buffer.from("%PDF-controlled-capture-X").toString("base64"),
  });
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().rows[0].code).toBe("changed");
  expect(h.services.parsePdf).not.toHaveBeenCalled();
});
it("owns an immutable byte/source snapshot across digest and parser awaits", async () => {
  const h = pdfSetup(),
    originalData = h.capture.data;
  h.services.parsePdf.mockImplementation(async (captured) => {
    h.capture.data = "changed";
    h.capture.file.version = "changed";
    expect(captured.data).toBe(originalData);
    expect(captured.file.version).toBe("version0");
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.file)).toBe(true);
    return h.pdf;
  });
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().matches).toBe(1);
});
it.each([
  ["readPending", "pending"],
  ["readBusy", "busy"],
  ["limit", "documentLimit"],
  ["encrypted", "encrypted"],
  ["changed", "changed"],
  ["unreadable", "unreadable"],
  ["invalid", "invalid"],
])("keeps capture failure %s as %s", async (code, expected) => {
  const h = pdfSetup();
  h.services.readPdf.mockRejectedValue({ code });
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().rows[0].code).toBe(expected);
  expect(h.services.parsePdf).not.toHaveBeenCalled();
  expect(h.services.read).not.toHaveBeenCalled();
});
it.each([
  ["textLimit", "documentLimit"],
  ["incomplete", "pdfIncomplete"],
  ["scopeRequired", "invalid"],
  ["busy", "busy"],
  ["timeout", "timeout"],
  ["encrypted", "encrypted"],
  ["unsupported", "unsupported"],
])(
  "keeps Worker failure %s as %s with no earlier-page success",
  async (code, expected) => {
    const h = pdfSetup();
    h.services.parsePdf.mockRejectedValue({ code });
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().rows[0].code).toBe(expected);
    expect(h.search.snapshot().hits).toEqual([]);
    expect(h.services.check).not.toHaveBeenCalled();
    expect(h.services.read).not.toHaveBeenCalled();
  },
);
it("matches only individual page items and does not search generated scope/labels", async () => {
  const h = pdfSetup();
  h.results.set(
    h.file.path,
    searchPdf([
      ["left", "right", "pageTail"],
      ["pageHead", "needle", "ééfiﬁ中🚀"],
    ]),
  );
  for (const query of [
    "leftright",
    "pageTailpageHead",
    "readPageNumbers",
    "decodedRotation",
    "visibilityUnverified",
    "PDF 提取文字",
  ]) {
    await h.search.start(query, h.candidates, h.current);
    expect(h.search.snapshot().matches).toBe(0);
  }
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().hits[0].location).toEqual({
    kind: "pdf",
    pageNumber: 2,
    itemIndex: 1,
    decodedRotation: 90,
  });
});
it("reports no extracted text instead of a successful whole-PDF absence", async () => {
  const h = pdfSetup();
  h.results.set(h.file.path, searchPdf([[]]));
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().rows[0]).toMatchObject({
    state: "error",
    code: "pdfNoText",
  });
  expect(h.search.snapshot().hits).toEqual([]);
});
it("preserves the 1MiB source cap before capture", async () => {
  const h = pdfSetup();
  h.file.size = L.fileBytes + 1;
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().rows[0].code).toBe("tooLarge");
  expect(h.services.readPdf).not.toHaveBeenCalled();
});
it("serializes same-batch PDF Workers while allowing two captures", async () => {
  const h = pdfSetup(["needle", "needle"]),
    gate = deferred<PdfInputResult>();
  h.services.parsePdf.mockImplementationOnce(() => gate.promise);
  const run = h.search.start("needle", h.candidates, h.current);
  await vi.waitFor(() => expect(h.services.parsePdf).toHaveBeenCalledOnce());
  expect(h.services.readPdf).toHaveBeenCalledTimes(2);
  gate.resolve(h.pdf);
  await run;
  expect(h.services.parsePdf).toHaveBeenCalledTimes(2);
  expect(h.search.snapshot().matches).toBe(2);
});
it("shares one parse tail across DOCX, XLSX and PDF", async () => {
  const h = pdfSetup(["needle", "needle", "needle"]),
    gate = deferred<PdfInputResult>();
  const docxItem = h.s.items[1],
    xlsxItem = h.s.items[2];
  if (docxItem.kind !== "agent" || xlsxItem.kind !== "user") throw Error();
  docxItem.attachments![0].mimeType =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  xlsxItem.attachments[0].mimeType =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const docxFile = [...h.captures.values()][1].file,
    xlsxFile = [...h.captures.values()][2].file;
  const docxGate = deferred<DocxPreview>();
  const parseDocx = vi.fn(() => docxGate.promise),
    x = xlsxSetup();
  const parseWorkbook = vi.fn(async () => x.workbook);
  h.services.parsePdf.mockImplementationOnce(() => gate.promise);
  const search = new AttachmentSearch({
    ...h.services,
    readDocx: async () => ({
      file: docxFile,
      parts: [],
      entries: [],
      inflatedBytes: 1,
    }),
    parseDocx,
    readWorkbook: async () => ({
      file: xlsxFile,
      parts: [],
      entries: [],
      inflatedBytes: 1,
    }),
    parseWorkbook,
  });
  const run = search.start("needle", h.refresh(), h.current);
  // Captured native bytes need hashing; DOCX may queue first. Ensure at most one parser runs,
  // whichever ready capture reaches the shared tail first.
  await vi.waitFor(() =>
    expect(
      h.services.parsePdf.mock.calls.length + parseDocx.mock.calls.length,
    ).toBe(1),
  );
  expect(parseWorkbook).not.toHaveBeenCalled();
  docxGate.resolve({
    file: docxFile,
    blocks: [
      {
        kind: "paragraph",
        id: "p",
        source: { part: "word/document.xml", elementPath: [0] },
        style: {},
        runs: [{ kind: "text", text: "needle", style: {} }],
      },
    ],
    stories: [],
    images: [],
    warnings: [],
    partial: false,
  });
  gate.resolve(h.pdf);
  await run;
  expect(search.snapshot().matches).toBe(3);
  expect(parseWorkbook).toHaveBeenCalledOnce();
  expect(parseDocx).toHaveBeenCalledOnce();
});
it("waits for native capture after cancellation and never starts its late Worker", async () => {
  const h = pdfSetup(),
    gate = deferred<PdfInputCapture>();
  h.services.readPdf.mockImplementation(() => gate.promise);
  const run = h.search.start("needle", h.candidates, h.current);
  await tick();
  h.search.cancel();
  expect(h.search.snapshot().phase).toBe("cancelling");
  expect(h.search.active()).toBe(true);
  gate.resolve(h.capture);
  await run;
  expect(h.search.snapshot()).toMatchObject({ phase: "cancelled", hits: [] });
  expect(h.services.parsePdf).not.toHaveBeenCalled();
});
it("aborts the Worker and discards a late result/queued parser", async () => {
  const h = pdfSetup(["needle", "needle"]),
    gate = deferred<PdfInputResult>();
  h.services.parsePdf.mockImplementationOnce(() => gate.promise);
  const run = h.search.start("needle", h.candidates, h.current);
  await vi.waitFor(() => expect(h.services.parsePdf).toHaveBeenCalledOnce());
  h.search.cancel();
  expect(h.services.parsePdf.mock.calls[0][1].aborted).toBe(true);
  gate.resolve(h.pdf);
  await run;
  expect(h.services.parsePdf).toHaveBeenCalledOnce();
  expect(h.search.snapshot().hits).toEqual([]);
});
it.each(["mime", "uri", "owner"])(
  "retires late capture after %s changes",
  async (kind) => {
    const h = pdfSetup(),
      gate = deferred<PdfInputCapture>();
    h.services.readPdf.mockImplementation(() => gate.promise);
    const run = h.search.start("needle", h.candidates, h.current);
    await tick();
    const item = h.s.items[0];
    if (item.kind !== "user") throw Error();
    if (kind === "owner") h.s.cwd = "/changed";
    else if (kind === "mime") item.attachments[0].mimeType = "text/plain";
    else item.attachments[0].uri = "file:///another.pdf";
    gate.resolve(h.capture);
    await run;
    expect(h.search.snapshot()).toMatchObject({ phase: "stale", hits: [] });
    expect(h.services.parsePdf).not.toHaveBeenCalled();
  },
);
it("explicitly retries pending reads without claiming the older OS read ended", async () => {
  const h = pdfSetup();
  h.services.readPdf.mockRejectedValueOnce({ code: "readPending" });
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().phase).toBe("pending");
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot()).toMatchObject({
    matches: 1,
    previousPending: true,
  });
});
it("limits displayed hits and revalidates the current file before jumping", async () => {
  const h = pdfSetup(["needle ".repeat(205)]);
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().matches).toBe(205);
  expect(h.search.snapshot().hits).toHaveLength(200);
  const hit = h.search.snapshot().hits[0];
  expect(await h.search.verifyHit(hit, h.current)).toBe(true);
  h.services.check.mockRejectedValue({ code: "changed" });
  expect(await h.search.verifyHit(hit, h.current)).toBe(false);
  expect(h.search.snapshot()).toMatchObject({
    phase: "stale",
    hits: [],
    error: "changed",
  });
});
it("counts decoded UTF-8 rather than encoded capture/JSON representation", async () => {
  const h = pdfSetup(["中🚀 needle"], ["text needle"]);
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().bytes).toBe(
    Buffer.byteLength("中🚀 needletext needle"),
  );
  expect(h.search.snapshot().matches).toBe(2);
});

import {
  attachmentSearchCandidates,
  attachmentSearchSourceCurrent,
} from "./attachment_search_source";
it.each([0, 1])(
  "shares the actual 16MiB XLSX/plain/PDF budget (over by %i)",
  async (over) => {
    const p = pdfSetup(["中🚀 needle"]),
      pdfBytes = Buffer.byteLength("中🚀 needle"),
      plain = "plain needle";
    const h = xlsxSetup(
      [
        "a".repeat(L.totalBytes / 2),
        "b".repeat(
          L.totalBytes / 2 - pdfBytes - Buffer.byteLength(plain) + over,
        ),
      ],
      [plain],
    );
    h.s.items.push({ ...p.s.items[0], id: "pdf-last" });
    h.files.set(p.file.path, p.file);
    const candidates = attachmentSearchCandidates(
      [h.s.key],
      h.states,
    ).candidates;
    const current = () =>
      candidates.every((c) => attachmentSearchSourceCurrent(c, h.states));
    const search = new AttachmentSearch({
      ...h.services,
      readPdf: p.services.readPdf,
      parsePdf: p.services.parsePdf,
    });
    await search.start("needle", candidates, current);
    expect(search.snapshot().rows.at(-1)?.state).toBe(
      over ? "skipped" : "searched",
    );
    expect(search.snapshot().rows.at(-1)?.code).toBe(
      over ? "budget" : undefined,
    );
    expect(search.snapshot().bytes).toBe(
      over ? L.totalBytes - pdfBytes + 1 : L.totalBytes,
    );
  },
);
it("preserves DOCX/XLSX routing precedence for conflicting PDF declarations", async () => {
  for (const mimeType of [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ]) {
    const h = pdfSetup(),
      item = h.s.items[0];
    if (item.kind !== "user") throw Error();
    item.attachments[0].mimeType = mimeType;
    await h.search.start("needle", h.refresh(), h.current);
    expect(h.services.readPdf).not.toHaveBeenCalled();
    expect(h.services.read).not.toHaveBeenCalled();
    expect(h.search.snapshot().rows[0].code).toBe("unsupported");
  }
});
it("retired result ownership cannot publish a late PDF parse", async () => {
  const h = pdfSetup(),
    gate = deferred<PdfInputResult>();
  h.services.parsePdf.mockImplementationOnce(() => gate.promise);
  const run = h.search.start("needle", h.candidates, h.current);
  await vi.waitFor(() => expect(h.services.parsePdf).toHaveBeenCalledOnce());
  h.search.retire();
  gate.resolve(h.pdf);
  await run;
  expect(h.search.snapshot().hits).toEqual([]);
});
