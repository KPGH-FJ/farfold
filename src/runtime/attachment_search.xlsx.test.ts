import { describe, expect, it } from "vitest";
import { xlsxSetup } from "./attachment_search.xlsx.test-support";

describe("selected current XLSX attachment search", () => {
  it("reads XLSX through the bounded capture and searches cell author content", async () => {
    const h = xlsxSetup();
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().matches).toBe(1);
    expect(h.services.readWorkbook).toHaveBeenCalledOnce();
    expect(h.services.read).not.toHaveBeenCalled();
    expect(h.search.snapshot().hits[0]).toMatchObject({
      location: {
        kind: "xlsx",
        sheetId: "sheet1",
        reference: "A1",
        field: "value",
      },
    });
  });
});

import { vi } from "vitest";
import { deferred, tick } from "./attachment_search.test-support";
import {
  searchCell,
  searchWorkbook,
} from "./attachment_search.xlsx.test-support";
import {
  AttachmentSearch,
  ATTACHMENT_SEARCH_LIMITS as L,
} from "./attachment_search";
import { XlsxError, type WorkbookCapture } from "./xlsx_types";
import type { XlsxInputResult } from "./xlsx_input_types";
import type { DocxPreview } from "./docx_types";

it.each([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  " Application/Vnd.Openxmlformats-Officedocument.Spreadsheetml.Sheet ; charset=UTF-8",
])(
  "uses declared XLSX MIME essence without a filename suffix: %s",
  async (mimeType) => {
    const h = xlsxSetup(),
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
    h.results.set(path, h.workbook);
    await h.search.start("needle", h.refresh(), h.current);
    expect(h.search.snapshot().matches).toBe(1);
    expect(h.services.read).not.toHaveBeenCalled();
  },
);
it("dispatches uppercase actual XLSX paths but not a misleading display name", async () => {
  const h = xlsxSetup(),
    item = h.s.items[0];
  if (item.kind !== "user") throw Error();
  item.attachments[0] = {
    name: "misleading.xlsx",
    uri: "file:///fixture/file0.txt",
  };
  await h.search.start("compressed", h.refresh(), h.current);
  expect(h.services.readWorkbook).not.toHaveBeenCalled();
  expect(h.search.snapshot().matches).toBe(1);
  const path = "/fixture/UPPER.XLSX";
  item.attachments[0] = { name: "other", uri: `file://${path}` };
  Object.assign(h.file, { path, resolvedPath: path, name: "UPPER.XLSX" });
  h.files.set(path, h.file);
  h.captures.set(path, h.capture);
  h.results.set(path, h.workbook);
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
] as const)("rejects changed capture field %s before parsing", async (key) => {
  const h = xlsxSetup();
  h.services.readWorkbook.mockResolvedValue({
    ...h.capture,
    file: {
      ...h.file,
      [key]:
        key === "size" ? 9 : key === "sha256" ? "b".repeat(64) : "/changed",
    },
  });
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().hits).toEqual([]);
  expect(h.services.parseWorkbook).not.toHaveBeenCalled();
  expect(h.search.snapshot().rows[0].code).toBe(
    key === "path" ? "invalid" : "changed",
  );
});
it.each([
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "sha256",
  "version",
] as const)("rejects changed postparse revision %s", async (key) => {
  const h = xlsxSetup();
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
  ["readPending", "pending"],
  ["readBusy", "busy"],
  ["limit", "documentLimit"],
  ["encrypted", "encrypted"],
  ["changed", "changed"],
  ["unreadable", "unreadable"],
  ["invalid", "invalid"],
  ["unsupported", "unsupported"],
])("keeps capture error %s distinct as %s", async (code, expected) => {
  const h = xlsxSetup();
  h.services.readWorkbook.mockRejectedValue({ code });
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().rows[0].code).toBe(expected);
  expect(h.services.parseWorkbook).not.toHaveBeenCalled();
  expect(h.services.read).not.toHaveBeenCalled();
});
it.each(["scopeEmpty", "limit", "busy", "timeout", "invalid"])(
  "reports Worker error %s without falling back or broadening scope",
  async (code) => {
    const h = xlsxSetup();
    h.services.parseWorkbook.mockRejectedValue({ code });
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().rows[0].code).toBe(
      code === "limit" ? "documentLimit" : code,
    );
    expect(h.services.read).not.toHaveBeenCalled();
  },
);
it("matches formula and saved cache separately, never across cells or labels", async () => {
  const h = xlsxSetup();
  h.workbook.selectedSheets[0].cells = [
    searchCell("cache needle", {
      type: "str",
      rawValue: "cache needle",
      formula: {
        included: true,
        text: "formula needle",
        attributes: { ref: "attribute needle" },
      },
      cacheState: "present",
    }),
    searchCell("tail", { reference: "B1", column: 2 }),
  ];
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().matches).toBe(2);
  expect(
    h.search
      .snapshot()
      .hits.map((x) =>
        x.location && "kind" in x.location ? x.location.field : null,
      ),
  ).toEqual(["savedCache", "formula"]);
  for (const query of [
    "needleformula",
    "needletail",
    "attribute",
    "Author sheet",
    "A1",
  ]) {
    await h.search.start(query, h.candidates, h.current);
    expect(h.search.snapshot().matches).toBe(0);
  }
});
it("serializes two real parser slots within a batch while allowing capture prefetch", async () => {
  const h = xlsxSetup(["needle", "needle"]),
    gate = deferred<XlsxInputResult>();
  h.services.parseWorkbook.mockImplementationOnce(() => gate.promise);
  const run = h.search.start("needle", h.candidates, h.current);
  await tick();
  expect(h.services.readWorkbook).toHaveBeenCalledTimes(2);
  expect(h.services.parseWorkbook).toHaveBeenCalledOnce();
  gate.resolve(h.workbook);
  await run;
  expect(h.services.parseWorkbook).toHaveBeenCalledTimes(2);
  expect(h.search.snapshot().matches).toBe(2);
});
it("shares the batch parser tail across DOCX and XLSX", async () => {
  const h = xlsxSetup(["needle", "needle"]),
    gate = deferred<XlsxInputResult>();
  const item = h.s.items[1];
  if (item.kind !== "agent") throw Error();
  const f = [...h.captures.values()][1].file;
  item.attachments![0].mimeType =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  h.services.parseWorkbook.mockImplementation(() => gate.promise);
  const preview: DocxPreview = {
    file: f,
    blocks: [
      {
        kind: "paragraph",
        id: "p",
        style: {},
        source: { part: "word/document.xml", elementPath: [0] },
        runs: [{ kind: "text", text: "needle", style: {} }],
      },
    ],
    stories: [],
    images: [],
    warnings: [],
    partial: false,
  };
  const parseDocx = vi.fn(async () => preview);
  const search = new AttachmentSearch({
    ...h.services,
    readDocx: async () => ({ ...h.capture, file: f }),
    parseDocx,
  });
  const run = search.start("needle", h.refresh(), h.current);
  await tick();
  expect(parseDocx).not.toHaveBeenCalled();
  gate.resolve(h.workbook);
  await run;
  expect(parseDocx).toHaveBeenCalledOnce();
  expect(search.snapshot().matches).toBe(2);
  expect(
    search.snapshot().rows.map((r) => !!r.workbook || !!r.document),
  ).toEqual([true, true]);
});
it("waits for native capture after cancellation and never starts a late Worker", async () => {
  const h = xlsxSetup(),
    gate = deferred<WorkbookCapture>();
  h.services.readWorkbook.mockImplementation(() => gate.promise);
  const run = h.search.start("needle", h.candidates, h.current);
  await tick();
  h.search.cancel();
  expect(h.search.snapshot().phase).toBe("cancelling");
  expect(h.search.active()).toBe(true);
  gate.resolve(h.capture);
  await run;
  expect(h.search.snapshot()).toMatchObject({ phase: "cancelled", hits: [] });
  expect(h.services.parseWorkbook).not.toHaveBeenCalled();
});
it("aborts queued Worker work and discards a late parse result", async () => {
  const h = xlsxSetup(["needle", "needle"]),
    gate = deferred<XlsxInputResult>();
  h.services.parseWorkbook.mockImplementationOnce(() => gate.promise);
  const run = h.search.start("needle", h.candidates, h.current);
  await tick();
  h.search.cancel();
  expect(h.services.parseWorkbook.mock.calls[0][1].aborted).toBe(true);
  gate.resolve(h.workbook);
  await run;
  expect(h.services.parseWorkbook).toHaveBeenCalledOnce();
  expect(h.search.snapshot().hits).toEqual([]);
});
it.each(["mime", "owner"])(
  "retires late capture after %s changes",
  async (kind) => {
    const h = xlsxSetup(),
      gate = deferred<WorkbookCapture>();
    h.services.readWorkbook.mockImplementation(() => gate.promise);
    const run = h.search.start("needle", h.candidates, h.current);
    await tick();
    if (kind === "owner") h.s.cwd = "/changed";
    else {
      const item = h.s.items[0];
      if (item.kind !== "user") throw Error();
      item.attachments[0].mimeType = "text/plain";
    }
    gate.resolve(h.capture);
    await run;
    expect(h.search.snapshot()).toMatchObject({ phase: "stale", hits: [] });
    expect(h.services.parseWorkbook).not.toHaveBeenCalled();
  },
);
it("rejects capture mutation during parsing and never verifies it as current", async () => {
  const h = xlsxSetup();
  h.services.parseWorkbook.mockImplementation(async (capture) => {
    capture.file.version = "changed";
    return h.workbook;
  });
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().hits).toEqual([]);
  expect(h.services.check).not.toHaveBeenCalled();
});
it("preserves pending as unknown until explicit retry obtains a new result", async () => {
  const h = xlsxSetup();
  h.services.readWorkbook.mockRejectedValueOnce({ code: "readPending" });
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().phase).toBe("pending");
  expect(h.services.readWorkbook).toHaveBeenCalledOnce();
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().matches).toBe(1);
  expect(h.search.snapshot().previousPending).toBe(true);
});
it("counts actual decompressed UTF-8 across workbook and plain text", async () => {
  const h = xlsxSetup(
    ["界".repeat(3_000_000) + " needle", "界".repeat(3_000_000) + " needle"],
    ["plain needle"],
  );
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().rows.map((r) => [r.state, r.code])).toEqual([
    ["searched", undefined],
    ["skipped", "budget"],
    ["searched", undefined],
  ]);
  expect(h.services.parseWorkbook).toHaveBeenCalledTimes(2);
  expect(h.search.snapshot().bytes).toBe(9_000_007 + 12);
});
it("accepts exactly 16MiB actual author bytes and rejects the next field byte", async () => {
  const half = L.totalBytes / 2;
  const h = xlsxSetup([
    "a".repeat(half / 2),
    "a".repeat(half / 2),
    "a".repeat(half / 2),
    "a".repeat(half / 2),
    "z",
  ]);
  await h.search.start("no match", h.candidates, h.current);
  expect(h.search.snapshot().bytes).toBe(L.totalBytes);
  expect(h.search.snapshot().rows[4]).toMatchObject({
    state: "skipped",
    code: "budget",
  });
});
it("limits displayed hits across all fields without losing total match count", async () => {
  const h = xlsxSetup(["needle ".repeat(205)]);
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().matches).toBe(205);
  expect(h.search.snapshot().hits).toHaveLength(200);
});
it("rechecks the exact current file before navigating and clears stale results", async () => {
  const h = xlsxSetup();
  await h.search.start("needle", h.candidates, h.current);
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
it("preserves the shared source size cap before Workbook capture", async () => {
  const h = xlsxSetup();
  h.file.size = L.fileBytes + 1;
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().rows[0].code).toBe("tooLarge");
  expect(h.services.readWorkbook).not.toHaveBeenCalled();
});
it("does not charge a failed text prefetch as final budget after a large XLSX", async () => {
  const large = "界".repeat(5 * 1024 * 1024);
  const h = xlsxSetup(
    [large],
    ["a".repeat(1024 * 1024), "a".repeat(512 * 1024)],
  );
  const wait = deferred<{ file: typeof h.file; text: string }>();
  h.services.read.mockImplementationOnce(() => wait.promise);
  const run = h.search.start("no match", h.candidates, h.current);
  await tick();
  wait.reject({ code: "unreadable" });
  await run;
  expect(h.search.snapshot().rows.map((r) => r.state)).toEqual([
    "searched",
    "error",
    "searched",
  ]);
  expect(h.search.snapshot().bytes).toBe(15 * 1024 * 1024 + 512 * 1024);
});
it("late parse cannot publish after the result owner retires", async () => {
  const h = xlsxSetup(),
    wait = deferred<XlsxInputResult>();
  h.services.parseWorkbook.mockImplementation(() => wait.promise);
  const run = h.search.start("needle", h.candidates, h.current);
  await tick();
  h.search.retire();
  wait.resolve(h.workbook);
  await run;
  expect(h.search.snapshot().hits).toEqual([]);
});
it("sums DOCX, XLSX and plain content in one actual byte budget", async () => {
  const h = xlsxSetup(
    ["a".repeat(7 * 1024 * 1024), "unused"],
    ["plain needle"],
  );
  const item = h.s.items[1];
  if (item.kind !== "agent") throw Error();
  item.attachments![0].mimeType =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const f = [...h.captures.values()][1].file;
  const search = new AttachmentSearch({
    ...h.services,
    readDocx: async () => ({ ...h.capture, file: f }),
    parseDocx: async () => ({
      file: f,
      blocks: [
        {
          kind: "paragraph",
          id: "p",
          style: {},
          source: { part: "word/document.xml", elementPath: [0] },
          runs: [
            { kind: "text", text: "界".repeat(4 * 1024 * 1024), style: {} },
          ],
        },
      ],
      stories: [],
      images: [],
      warnings: [],
      partial: false,
    }),
  });
  await search.start("needle", h.refresh(), h.current);
  expect(search.snapshot().rows.map((r) => [r.state, r.code])).toEqual([
    ["searched", undefined],
    ["skipped", "budget"],
    ["searched", undefined],
  ]);
  expect(search.snapshot().bytes).toBe(7 * 1024 * 1024 + 12);
});
it("rejects a parser result that broadens visible-only search to all saved cells", async () => {
  const h = xlsxSetup();
  h.workbook.scope.mode = "all-saved-cells";
  await h.search.start("needle", h.candidates, h.current);
  expect(h.search.snapshot().rows[0].code).toBe("invalid");
  expect(h.search.snapshot().hits).toEqual([]);
});
