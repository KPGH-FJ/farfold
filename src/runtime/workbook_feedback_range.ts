import { validXlsxRange } from "./file_feedback_anchor";
import { cellAddress, parseCellAddress, WORKBOOK_MAX } from "./workbook_view";
import {
  XLSX_LIMITS,
  type WorkbookPreview,
  type XlsxSheet,
} from "./xlsx_types";

export interface WorkbookFeedbackRange {
  readonly fromRow: number;
  readonly toRow: number;
  readonly fromColumn: number;
  readonly toColumn: number;
}
export interface WorkbookHiddenSpan {
  readonly from: number;
  readonly to: number;
}
export interface WorkbookFeedbackRangeAnalysis {
  readonly range: WorkbookFeedbackRange;
  readonly sheetId: string;
  readonly sheetName: string;
  readonly hiddenRows: readonly WorkbookHiddenSpan[];
  readonly hiddenColumns: readonly WorkbookHiddenSpan[];
  readonly hiddenRowCount: number;
  readonly hiddenColumnCount: number;
  readonly partialMerges: readonly WorkbookFeedbackRange[];
  readonly requiresHiddenConfirmation: boolean;
}

const rangeKeys = ["fromRow", "toRow", "fromColumn", "toColumn"] as const;
export function validWorkbookFeedbackRange(
  value: unknown,
): value is WorkbookFeedbackRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const range = value as WorkbookFeedbackRange;
  return (
    Object.keys(range).length === 4 &&
    Object.keys(range).every((key) =>
      rangeKeys.includes(key as (typeof rangeKeys)[number]),
    ) &&
    rangeKeys.every((key) => Number.isSafeInteger(range[key])) &&
    range.fromRow >= 1 &&
    range.toRow >= range.fromRow &&
    range.toRow <= WORKBOOK_MAX.rows &&
    range.fromColumn >= 1 &&
    range.toColumn >= range.fromColumn &&
    range.toColumn <= WORKBOOK_MAX.columns
  );
}
export function sameWorkbookFeedbackRange(
  a: WorkbookFeedbackRange,
  b: WorkbookFeedbackRange,
): boolean {
  return rangeKeys.every((key) => a[key] === b[key]);
}
/** A single current-sheet address, never a formula, sheet prefix, or multi-range. */
export function parseWorkbookFeedbackRange(
  value: string,
): WorkbookFeedbackRange | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const raw = value.trim();
  if (
    !/^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$/.test(
      raw,
    )
  )
    return null;
  const [first, last = first] = raw.split(":");
  const a = parseCellAddress(first),
    b = parseCellAddress(last);
  if (!a || !b) return null;
  return Object.freeze({
    fromRow: Math.min(a.row, b.row),
    toRow: Math.max(a.row, b.row),
    fromColumn: Math.min(a.column, b.column),
    toColumn: Math.max(a.column, b.column),
  });
}
export function workbookFeedbackRangeAddress(
  range: WorkbookFeedbackRange,
): string {
  if (!validWorkbookFeedbackRange(range)) return "";
  const first = cellAddress(range.fromRow, range.fromColumn),
    last = cellAddress(range.toRow, range.toColumn);
  return first === last ? first : `${first}:${last}`;
}
function overlaps(a: WorkbookFeedbackRange, b: WorkbookFeedbackRange): boolean {
  return (
    a.fromRow <= b.toRow &&
    b.fromRow <= a.toRow &&
    a.fromColumn <= b.toColumn &&
    b.fromColumn <= a.toColumn
  );
}
function contains(a: WorkbookFeedbackRange, b: WorkbookFeedbackRange): boolean {
  return (
    a.fromRow <= b.fromRow &&
    a.toRow >= b.toRow &&
    a.fromColumn <= b.fromColumn &&
    a.toColumn >= b.toColumn
  );
}
function coalesce(spans: WorkbookHiddenSpan[]): readonly WorkbookHiddenSpan[] {
  spans.sort((a, b) => a.from - b.from);
  const result: { from: number; to: number }[] = [];
  for (const span of spans) {
    const last = result.at(-1);
    if (last && span.from <= last.to + 1) last.to = Math.max(last.to, span.to);
    else result.push({ ...span });
  }
  return Object.freeze(result.map((span) => Object.freeze(span)));
}

interface Metadata {
  sheet: XlsxSheet;
  info: WorkbookPreview["sheets"][number];
  signature: string;
}
/** Only bounded coordinates/visibility metadata is inspected, never cell values. */
function metadata(preview: WorkbookPreview): Metadata | null {
  const sheet = preview?.sheet;
  if (
    !sheet ||
    !Array.isArray(preview.sheets) ||
    preview.sheets.length > XLSX_LIMITS.sheets ||
    !Array.isArray(sheet.rows) ||
    sheet.rows.length > XLSX_LIMITS.cells ||
    !Array.isArray(sheet.columns) ||
    sheet.columns.length > WORKBOOK_MAX.columns ||
    !Array.isArray(sheet.merges) ||
    sheet.merges.length > XLSX_LIMITS.merges ||
    !Array.isArray(sheet.cells) ||
    sheet.cells.length > XLSX_LIMITS.cells
  )
    return null;
  const ids = new Set<string>();
  for (const info of preview.sheets) {
    if (
      !info ||
      typeof info.id !== "string" ||
      ids.has(info.id) ||
      !["visible", "hidden", "veryHidden"].includes(info.state) ||
      !validXlsxRange({
        kind: "xlsx-range",
        sheetId: info.id,
        sheetName: info.name,
        fromRow: 1,
        toRow: 1,
        fromColumn: 1,
        toColumn: 1,
      })
    )
      return null;
    ids.add(info.id);
  }
  const info = preview.sheets.find((entry) => entry.id === sheet.id);
  if (!info) return null;
  const rowIds = new Set<number>();
  const rowData: number[][] = [];
  for (const row of sheet.rows) {
    if (
      !row ||
      !Number.isSafeInteger(row.index) ||
      row.index < 1 ||
      row.index > WORKBOOK_MAX.rows ||
      typeof row.hidden !== "boolean" ||
      rowIds.has(row.index)
    )
      return null;
    rowIds.add(row.index);
    rowData.push([row.index, Number(row.hidden)]);
  }
  const columnData: number[][] = [];
  for (const column of sheet.columns) {
    if (
      !column ||
      !Number.isSafeInteger(column.min) ||
      !Number.isSafeInteger(column.max) ||
      column.min < 1 ||
      column.max < column.min ||
      column.max > WORKBOOK_MAX.columns ||
      typeof column.hidden !== "boolean"
    )
      return null;
    columnData.push([column.min, column.max, Number(column.hidden)]);
  }
  const sortedColumns = [...columnData].sort((a, b) => a[0] - b[0]);
  if (
    sortedColumns.some(
      (column, index) => index > 0 && column[0] <= sortedColumns[index - 1][1],
    )
  )
    return null;
  const mergeData: number[][] = [];
  for (const merge of sheet.merges) {
    if (!validWorkbookFeedbackRange(merge)) return null;
    mergeData.push(rangeKeys.map((key) => merge[key]));
  }
  return {
    sheet,
    info,
    signature: JSON.stringify([
      preview.sheets.map((s) => [s.id, s.name, s.state]),
      rowData,
      columnData,
      mergeData,
    ]),
  };
}

interface AnalysisRecord {
  preview: WorkbookPreview;
  sheet: XlsxSheet;
  sheets: WorkbookPreview["sheets"];
  info: Metadata["info"];
  cells: XlsxSheet["cells"];
  rows: XlsxSheet["rows"];
  columns: XlsxSheet["columns"];
  merges: XlsxSheet["merges"];
  rowObjects: XlsxSheet["rows"];
  columnObjects: XlsxSheet["columns"];
  mergeObjects: XlsxSheet["merges"];
  signature: string;
}
const analyses = new WeakMap<WorkbookFeedbackRangeAnalysis, AnalysisRecord>();

/** Describes coordinates, not visibility/content proof or an Agent permission. */
export function analyzeWorkbookFeedbackRange({
  preview,
  range,
}: {
  preview: WorkbookPreview;
  range: WorkbookFeedbackRange;
}): WorkbookFeedbackRangeAnalysis | null {
  if (!validWorkbookFeedbackRange(range)) return null;
  const parsed = metadata(preview);
  if (!parsed) return null;
  const { sheet, info } = parsed;
  const hiddenRows = coalesce(
    sheet.rows
      .filter(
        (row) =>
          row.hidden && row.index >= range.fromRow && row.index <= range.toRow,
      )
      .map((row) => ({ from: row.index, to: row.index })),
  );
  const hiddenColumns = coalesce(
    sheet.columns
      .filter(
        (column) =>
          column.hidden &&
          column.min <= range.toColumn &&
          column.max >= range.fromColumn,
      )
      .map((column) => ({
        from: Math.max(column.min, range.fromColumn),
        to: Math.min(column.max, range.toColumn),
      })),
  );
  const partialMerges = Object.freeze(
    sheet.merges
      .filter((merge) => overlaps(range, merge) && !contains(range, merge))
      .map((merge) => Object.freeze({ ...merge })),
  );
  const count = (spans: readonly WorkbookHiddenSpan[]) =>
    spans.reduce((sum, span) => sum + span.to - span.from + 1, 0);
  const analysis = Object.freeze({
    range: Object.freeze({ ...range }),
    sheetId: sheet.id,
    sheetName: info.name,
    hiddenRows,
    hiddenColumns,
    hiddenRowCount: count(hiddenRows),
    hiddenColumnCount: count(hiddenColumns),
    partialMerges,
    requiresHiddenConfirmation:
      hiddenRows.length > 0 || hiddenColumns.length > 0,
  });
  analyses.set(analysis, {
    preview,
    sheet,
    sheets: preview.sheets,
    info,
    cells: sheet.cells,
    rows: sheet.rows,
    columns: sheet.columns,
    merges: sheet.merges,
    rowObjects: [...sheet.rows],
    columnObjects: [...sheet.columns],
    mergeObjects: [...sheet.merges],
    signature: parsed.signature,
  });
  return analysis;
}

/** An acknowledgement uses the exact prior analysis, not a copied summary or a
 * recomputed analysis after its visibility metadata changed. Failure retires it. */
export function workbookFeedbackRangeAnalysisIsCurrent(
  analysis: WorkbookFeedbackRangeAnalysis,
  preview: WorkbookPreview,
  range: WorkbookFeedbackRange,
): boolean {
  const record = analyses.get(analysis);
  if (!record) return false;
  const parsed = metadata(preview);
  const sameObjects = (
    current: readonly unknown[],
    saved: readonly unknown[],
  ) =>
    current.length === saved.length &&
    current.every((value, index) => value === saved[index]);
  const valid =
    !!parsed &&
    record.preview === preview &&
    record.sheet === parsed.sheet &&
    record.sheets === preview.sheets &&
    record.info === parsed.info &&
    record.cells === parsed.sheet.cells &&
    record.rows === parsed.sheet.rows &&
    record.columns === parsed.sheet.columns &&
    record.merges === parsed.sheet.merges &&
    sameObjects(parsed.sheet.rows, record.rowObjects) &&
    sameObjects(parsed.sheet.columns, record.columnObjects) &&
    sameObjects(parsed.sheet.merges, record.mergeObjects) &&
    parsed.signature === record.signature &&
    validWorkbookFeedbackRange(range) &&
    sameWorkbookFeedbackRange(analysis.range, range);
  if (!valid) analyses.delete(analysis);
  return valid;
}
