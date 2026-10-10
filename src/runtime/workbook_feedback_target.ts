import type { VerifiedFile } from "./file_delivery";
import { validXlsxRange, type XlsxRangeAnchor } from "./file_feedback_anchor";
import { samePreviewFile } from "./preview_capture";
import {
  WORKBOOK_MAX,
  WORKBOOK_WINDOW,
  type WorkbookPosition,
  type workbookWindow,
} from "./workbook_view";
import {
  XLSX_LIMITS,
  type WorkbookCapture,
  type WorkbookPreview,
  type XlsxSheet,
} from "./xlsx_types";
import {
  workbookFeedbackRangeAnalysisIsCurrent,
  type WorkbookFeedbackRange,
  type WorkbookFeedbackRangeAnalysis,
} from "./workbook_feedback_range";

/** Ephemeral owner identity. This object is never stored in a draft. */
export type WorkbookFeedbackSource = Readonly<{
  kind: "xlsx";
  file: Readonly<VerifiedFile>;
}>;

export interface WorkbookFeedbackSourceInput {
  capture: WorkbookCapture;
  preview: WorkbookPreview;
  window: ReturnType<typeof workbookWindow>;
  position: WorkbookPosition;
  showHidden: boolean;
  /** Explicit selection or already verified restoration of a hidden sheet. */
  hiddenSheetSelected: boolean;
  expectedFile: VerifiedFile;
}

interface PositionRecord {
  mode: "position";
  input: WorkbookFeedbackSourceInput;
  sheet: XlsxSheet;
  captureFile: VerifiedFile;
  anchor: Readonly<XlsxRangeAnchor>;
}
export interface WorkbookRangeSelection extends WorkbookFeedbackRange {
  readonly includeHidden: boolean;
}
export interface WorkbookRangeFeedbackSourceInput {
  capture: WorkbookCapture;
  preview: WorkbookPreview;
  selection: WorkbookRangeSelection;
  analysis: WorkbookFeedbackRangeAnalysis;
  hiddenSheetSelected: boolean;
  expectedFile: VerifiedFile;
}
interface RangeRecord {
  mode: "range";
  input: WorkbookRangeFeedbackSourceInput;
  captureFile: VerifiedFile;
  sheet: XlsxSheet;
  anchor: Readonly<XlsxRangeAnchor>;
  includeHidden: boolean;
  parts: WorkbookCapture["parts"];
  partValues: {
    part: WorkbookCapture["parts"][number];
    name: string;
    data: string;
  }[];
  entries: string[];
  entryValues: string[];
  inflatedBytes: number;
}
type SourceRecord = PositionRecord | RangeRecord;
const sources = new WeakMap<WorkbookFeedbackSource, SourceRecord>();
const fileKeys = [
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "sha256",
  "version",
] as const;

function validFile(file: VerifiedFile): boolean {
  return (
    !!file &&
    typeof file === "object" &&
    !Array.isArray(file) &&
    fileKeys.every(
      (key) =>
        key === "size" ||
        (typeof file[key] === "string" && file[key].length > 0),
    ) &&
    /^[a-f0-9]{64}$/i.test(file.sha256) &&
    Number.isSafeInteger(file.size) &&
    file.size >= 0 &&
    file.size <= 256 * 1024 * 1024
  );
}
function inRange(value: number, first: number, last: number): boolean {
  return Number.isSafeInteger(value) && value >= first && value <= last;
}
function sameAnchor(a: XlsxRangeAnchor, b: XlsxRangeAnchor): boolean {
  return (Object.keys(a) as (keyof XlsxRangeAnchor)[]).every(
    (key) => a[key] === b[key],
  );
}

function coordinates(
  input: WorkbookFeedbackSourceInput,
): XlsxRangeAnchor | null {
  const {
    capture,
    preview,
    expectedFile,
    position,
    window,
    showHidden,
    hiddenSheetSelected,
  } = input;
  if (
    !capture ||
    !validFile(capture.file) ||
    !validFile(expectedFile) ||
    !samePreviewFile(capture.file, expectedFile) ||
    !Array.isArray(capture.parts) ||
    !Array.isArray(capture.entries) ||
    !preview?.sheet ||
    !Array.isArray(preview.sheets) ||
    typeof showHidden !== "boolean" ||
    typeof hiddenSheetSelected !== "boolean" ||
    !position ||
    !window
  )
    return null;
  const sheet = preview.sheet;
  const infos = preview.sheets.filter((info) => info.id === sheet.id);
  if (
    infos.length !== 1 ||
    !["visible", "hidden", "veryHidden"].includes(infos[0].state) ||
    (infos[0].state !== "visible" && !hiddenSheetSelected) ||
    !Array.isArray(sheet.cells) ||
    !Array.isArray(sheet.rows) ||
    !Array.isArray(sheet.columns) ||
    !Array.isArray(sheet.merges) ||
    !Array.isArray(window.rows) ||
    !Array.isArray(window.columns) ||
    !Array.isArray(window.positions) ||
    window.rows.length > WORKBOOK_WINDOW.rows ||
    window.columns.length > WORKBOOK_WINDOW.columns ||
    window.positions.length > WORKBOOK_WINDOW.rows ||
    !window.positions.every(
      (row) => Array.isArray(row) && row.length <= WORKBOOK_WINDOW.columns,
    ) ||
    !window.positions.some((row) => row.includes(position)) ||
    !inRange(window.firstRow, 1, WORKBOOK_MAX.rows) ||
    !inRange(
      window.lastRow,
      window.firstRow,
      Math.min(WORKBOOK_MAX.rows, window.firstRow + WORKBOOK_WINDOW.rows - 1),
    ) ||
    !inRange(window.firstColumn, 1, WORKBOOK_MAX.columns) ||
    !inRange(
      window.lastColumn,
      window.firstColumn,
      Math.min(
        WORKBOOK_MAX.columns,
        window.firstColumn + WORKBOOK_WINDOW.columns - 1,
      ),
    ) ||
    !window.rows.includes(position.row) ||
    !window.columns.includes(position.column) ||
    !inRange(position.row, window.firstRow, window.lastRow) ||
    !inRange(position.column, window.firstColumn, window.lastColumn)
  )
    return null;
  const rowHidden = (row: number) =>
    !showHidden && sheet.rows.some((r) => r.index === row && r.hidden);
  const columnHidden = (column: number) =>
    !showHidden &&
    sheet.columns.some((c) => c.min <= column && column <= c.max && c.hidden);
  if (
    rowHidden(position.row) ||
    columnHidden(position.column) ||
    position.hiddenAnchor
  )
    return null;
  const merge = position.merge;
  const range = merge ?? {
    fromRow: position.row,
    toRow: position.row,
    fromColumn: position.column,
    toColumn: position.column,
  };
  const anchor: XlsxRangeAnchor = {
    kind: "xlsx-range",
    sheetId: sheet.id,
    sheetName: infos[0].name,
    ...range,
  };
  if (!validXlsxRange(anchor)) return null;
  if (merge) {
    if (
      !sheet.merges.includes(merge) ||
      rowHidden(merge.fromRow) ||
      columnHidden(merge.fromColumn)
    )
      return null;
    const rows = window.rows.filter((row) =>
      inRange(row, merge.fromRow, merge.toRow),
    );
    const columns = window.columns.filter((column) =>
      inRange(column, merge.fromColumn, merge.toColumn),
    );
    if (
      position.row !== rows[0] ||
      position.column !== columns[0] ||
      position.rowSpan !== rows.length ||
      position.colSpan !== columns.length
    )
      return null;
  } else if (
    position.rowSpan !== 1 ||
    position.colSpan !== 1 ||
    sheet.merges.some(
      (m) =>
        inRange(position.row, m.fromRow, m.toRow) &&
        inRange(position.column, m.fromColumn, m.toColumn),
    )
  )
    return null;
  const cell = sheet.cells.find(
    (c) => c.row === range.fromRow && c.column === range.fromColumn,
  );
  if (position.cell !== cell) return null;
  return anchor;
}

/** Call with the exact successful capture/parser result and its current selected
 * window position. Checks receipt relationships; cannot authenticate a read or
 * determine whether the caller is still active. The component owns that gate. */
export function createWorkbookFeedbackSource(
  input: WorkbookFeedbackSourceInput,
): WorkbookFeedbackSource | null {
  const anchor = coordinates(input);
  if (!anchor) return null;
  const source: WorkbookFeedbackSource = Object.freeze({
    kind: "xlsx",
    file: Object.freeze(
      Object.fromEntries(
        fileKeys.map((key) => [key, input.capture.file[key]]),
      ) as unknown as VerifiedFile,
    ),
  });
  sources.set(source, {
    mode: "position",
    input: { ...input },
    sheet: input.preview.sheet!,
    captureFile: input.capture.file,
    anchor: Object.freeze(anchor),
  });
  return source;
}

function rangeCoordinates(
  input: WorkbookRangeFeedbackSourceInput,
): XlsxRangeAnchor | null {
  const {
    capture,
    preview,
    expectedFile,
    selection,
    analysis,
    hiddenSheetSelected,
  } = input;
  if (
    !capture ||
    !validFile(capture.file) ||
    !validFile(expectedFile) ||
    !samePreviewFile(capture.file, expectedFile) ||
    !Array.isArray(capture.parts) ||
    capture.parts.length > XLSX_LIMITS.parts ||
    !Array.isArray(capture.entries) ||
    capture.entries.length > XLSX_LIMITS.parts ||
    !Number.isSafeInteger(capture.inflatedBytes) ||
    capture.inflatedBytes < 0 ||
    capture.inflatedBytes > XLSX_LIMITS.bytes ||
    !selection ||
    typeof selection !== "object" ||
    Array.isArray(selection) ||
    Object.keys(selection).length !== 5 ||
    !Object.keys(selection).every((key) =>
      ["fromRow", "toRow", "fromColumn", "toColumn", "includeHidden"].includes(
        key,
      ),
    ) ||
    typeof selection.includeHidden !== "boolean" ||
    typeof hiddenSheetSelected !== "boolean"
  )
    return null;
  for (const part of capture.parts)
    if (!part || typeof part.name !== "string" || typeof part.data !== "string")
      return null;
  for (const name of capture.entries) if (typeof name !== "string") return null;
  const range = {
    fromRow: selection.fromRow,
    toRow: selection.toRow,
    fromColumn: selection.fromColumn,
    toColumn: selection.toColumn,
  };
  if (
    !workbookFeedbackRangeAnalysisIsCurrent(analysis, preview, range) ||
    (analysis.requiresHiddenConfirmation && !selection.includeHidden)
  )
    return null;
  const info = preview.sheets.find((sheet) => sheet.id === analysis.sheetId)!;
  if (info.state !== "visible" && !hiddenSheetSelected) return null;
  const anchor: XlsxRangeAnchor = {
    kind: "xlsx-range",
    sheetId: analysis.sheetId,
    sheetName: analysis.sheetName,
    ...range,
  };
  return validXlsxRange(anchor) ? anchor : null;
}

/** A coordinate declaration on one parsed sheet. It does not imply the entire
 * rectangle was displayed, reveal hidden values, or extend the clicked-cell path. */
export function createWorkbookRangeFeedbackSource(
  input: WorkbookRangeFeedbackSourceInput,
): WorkbookFeedbackSource | null {
  const anchor = rangeCoordinates(input);
  if (!anchor) return null;
  const source: WorkbookFeedbackSource = Object.freeze({
    kind: "xlsx",
    file: Object.freeze(
      Object.fromEntries(
        fileKeys.map((key) => [key, input.capture.file[key]]),
      ) as unknown as VerifiedFile,
    ),
  });
  sources.set(source, {
    mode: "range",
    input: { ...input },
    sheet: input.preview.sheet!,
    captureFile: input.capture.file,
    anchor: Object.freeze(anchor),
    includeHidden: input.selection.includeHidden,
    parts: input.capture.parts,
    partValues: input.capture.parts.map((part) => ({
      part,
      name: part.name,
      data: part.data,
    })),
    entries: input.capture.entries,
    entryValues: [...input.capture.entries],
    inflatedBytes: input.capture.inflatedBytes,
  });
  return source;
}

export function workbookFeedbackTarget(
  source: WorkbookFeedbackSource,
): XlsxRangeAnchor | null {
  const record = sources.get(source);
  if (
    !record ||
    record.input.preview.sheet !== record.sheet ||
    record.input.capture.file !== record.captureFile ||
    !samePreviewFile(source.file, record.captureFile) ||
    !samePreviewFile(source.file, record.input.expectedFile)
  ) {
    sources.delete(source);
    return null;
  }
  if (
    record.mode === "range" &&
    (record.input.selection.includeHidden !== record.includeHidden ||
      record.input.capture.parts !== record.parts ||
      record.input.capture.entries !== record.entries ||
      record.input.capture.inflatedBytes !== record.inflatedBytes ||
      record.parts.length !== record.partValues.length ||
      record.entries.length !== record.entryValues.length ||
      record.parts.some(
        (part, index) =>
          part !== record.partValues[index].part ||
          part.name !== record.partValues[index].name ||
          part.data !== record.partValues[index].data,
      ) ||
      record.entries.some(
        (value, index) => value !== record.entryValues[index],
      ))
  ) {
    sources.delete(source);
    return null;
  }
  const current =
    record.mode === "position"
      ? coordinates(record.input)
      : rangeCoordinates(record.input);
  if (!current || !sameAnchor(current, record.anchor)) sources.delete(source);
  return current && sameAnchor(current, record.anchor)
    ? { ...record.anchor }
    : null;
}

export function workbookFeedbackSourceIsValid(
  source: WorkbookFeedbackSource,
): boolean {
  return workbookFeedbackTarget(source) !== null;
}

/** Idempotent retirement; a new registration must create a new source object. */
export function retireWorkbookFeedbackSource(
  source: WorkbookFeedbackSource,
): void {
  sources.delete(source);
}
