import { expect, it } from "vitest";
import {
  cellAddress,
  parseCellAddress,
  workbookCellStyle,
  workbookFont,
  workbookWindow,
} from "./workbook_view";
import { workbookFailure } from "./workbook_strings";
import { FILE_DELIVERY_STRINGS } from "./file_delivery_strings";
import type { XlsxCell, XlsxSheet } from "./xlsx_types";

function fixture(): XlsxSheet {
  return { id: "first", cells: [], rows: [], columns: [], merges: [] };
}
function cell(row: number, column: number, text: string): XlsxCell {
  return {
    row,
    column,
    reference: cellAddress(row, column),
    styleId: 0,
    type: "text",
    raw: text,
    value: text,
    display: text,
    formulaPresent: false,
    formula: null,
    cacheState: "notFormula",
  };
}
function windowFor(sheet: XlsxSheet, row = 1, column = 1, hidden = false) {
  return workbookWindow(
    sheet,
    new Map(sheet.cells.map((cell) => [cell.reference, cell])),
    { row, column },
    hidden,
  );
}
it("accepts exact legal coordinates and rejects ambiguous or out-of-range positions", () => {
  expect(parseCellAddress(" xfd1048576 ")).toEqual({
    row: 1048576,
    column: 16384,
  });
  expect(cellAddress(1048576, 16384)).toBe("XFD1048576");
  expect(parseCellAddress("AA10")).toEqual({ row: 10, column: 27 });
  for (const value of [
    "A0",
    "A01",
    "XFE1",
    "A1048577",
    "A1:B2",
    "1A",
    "A-1",
    "A1x",
    "A1.2",
  ])
    expect(parseCellAddress(value)).toBeNull();
});
it("keeps a million-row sparse sheet bounded to the visible window", () => {
  const sheet = fixture();
  sheet.cells = [cell(1048576, 16384, "edge")];
  const first = windowFor(sheet);
  expect(first.rows).toHaveLength(100);
  expect(first.columns).toHaveLength(24);
  expect(first.positions.flat()).toHaveLength(2400);
  const last = windowFor(sheet, 1048576, 16384);
  expect(last.positions.flat()).toHaveLength(1);
  expect(last.positions[0][0].cell?.value).toBe("edge");
});
it("clips a merge spanning windows while retaining its source and full extent", () => {
  const sheet = fixture();
  sheet.cells = [cell(99, 23, "merged"), cell(102, 26, "after")];
  sheet.merges = [{ fromRow: 99, toRow: 101, fromColumn: 23, toColumn: 25 }];
  const first = windowFor(sheet)
    .positions.flat()
    .find((p) => p.cell?.value === "merged")!;
  expect(first).toMatchObject({
    row: 99,
    column: 23,
    rowSpan: 2,
    colSpan: 2,
    partial: true,
  });
  const next = windowFor(sheet, 101, 25).positions[0][0];
  expect(next).toMatchObject({
    row: 101,
    column: 25,
    rowSpan: 1,
    colSpan: 1,
    partial: true,
  });
  expect(next.cell?.reference).toBe("W99");
});
it("does not reveal a hidden merge anchor through its visible remainder", () => {
  const sheet = fixture();
  sheet.cells = [cell(1, 1, "hidden value")];
  sheet.rows = [{ index: 1, hidden: true }];
  sheet.columns = [{ min: 1, max: 1, hidden: true }];
  sheet.merges = [{ fromRow: 1, toRow: 3, fromColumn: 1, toColumn: 3 }];
  expect(windowFor(sheet).positions[0][0]).toMatchObject({
    row: 2,
    column: 2,
    rowSpan: 2,
    colSpan: 2,
    hiddenAnchor: true,
    cell: undefined,
  });
  expect(windowFor(sheet, 1, 1, true).positions[0][0].cell?.value).toBe(
    "hidden value",
  );
});
it("removes only hidden coordinates and preserves original header numbers", () => {
  const sheet = fixture();
  sheet.rows = [
    { index: 2, hidden: true },
    { index: 4, hidden: false },
  ];
  sheet.columns = [
    { min: 2, max: 3, hidden: true },
    { min: 4, max: 5, hidden: false },
  ];
  expect(windowFor(sheet).rows).toEqual([1, 3, 4]);
  expect(windowFor(sheet).columns).toEqual([1, 4, 5]);
});
it("handles a completely hidden window without placing invisible merge cells", () => {
  const sheet = fixture();
  sheet.rows = [{ index: 1, hidden: true }];
  sheet.merges = [{ fromRow: 1, toRow: 1, fromColumn: 1, toColumn: 2 }];
  expect(windowFor(sheet).positions).toEqual([]);
});
it("does not insert untrusted CSS values and retains numeric alignment", () => {
  const style = workbookCellStyle(
    {
      numFmt: "General",
      font: { color: "url(https://invalid)", size: 999 },
      borders: { left: { style: "thin", color: "#FF0000" } },
      fill: "red;display:none",
    },
    { ...cell(1, 1, "0"), type: "number" },
  );
  expect(style.backgroundColor).toBeUndefined();
  expect(style.color).toBeUndefined();
  expect(style.fontSize).toBe("72pt");
  expect(style.borderLeft).toBe("1px solid #FF0000");
  expect(style.textAlign).toBe("right");
});
it("only displays allowlisted backend wait notices", () => {
  expect(workbookFailure(FILE_DELIVERY_STRINGS.checkBusy)).toBe(
    FILE_DELIVERY_STRINGS.checkBusy,
  );
  expect(
    workbookFailure(new Error(FILE_DELIVERY_STRINGS.checkWaitExpired)),
  ).toBe(FILE_DELIVERY_STRINGS.checkWaitExpired);
  expect(workbookFailure(new Error("/private/account secret"))).not.toContain(
    "secret",
  );
});
it("preserves explicit rich-run font switches instead of inheriting enabled styles", () => {
  expect(
    workbookFont({
      bold: false,
      italic: false,
      underline: false,
      strike: false,
    }),
  ).toMatchObject({
    fontWeight: 400,
    fontStyle: "normal",
    textDecoration: "none",
  });
  expect(workbookFont({})).toMatchObject({
    fontWeight: undefined,
    fontStyle: undefined,
    textDecoration: undefined,
  });
  expect(workbookFont({ underline: true, strike: false }).textDecoration).toBe(
    "underline",
  );
});
