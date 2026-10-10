import { expect, it } from "vitest";
import * as targets from "./workbook_feedback_target";
import {
  analyzeWorkbookFeedbackRange,
  parseWorkbookFeedbackRange,
  workbookFeedbackRangeAddress,
  workbookFeedbackRangeAnalysisIsCurrent,
  validWorkbookFeedbackRange,
} from "./workbook_feedback_range";
import type { WorkbookRangeFeedbackSourceInput } from "./workbook_feedback_target";
import {
  officeFeedbackTargetMatches,
  retireOfficeFeedbackSource,
} from "./office_feedback_target";
import { replacePart, workbookFixture } from "./xlsx_fixture";
import { parseWorkbook } from "./xlsx_parse";
import type { WorkbookPreview, XlsxWorkerInput } from "./xlsx_types";
import { parseFeedbackAnchor } from "./file_feedback_anchor";
import { fileFeedbackText } from "./feedback_strings";

function input(
  address = "A1:C200",
  data: XlsxWorkerInput = workbookFixture(
    '<row r="1"><c r="A1"><v>0</v></c></row>',
  ),
): WorkbookRangeFeedbackSourceInput {
  const preview = parseWorkbook(data),
    range = parseWorkbookFeedbackRange(address)!;
  const expectedFile = {
    root: "/work",
    path: "/work/table.xlsx",
    resolvedPath: "/work/table.xlsx",
    name: "table.xlsx",
    size: 4096,
    sha256: "a".repeat(64),
    version: "one",
  };
  return {
    capture: { ...data, inflatedBytes: 10000, file: { ...expectedFile } },
    preview,
    selection: { ...range, includeHidden: false },
    analysis: analyzeWorkbookFeedbackRange({ preview, range })!,
    expectedFile,
    hiddenSheetSelected: false,
  };
}
function complex() {
  return workbookFixture(
    '<row r="22" hidden="1"><c r="D22" t="inlineStr"><is><t>PRIVATE_HIDDEN_VALUE</t></is></c></row><row r="100" hidden="1"/><row r="101" hidden="1"/>',
    {
      before:
        '<cols><col min="4" max="4" hidden="1"/><col min="25" max="25" hidden="1"/></cols>',
      extra:
        '<mergeCells><mergeCell ref="X99:AA102"/><mergeCell ref="W103:X104"/></mergeCells>',
    },
  );
}

it("provides a separate exact rectangle factory instead of reusing a clicked position", () => {
  expect(targets).toHaveProperty("createWorkbookRangeFeedbackSource");
});

it.each([
  ["a1", "A1"],
  [" A1:c200 ", "A1:C200"],
  ["C200:A1", "A1:C200"],
  ["C1:A200", "A1:C200"],
  ["XFD1048576", "XFD1048576"],
])("normalizes %s exactly to %s", (raw, address) => {
  expect(workbookFeedbackRangeAddress(parseWorkbookFeedbackRange(raw)!)).toBe(
    address,
  );
});

it.each([
  "",
  "A0",
  "A01",
  "A1048577",
  "XFE1",
  "AAAA1",
  "1:2",
  "A:C",
  "A1:B2:C3",
  "A1,B2",
  "A1 B2",
  "A1 :B2",
  "=A1",
  "$A$1",
  "Sheet2!A1",
  "[file.xlsx]A1",
  "A1.5",
  "ſ1",
  "Ａ1",
  "A١",
  "A1\n:B2",
])("rejects non-single-sheet grammar %j", (value) => {
  expect(parseWorkbookFeedbackRange(value)).toBeNull();
});

it("keeps a cross-window rectangle exact when it only cuts one merge", () => {
  const args = input("Z101:AC103", complex());
  expect(args.analysis.partialMerges).toEqual([
    { fromRow: 99, toRow: 102, fromColumn: 24, toColumn: 27 },
  ]);
  // An expansion would incorrectly reach the adjacent W103:X104 merge.
  expect(args.analysis.partialMerges).toHaveLength(1);
  args.selection = { ...args.selection, includeHidden: true };
  expect(
    targets.workbookFeedbackTarget(
      targets.createWorkbookRangeFeedbackSource(args)!,
    ),
  ).toEqual({
    kind: "xlsx-range",
    sheetId: "sheet1",
    sheetName: "样本",
    fromRow: 101,
    toRow: 103,
    fromColumn: 26,
    toColumn: 29,
  });
});

it("distinguishes contained, partial and merely adjacent merges", () => {
  const data = workbookFixture("", {
    extra: '<mergeCells><mergeCell ref="B2:D4"/></mergeCells>',
  });
  expect(input("A1:E5", data).analysis.partialMerges).toEqual([]);
  expect(input("B2:D4", data).analysis.partialMerges).toEqual([]);
  expect(input("C3", data).analysis.partialMerges).toHaveLength(1);
  expect(input("E2:E4", data).analysis.partialMerges).toEqual([]);
});

it("counts hidden interior coordinates, compresses spans, and never returns their values", () => {
  const args = input("A1:AC104", complex());
  expect(args.analysis.hiddenRows).toEqual([
    { from: 22, to: 22 },
    { from: 100, to: 101 },
  ]);
  expect(args.analysis.hiddenColumns).toEqual([
    { from: 4, to: 4 },
    { from: 25, to: 25 },
  ]);
  expect(args.analysis).toMatchObject({
    hiddenRowCount: 3,
    hiddenColumnCount: 2,
    requiresHiddenConfirmation: true,
  });
  expect(JSON.stringify(args.analysis)).not.toContain("PRIVATE_HIDDEN_VALUE");
  expect(targets.createWorkbookRangeFeedbackSource(args)).toBeNull();
  args.selection = { ...args.selection, includeHidden: true };
  const source = targets.createWorkbookRangeFeedbackSource(args)!;
  expect(source).not.toBeNull();
  expect(Object.keys(source)).toEqual(["kind", "file"]);
  expect(targets.workbookFeedbackTarget(source)).not.toHaveProperty(
    "includeHidden",
  );
  expect(args.preview.sheet!.rows[0].hidden).toBe(true);
});

it("clips/coalesces hidden spans without double counting or enumerating columns", () => {
  const args = input(
    "C1:F9",
    workbookFixture('<row r="9" hidden="1"/><row r="8" hidden="1"/>', {
      before:
        '<cols><col min="1" max="4" hidden="1"/><col min="5" max="16384" hidden="1"/></cols>',
    }),
  );
  expect(args.analysis.hiddenColumns).toEqual([{ from: 3, to: 6 }]);
  expect(args.analysis.hiddenColumnCount).toBe(4);
  expect(args.analysis.hiddenRows).toEqual([{ from: 8, to: 9 }]);
});

it("records an entire sparse sheet in bounded metadata, never its 17-billion-cell area", () => {
  const args = input("A1:XFD1048576", workbookFixture(""));
  args.preview.sheet!.cells = new Proxy([], {
    get(target, property, receiver) {
      if (property === Symbol.iterator || /^\d+$/.test(String(property)))
        throw new Error("cell area must not be enumerated");
      return Reflect.get(target, property, receiver);
    },
  });
  args.analysis = analyzeWorkbookFeedbackRange({
    preview: args.preview,
    range: parseWorkbookFeedbackRange("A1:XFD1048576")!,
  })!;
  const source = targets.createWorkbookRangeFeedbackSource(args)!;
  const result = targets.workbookFeedbackTarget(source)!;
  expect(
    (result.toRow - result.fromRow + 1) *
      (result.toColumn - result.fromColumn + 1),
  ).toBe(17_179_869_184);
  expect(JSON.stringify(args.analysis).length).toBeLessThan(1000);
  expect(
    targets.createWorkbookRangeFeedbackSource(
      input("XFD1048576", workbookFixture("")),
    ),
  ).not.toBeNull();
});

it.each(["hidden", "veryHidden"])(
  "requires separate %s sheet selection even with hidden-span acknowledgement",
  (state) => {
    const data = replacePart(workbookFixture(""), "xl/workbook.xml", (xml) =>
      xml.replace('r:id="sheet1"', `r:id="sheet1" state="${state}"`),
    );
    const args = input("A1:C200", data);
    args.selection = { ...args.selection, includeHidden: true };
    expect(targets.createWorkbookRangeFeedbackSource(args)).toBeNull();
    expect(
      targets.createWorkbookRangeFeedbackSource({
        ...args,
        hiddenSheetSelected: true,
      }),
    ).not.toBeNull();
  },
);

it("keeps the exact nonordinal relationship id and rejects another identical preview", () => {
  let data = replacePart(workbookFixture(""), "xl/workbook.xml", (xml) =>
    xml
      .replace('r:id="sheet1"', 'r:id="sheet-main-A9"')
      .replace('name="样本"', 'name="真实表名"'),
  );
  data = replacePart(data, "xl/_rels/workbook.xml.rels", (xml) =>
    xml.replace('Id="sheet1"', 'Id="sheet-main-A9"'),
  );
  const args = input("A1:C200", data),
    source = targets.createWorkbookRangeFeedbackSource(args)!;
  expect(targets.workbookFeedbackTarget(source)).toMatchObject({
    sheetId: "sheet-main-A9",
    sheetName: "真实表名",
  });
  expect(
    targets.createWorkbookRangeFeedbackSource({
      ...args,
      preview: parseWorkbook(data),
    }),
  ).toBeNull();
  expect(targets.workbookFeedbackTarget(source)).toBeNull(); // mismatched use retires this analysis
});

it.each([
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "sha256",
  "version",
] as const)("rejects mismatched %s in the exact capture", (key) => {
  const args = input();
  args.expectedFile = {
    ...args.expectedFile,
    [key]: key === "size" ? 1 : "changed",
  };
  expect(targets.createWorkbookRangeFeedbackSource(args)).toBeNull();
});

it("does not trust copied summaries, old acknowledgements, or mutated range selections", () => {
  const args = input("A1:AC104", complex());
  args.selection = { ...args.selection, includeHidden: true };
  expect(
    targets.createWorkbookRangeFeedbackSource({
      ...args,
      analysis: { ...args.analysis },
    }),
  ).toBeNull();
  const source = targets.createWorkbookRangeFeedbackSource(args)!;
  args.preview.sheet!.rows[0].hidden = false;
  expect(targets.workbookFeedbackTarget(source)).toBeNull();
  args.preview.sheet!.rows[0].hidden = true;
  expect(targets.createWorkbookRangeFeedbackSource(args)).toBeNull();
  expect(targets.workbookFeedbackTarget(source)).toBeNull();
  const fresh = input();
  const original = targets.createWorkbookRangeFeedbackSource(fresh)!;
  (fresh.selection as { toRow: number }).toRow = 4;
  expect(targets.workbookFeedbackTarget(original)).toBeNull();
  (fresh.selection as { toRow: number }).toRow = 200;
  expect(targets.workbookFeedbackTarget(original)).toBeNull();
});

it.each([
  "sheet",
  "sheets",
  "info",
  "rows",
  "rowObject",
  "columns",
  "columnObject",
  "merges",
  "mergeObject",
  "mergeCoordinates",
  "captureFile",
  "captureVersion",
  "parts",
  "partContent",
  "entries",
  "entryContent",
  "inflated",
  "acknowledgement",
])("retires late callbacks after %s changes", (change) => {
  const args = input("A1:AC104", complex());
  args.selection = { ...args.selection, includeHidden: true };
  const source = targets.createWorkbookRangeFeedbackSource(args)!,
    anchor = targets.workbookFeedbackTarget(source)!;
  const sheet = args.preview.sheet!;
  if (change === "sheet") args.preview.sheet = { ...sheet };
  if (change === "sheets") args.preview.sheets = [...args.preview.sheets];
  if (change === "info") args.preview.sheets[0] = { ...args.preview.sheets[0] };
  if (change === "rows") sheet.rows = [...sheet.rows];
  if (change === "rowObject") sheet.rows[0] = { ...sheet.rows[0] };
  if (change === "columns") sheet.columns = [...sheet.columns];
  if (change === "columnObject") sheet.columns[0] = { ...sheet.columns[0] };
  if (change === "merges") sheet.merges = [...sheet.merges];
  if (change === "mergeObject") sheet.merges[0] = { ...sheet.merges[0] };
  if (change === "mergeCoordinates") sheet.merges[0].toColumn++;
  if (change === "captureFile") args.capture.file = { ...args.capture.file };
  if (change === "captureVersion") args.capture.file.version = "changed";
  if (change === "parts") args.capture.parts = [...args.capture.parts];
  if (change === "partContent") args.capture.parts[0].data += "changed";
  if (change === "entries") args.capture.entries = [...args.capture.entries];
  if (change === "entryContent") args.capture.entries[0] = "changed";
  if (change === "inflated") args.capture.inflatedBytes++;
  if (change === "acknowledgement")
    (args.selection as { includeHidden: boolean }).includeHidden = false;
  expect(targets.workbookFeedbackTarget(source)).toBeNull();
  expect(officeFeedbackTargetMatches({ source, anchor })).toBe(false);
});

it("permanently retires only the exact source, preserving later explicit selection", () => {
  const args = input(),
    first = targets.createWorkbookRangeFeedbackSource(args)!,
    second = targets.createWorkbookRangeFeedbackSource(args)!;
  const anchor = targets.workbookFeedbackTarget(first)!;
  expect(officeFeedbackTargetMatches({ source: { ...first }, anchor })).toBe(
    false,
  );
  retireOfficeFeedbackSource(first);
  retireOfficeFeedbackSource(first);
  expect(officeFeedbackTargetMatches({ source: first, anchor })).toBe(false);
  expect(officeFeedbackTargetMatches({ source: second, anchor })).toBe(true);
  anchor.toRow = 2;
  expect(targets.workbookFeedbackTarget(second)!.toRow).toBe(200);
});

it.each([
  "sparseRows",
  "sparseColumns",
  "sparseMerges",
  "duplicateRow",
  "overlapColumns",
  "invalidMerge",
  "extraMerge",
  "duplicateSheet",
])(
  "rejects malformed %s metadata instead of understating hidden/merged coordinates",
  (change) => {
    const args = input("A1:AC104", complex()),
      sheet = args.preview.sheet!;
    if (change === "sparseRows") delete sheet.rows[0];
    if (change === "sparseColumns") delete sheet.columns[0];
    if (change === "sparseMerges") delete sheet.merges[0];
    if (change === "duplicateRow") sheet.rows.push(sheet.rows[0]);
    if (change === "overlapColumns")
      sheet.columns.push({ min: 4, max: 10, hidden: true });
    if (change === "invalidMerge") sheet.merges[0].toColumn = 16385;
    if (change === "extraMerge")
      Object.assign(sheet.merges[0], { changed: true });
    if (change === "duplicateSheet")
      args.preview.sheets.push(args.preview.sheets[0]);
    expect(
      analyzeWorkbookFeedbackRange({
        preview: args.preview,
        range: args.analysis.range,
      }),
    ).toBeNull();
  },
);

it("rejects over-budget metadata before allocating a snapshot", () => {
  const args = input();
  args.preview.sheet!.rows = new Array(100001);
  expect(
    analyzeWorkbookFeedbackRange({
      preview: args.preview,
      range: args.analysis.range,
    }),
  ).toBeNull();
});

it("freezes analytical coordinates and does not turn detached/cold data into live proof", () => {
  const args = input();
  expect(Object.isFrozen(args.analysis)).toBe(true);
  expect(Object.isFrozen(args.analysis.range)).toBe(true);
  expect(
    workbookFeedbackRangeAnalysisIsCurrent(
      JSON.parse(JSON.stringify(args.analysis)),
      args.preview,
      args.analysis.range,
    ),
  ).toBe(false);
  expect(
    workbookFeedbackRangeAnalysisIsCurrent(
      args.analysis,
      args.preview,
      args.analysis.range,
    ),
  ).toBe(true);
  expect(
    analyzeWorkbookFeedbackRange({
      preview: null as unknown as WorkbookPreview,
      range: args.analysis.range,
    }),
  ).toBeNull();
});

it("rejects extra keys even when an inherited coordinate keeps property count unchanged", () => {
  const range = Object.assign(Object.create({ fromRow: 1 }), {
    toRow: 2,
    fromColumn: 1,
    toColumn: 2,
    unknown: true,
  });
  expect(validWorkbookFeedbackRange(range)).toBe(false);
  const args = input();
  args.selection = Object.assign(Object.create({ fromRow: 1 }), {
    toRow: 200,
    fromColumn: 1,
    toColumn: 3,
    includeHidden: false,
    unknown: true,
  });
  expect(targets.createWorkbookRangeFeedbackSource(args)).toBeNull();
});

it.each(["Z101:AC103", "A1:XFD1048576"])(
  "round-trips %s as only historical coordinates without expanding merges or persisting acknowledgement",
  (address) => {
    const args = input(address, complex());
    args.selection = { ...args.selection, includeHidden: true };
    const source = targets.createWorkbookRangeFeedbackSource(args)!;
    const context = {
      path: args.expectedFile.path,
      contentId: `disk:${JSON.stringify([args.expectedFile.path, args.expectedFile.version, args.expectedFile.sha256])}`,
      scope: "file" as const,
      selection: null,
      lineInput: undefined,
    };
    const original = targets.workbookFeedbackTarget(source)!;
    const cold = parseFeedbackAnchor(
      JSON.parse(JSON.stringify(original)),
      context,
    )!;
    expect(cold).toEqual(original);
    const serialized = JSON.stringify(cold);
    expect(serialized).not.toMatch(
      /includeHidden|analysis|preview|capture|PRIVATE_HIDDEN_VALUE/,
    );
    const formatted = fileFeedbackText({
      ...context,
      anchor: cold,
      text: "  preserve this opinion\n",
    });
    expect(formatted).toContain(address);
    expect(formatted).toContain("位置未重新核对");
    expect(formatted).toContain("  preserve this opinion\n");
    expect(() =>
      parseFeedbackAnchor({ ...cold, includeHidden: true }, context),
    ).toThrow();
    expect(
      targets.workbookFeedbackSourceIsValid(JSON.parse(JSON.stringify(source))),
    ).toBe(false);
  },
);
