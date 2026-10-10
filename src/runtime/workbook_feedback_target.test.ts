import { expect, it } from "vitest";
import type { VerifiedFile } from "./file_delivery";
import {
  officeFeedbackSourceIsValid,
  officeFeedbackTargetMatches,
  retireOfficeFeedbackSource,
} from "./office_feedback_target";
import {
  createWorkbookFeedbackSource,
  workbookFeedbackTarget,
  type WorkbookFeedbackSourceInput,
} from "./workbook_feedback_target";
import { workbookWindow } from "./workbook_view";
import { replacePart, workbookFixture } from "./xlsx_fixture";
import { parseWorkbook } from "./xlsx_parse";
import type { XlsxWorkerInput } from "./xlsx_types";

const file = (): VerifiedFile => ({
  root: "/work",
  path: "/work/sheet.xlsx",
  resolvedPath: "/work/sheet.xlsx",
  name: "sheet.xlsx",
  size: 9000,
  sha256: "b".repeat(64),
  version: "v1",
});
const ordinary = () =>
  workbookFixture(
    '<row r="1"><c r="A1"><v>0</v></c><c r="B1" t="b"><v>0</v></c><c r="C1"><f>1+1</f></c><c r="E1" t="inlineStr"><is><t>text</t></is></c></row>',
  );
function input(
  data = ordinary(),
  start = { row: 1, column: 1 },
  showHidden = false,
): WorkbookFeedbackSourceInput {
  const preview = parseWorkbook(data);
  const sheet = preview.sheet!;
  const window = workbookWindow(
    sheet,
    new Map(sheet.cells.map((c) => [c.reference, c])),
    start,
    showHidden,
  );
  const expectedFile = file();
  return {
    preview,
    window,
    position: window.positions.flat()[0],
    showHidden,
    hiddenSheetSelected: false,
    expectedFile,
    capture: { ...data, file: { ...expectedFile }, inflatedBytes: 20000 },
  };
}
function hiddenSheet(data: XlsxWorkerInput, state: string) {
  return replacePart(data, "xl/workbook.xml", (xml) =>
    xml.replace('r:id="sheet1"', `r:id="sheet1" state="${state}"`),
  );
}

it("uses the actual nonordinal relationship identity and name, not an index", () => {
  let data = replacePart(ordinary(), "xl/workbook.xml", (xml) =>
    xml
      .replace('r:id="sheet1"', 'r:id="sheet-main.内容"')
      .replace('name="样本"', 'name="同内容第二表"'),
  );
  data = replacePart(data, "xl/_rels/workbook.xml.rels", (xml) =>
    xml.replace('Id="sheet1"', 'Id="sheet-main.内容"'),
  );
  const args = input(data);
  const source = createWorkbookFeedbackSource(args)!;
  expect(workbookFeedbackTarget(source)).toEqual({
    kind: "xlsx-range",
    sheetId: "sheet-main.内容",
    sheetName: "同内容第二表",
    fromRow: 1,
    toRow: 1,
    fromColumn: 1,
    toColumn: 1,
  });
  expect(source.file).toEqual(args.capture.file);
  expect(Object.keys(source)).toEqual(["kind", "file"]);
  expect(Object.isFrozen(source)).toBe(true);
  expect(Object.isFrozen(source.file)).toBe(true);
});

it.each([1, 2, 3, 4])(
  "coordinates column %i without inventing cached or empty values",
  (column) => {
    const args = input();
    args.position = args.window.positions
      .flat()
      .find((p) => p.column === column)!;
    const source = createWorkbookFeedbackSource(args)!;
    const anchor = workbookFeedbackTarget(source)!;
    expect(anchor.fromColumn).toBe(column);
    expect(anchor).not.toHaveProperty("value");
    expect(anchor).not.toHaveProperty("text");
  },
);

it("retains the complete merge when only its clipped last row/column is shown", () => {
  const args = input(
    workbookFixture('<row r="99"><c r="W99"><v>9</v></c></row>', {
      extra: '<mergeCells><mergeCell ref="W99:Y101"/></mergeCells>',
    }),
    { row: 101, column: 25 },
  );
  expect(args.position.partial).toBe(true);
  const source = createWorkbookFeedbackSource(args)!;
  expect(workbookFeedbackTarget(source)).toMatchObject({
    fromRow: 99,
    toRow: 101,
    fromColumn: 23,
    toColumn: 25,
  });
});

it("rejects a hidden merge anchor until hidden rows/columns are explicitly visible", () => {
  const data = workbookFixture(
    '<row r="1" hidden="1"><c r="A1"><v>7</v></c></row>',
    {
      extra: '<mergeCells><mergeCell ref="A1:C3"/></mergeCells>',
      before: '<cols><col min="1" max="1" hidden="1"/></cols>',
    },
  );
  const hidden = input(data);
  expect(hidden.position.hiddenAnchor).toBe(true);
  expect(createWorkbookFeedbackSource(hidden)).toBeNull();
  const visible = input(data, { row: 1, column: 1 }, true);
  expect(
    workbookFeedbackTarget(createWorkbookFeedbackSource(visible)!),
  ).toMatchObject({ fromRow: 1, toRow: 3, fromColumn: 1, toColumn: 3 });
});

it.each(["hidden", "veryHidden"])(
  "requires an explicit %s sheet choice independently of showHidden",
  (state) => {
    const args = input(hiddenSheet(ordinary(), state));
    expect(createWorkbookFeedbackSource(args)).toBeNull();
    expect(
      createWorkbookFeedbackSource({ ...args, showHidden: true }),
    ).toBeNull();
    expect(
      createWorkbookFeedbackSource({ ...args, hiddenSheetSelected: true }),
    ).not.toBeNull();
  },
);

it.each([
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "sha256",
  "version",
] as const)("rejects capture/expected %s mismatch", (key) => {
  const args = input();
  args.expectedFile = {
    ...args.expectedFile,
    [key]: key === "size" ? 99 : "different",
  };
  expect(createWorkbookFeedbackSource(args)).toBeNull();
});

it("rejects copied positions, foreign cells and copied merges even when coordinates match", () => {
  const args = input();
  expect(
    createWorkbookFeedbackSource({ ...args, position: { ...args.position } }),
  ).toBeNull();
  args.position.cell = { ...args.position.cell! };
  expect(createWorkbookFeedbackSource(args)).toBeNull();
  const merged = input(
    workbookFixture('<row r="1"><c r="A1"><v>1</v></c></row>', {
      extra: '<mergeCells><mergeCell ref="A1:B2"/></mergeCells>',
    }),
  );
  merged.position.merge = { ...merged.position.merge! };
  expect(createWorkbookFeedbackSource(merged)).toBeNull();
});

it("retires one selected-position identity permanently without retiring another", () => {
  const args = input();
  const first = createWorkbookFeedbackSource(args)!;
  const same = createWorkbookFeedbackSource(args)!;
  const anchor = workbookFeedbackTarget(first)!;
  expect(officeFeedbackTargetMatches({ source: first, anchor })).toBe(true);
  expect(officeFeedbackSourceIsValid({ ...first })).toBe(false);
  retireOfficeFeedbackSource(first);
  retireOfficeFeedbackSource(first);
  expect(workbookFeedbackTarget(first)).toBeNull();
  expect(officeFeedbackTargetMatches({ source: first, anchor })).toBe(false);
  expect(officeFeedbackSourceIsValid(same)).toBe(true);
  // A new effect setup owns a new source; the old StrictMode cleanup cannot retire it.
  const replay = createWorkbookFeedbackSource(args)!;
  retireOfficeFeedbackSource(same);
  expect(officeFeedbackSourceIsValid(replay)).toBe(true);
});

it("matches only exact coordinates and returns detached anchor copies", () => {
  const source = createWorkbookFeedbackSource(input())!;
  const anchor = workbookFeedbackTarget(source)!;
  expect(
    officeFeedbackTargetMatches({ source, anchor: { ...anchor, toColumn: 2 } }),
  ).toBe(false);
  expect(
    officeFeedbackTargetMatches({
      source,
      anchor: { ...anchor, value: 0 } as typeof anchor,
    }),
  ).toBe(false);
  anchor.sheetName = "changed";
  expect(workbookFeedbackTarget(source)!.sheetName).toBe("样本");
});

it.each([
  "capture",
  "fileVersion",
  "expected",
  "sheet",
  "sheetName",
  "position",
  "window",
  "merge",
])("invalidates a previously registered source after %s mutation", (change) => {
  const args = input(
    workbookFixture('<row r="1"><c r="A1"><v>1</v></c></row>', {
      extra: '<mergeCells><mergeCell ref="A1:B2"/></mergeCells>',
    }),
  );
  const source = createWorkbookFeedbackSource(args)!;
  expect(officeFeedbackSourceIsValid(source)).toBe(true);
  if (change === "capture") args.capture.file = { ...args.capture.file };
  if (change === "fileVersion") args.capture.file.version = "v2";
  if (change === "expected") args.expectedFile.sha256 = "d".repeat(64);
  if (change === "sheet") args.preview.sheet = { ...args.preview.sheet! };
  if (change === "sheetName") args.preview.sheets[0].name = "renamed";
  if (change === "position") args.position.row = 2;
  if (change === "window") args.window.positions = [];
  if (change === "merge") args.position.merge!.toRow = 3;
  expect(officeFeedbackSourceIsValid(source)).toBe(false);
  expect(source.file.version).toBe("v1");
});

it("keeps the last legal sparse cell bounded without allocating preceding rows", () => {
  const args = input(
    workbookFixture('<row r="1048576"><c r="XFD1048576"><v>1</v></c></row>'),
    { row: 1048576, column: 16384 },
  );
  expect(args.window.positions.flat()).toHaveLength(1);
  expect(
    workbookFeedbackTarget(createWorkbookFeedbackSource(args)!),
  ).toMatchObject({
    fromRow: 1048576,
    toRow: 1048576,
    fromColumn: 16384,
    toColumn: 16384,
  });
});

it("keeps identical cell values in distinct actual sheets separate", () => {
  let data = replacePart(ordinary(), "xl/workbook.xml", (xml) =>
    xml.replace(
      "</sheets>",
      '<sheet name="第二张同值表" sheetId="7" r:id="rel_17"/></sheets>',
    ),
  );
  data = replacePart(data, "xl/_rels/workbook.xml.rels", (xml) =>
    xml.replace(
      "</Relationships>",
      '<Relationship Id="rel_17" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    ),
  );
  data = {
    ...data,
    entries: [...data.entries, "xl/worksheets/sheet2.xml"],
    parts: [
      ...data.parts,
      {
        ...data.parts.find((p) => p.name === "xl/worksheets/sheet1.xml")!,
        name: "xl/worksheets/sheet2.xml",
      },
    ],
  };
  const first = createWorkbookFeedbackSource(input(data))!;
  const second = createWorkbookFeedbackSource(
    input({ ...data, sheetId: "rel_17" }),
  )!;
  const a = workbookFeedbackTarget(first)!,
    b = workbookFeedbackTarget(second)!;
  expect(a.fromRow).toBe(b.fromRow);
  expect(a.fromColumn).toBe(b.fromColumn);
  expect(a.sheetId).toBe("sheet1");
  expect(b.sheetId).toBe("rel_17");
  expect(b.sheetName).toBe("第二张同值表");
  expect(officeFeedbackTargetMatches({ source: first, anchor: b })).toBe(false);
});

it("rejects ambiguous or absent selected sheet-directory identity", () => {
  const args = input();
  args.preview.sheets.push({ ...args.preview.sheets[0] });
  expect(createWorkbookFeedbackSource(args)).toBeNull();
  args.preview.sheets = [];
  expect(createWorkbookFeedbackSource(args)).toBeNull();
});
