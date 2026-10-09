import type { CSSProperties } from "react";
import type { XlsxCell, XlsxFont, XlsxSheet, XlsxStyle } from "./xlsx_types";

export const WORKBOOK_WINDOW = { rows: 100, columns: 24 } as const;
export const WORKBOOK_MAX = { rows: 1_048_576, columns: 16_384 } as const;
export function columnLabel(column: number): string {
  let value = column,
    label = "";
  while (value > 0) {
    value--;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}
export function cellAddress(row: number, column: number): string {
  return `${columnLabel(column)}${row}`;
}
export function parseCellAddress(
  value: string,
): { row: number; column: number } | null {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value.trim().toUpperCase());
  if (!match) return null;
  let column = 0;
  for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
  const row = Number(match[2]);
  return column <= WORKBOOK_MAX.columns && row <= WORKBOOK_MAX.rows
    ? { row, column }
    : null;
}
export function sheetExtent(sheet: XlsxSheet) {
  let rows = 1,
    columns = 1;
  for (const cell of sheet.cells) {
    rows = Math.max(rows, cell.row);
    columns = Math.max(columns, cell.column);
  }
  for (const row of sheet.rows) rows = Math.max(rows, row.index);
  for (const col of sheet.columns) columns = Math.max(columns, col.max);
  for (const merge of sheet.merges) {
    rows = Math.max(rows, merge.toRow);
    columns = Math.max(columns, merge.toColumn);
  }
  return {
    rows: Math.min(rows, WORKBOOK_MAX.rows),
    columns: Math.min(columns, WORKBOOK_MAX.columns),
  };
}
export interface WorkbookPosition {
  row: number;
  column: number;
  rowSpan: number;
  colSpan: number;
  cell?: XlsxCell;
  merge?: XlsxSheet["merges"][number];
  partial?: boolean;
  hiddenAnchor?: boolean;
}
/** A bounded coordinate window: even the last legal cell does not allocate the
 * preceding empty million rows. Hidden merge anchors never leak their values. */
export function workbookWindow(
  sheet: XlsxSheet,
  cells: ReadonlyMap<string, XlsxCell>,
  start: { row: number; column: number },
  showHidden: boolean,
) {
  const extent = sheetExtent(sheet);
  const firstRow = Math.max(1, Math.min(start.row, WORKBOOK_MAX.rows));
  const firstColumn = Math.max(1, Math.min(start.column, WORKBOOK_MAX.columns));
  const lastRow = Math.min(
    WORKBOOK_MAX.rows,
    Math.max(extent.rows, firstRow),
    firstRow + WORKBOOK_WINDOW.rows - 1,
  );
  const lastColumn = Math.min(
    WORKBOOK_MAX.columns,
    Math.max(extent.columns, firstColumn),
    firstColumn + WORKBOOK_WINDOW.columns - 1,
  );
  const rowMetadata = new Map(sheet.rows.map((row) => [row.index, row]));
  const columnMetadata = (column: number) =>
    sheet.columns.find((col) => column >= col.min && column <= col.max);
  const hiddenRow = (row: number) =>
    !showHidden && Boolean(rowMetadata.get(row)?.hidden);
  const hiddenColumn = (column: number) =>
    !showHidden && Boolean(columnMetadata(column)?.hidden);
  const rows = Array.from(
    { length: lastRow - firstRow + 1 },
    (_, i) => firstRow + i,
  ).filter((row) => !hiddenRow(row));
  const columns = Array.from(
    { length: lastColumn - firstColumn + 1 },
    (_, i) => firstColumn + i,
  ).filter((col) => !hiddenColumn(col));
  const positions = new Map<string, WorkbookPosition | null>();
  for (const merge of sheet.merges) {
    if (
      merge.toRow < firstRow ||
      merge.fromRow > lastRow ||
      merge.toColumn < firstColumn ||
      merge.fromColumn > lastColumn
    )
      continue;
    const mergedRows = rows.filter(
      (row) => row >= merge.fromRow && row <= merge.toRow,
    );
    const mergedColumns = columns.filter(
      (col) => col >= merge.fromColumn && col <= merge.toColumn,
    );
    if (!mergedRows.length || !mergedColumns.length) continue;
    for (const row of mergedRows)
      for (const col of mergedColumns)
        positions.set(cellAddress(row, col), null);
    const row = mergedRows[0],
      column = mergedColumns[0];
    const hiddenAnchor =
      hiddenRow(merge.fromRow) || hiddenColumn(merge.fromColumn);
    positions.set(cellAddress(row, column), {
      row,
      column,
      rowSpan: mergedRows.length,
      colSpan: mergedColumns.length,
      merge,
      cell: hiddenAnchor
        ? undefined
        : cells.get(cellAddress(merge.fromRow, merge.fromColumn)),
      partial:
        merge.fromRow < firstRow ||
        merge.toRow > lastRow ||
        merge.fromColumn < firstColumn ||
        merge.toColumn > lastColumn,
      hiddenAnchor,
    });
  }
  return {
    rows,
    columns,
    rowMetadata,
    columnMetadata,
    extent,
    firstRow,
    firstColumn,
    lastRow,
    lastColumn,
    positions: rows.map((row) =>
      columns.flatMap((column) => {
        const key = cellAddress(row, column);
        if (positions.has(key)) {
          const position = positions.get(key);
          return position ? [position] : [];
        }
        return [{ row, column, rowSpan: 1, colSpan: 1, cell: cells.get(key) }];
      }),
    ),
  };
}
function color(value: string | undefined): string | undefined {
  return value && /^#[a-f\d]{6}$/i.test(value) ? value : undefined;
}
export function workbookFont(font: XlsxFont): CSSProperties {
  return {
    fontFamily: font.name
      ? `"${font.name.replace(/["\\\r\n]/g, "")}", sans-serif`
      : undefined,
    fontSize: font.size
      ? `${Math.max(6, Math.min(font.size, 72))}pt`
      : undefined,
    fontWeight: font.bold === undefined ? undefined : font.bold ? 700 : 400,
    fontStyle:
      font.italic === undefined ? undefined : font.italic ? "italic" : "normal",
    textDecoration:
      font.underline === undefined && font.strike === undefined
        ? undefined
        : [font.underline && "underline", font.strike && "line-through"]
            .filter(Boolean)
            .join(" ") || "none",
    color: color(font.color),
  };
}
export function workbookCellStyle(
  style: XlsxStyle | undefined,
  cell?: XlsxCell,
): CSSProperties {
  if (!style) return {};
  const result: CSSProperties = {
    ...workbookFont(style.font),
    color: color(cell?.displayColor) ?? color(style.font.color),
    backgroundColor: color(style.fill),
    textAlign:
      style.horizontal === "center" ||
      style.horizontal === "right" ||
      style.horizontal === "justify"
        ? style.horizontal
        : style.horizontal === "left"
          ? "left"
          : cell?.type === "number"
            ? "right"
            : undefined,
    verticalAlign:
      style.vertical === "top" || style.vertical === "bottom"
        ? style.vertical
        : "middle",
    whiteSpace: style.wrap ? "pre-wrap" : "pre",
    paddingLeft: style.indent
      ? `${Math.min(style.indent, 16) * 8 + 6}px`
      : undefined,
  };
  for (const side of ["left", "right", "top", "bottom"] as const) {
    const border = style.borders[side];
    if (!border || border.style === "none") continue;
    const width =
      border.style === "thick" ? 3 : /medium|double/.test(border.style) ? 2 : 1;
    const pattern =
      border.style === "double"
        ? "double"
        : /dash/i.test(border.style)
          ? "dashed"
          : border.style === "dotted"
            ? "dotted"
            : "solid";
    const key = `border${side[0].toUpperCase()}${side.slice(1)}` as
      "borderLeft" | "borderRight" | "borderTop" | "borderBottom";
    result[key] = `${width}px ${pattern} ${color(border.color) ?? "#777777"}`;
  }
  return result;
}
