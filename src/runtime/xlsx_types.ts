import type { VerifiedFile } from "./file_delivery";

export interface WorkbookPart {
  name: string;
  data: string;
}
export interface WorkbookCapture {
  file: VerifiedFile;
  parts: WorkbookPart[];
  entries: string[];
  inflatedBytes: number;
}
export type XlsxFailure =
  | "invalid"
  | "limit"
  | "unsupported"
  | "cancelled"
  | "timeout"
  | "busy"
  | "changed"
  | "unreadable"
  | "encrypted"
  | "readPending"
  | "readBusy";
export class XlsxError extends Error {
  constructor(readonly code: XlsxFailure) {
    super(code);
  }
}
export const XLSX_LIMITS = {
  parts: 2048,
  bytes: 64 * 1024 * 1024,
  partBytes: 16 * 1024 * 1024,
  xmlNodes: 500_000,
  xmlDepth: 64,
  attributes: 64,
  text: 8 * 1024 * 1024,
  sheets: 64,
  cells: 100_000,
  strings: 100_000,
  styles: 4096,
  merges: 4096,
  format: 1024,
  wait: 10_000,
  outputText: 8 * 1024 * 1024,
  outputRuns: 100_000,
} as const;
/** Stable codes only; the UI owns their localized explanations. */
export const XLSX_WARNING_CODES = [
  "automaticColor",
  "unsupportedColor",
  "underlineVariant",
  "fontVerticalAlignment",
  "customIndexedColors",
  "differentialStyles",
  "unknownNumberFormat",
  "patternFill",
  "borderStyle",
  "diagonalBorder",
  "alignment",
  "rotatedText",
  "shrinkToFit",
  "phoneticText",
  "cachedFormulas",
  "formulaVariant",
  "columnLayout",
  "rowOutline",
  "sheetProperties",
  "sheetDefaults",
  "sheetViews",
  "conditionalFormatting",
  "dataValidation",
  "hyperlinks",
  "printLayout",
  "autoFilter",
  "sheetProtection",
  "tables",
  "unsupportedSheetContent",
  "externalRelationships",
  "images",
  "charts",
  "pivotTables",
  "externalLinks",
  "embeddedObjects",
  "macrosNotExecuted",
  "recalculationRequested",
] as const;
export interface XlsxFont {
  name?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
}
export interface XlsxBorder {
  style: string;
  color?: string;
}
export interface XlsxStyle {
  numFmt: string;
  font: XlsxFont;
  fill?: string;
  borders: Partial<Record<"left" | "right" | "top" | "bottom", XlsxBorder>>;
  horizontal?: "left" | "center" | "right" | "justify" | "fill" | "distributed";
  vertical?: "top" | "center" | "bottom" | "justify" | "distributed";
  wrap?: boolean;
  shrink?: boolean;
  indent?: number;
  rotation?: number;
}
export interface XlsxCell {
  reference: string;
  row: number;
  column: number;
  styleId: number;
  type: "number" | "text" | "boolean" | "error" | "date" | "blank";
  raw: string | null;
  value: string | number | boolean | null;
  formulaPresent: boolean;
  formula: string | null;
  cacheState: "notFormula" | "present" | "missing";
  display: string | null;
  formatIssue?: string;
  displayColor?: string;
  runs?: { text: string; font?: XlsxFont }[];
}
export interface XlsxSheetInfo {
  id: string;
  name: string;
  state: "visible" | "hidden" | "veryHidden";
}
/** A validated choice directory, not a successful selected-sheet preview. */
export interface WorkbookDirectory {
  sheets: XlsxSheetInfo[];
  selectedId: string;
}
export interface XlsxSheet {
  id: string;
  cells: XlsxCell[];
  rows: { index: number; height?: number; hidden: boolean; styleId?: number }[];
  columns: {
    min: number;
    max: number;
    width?: number;
    hidden: boolean;
    styleId?: number;
  }[];
  merges: {
    fromRow: number;
    toRow: number;
    fromColumn: number;
    toColumn: number;
  }[];
}
export interface WorkbookPreview {
  date1904: boolean;
  sheets: XlsxSheetInfo[];
  styles: XlsxStyle[];
  sheet: XlsxSheet | null;
  warnings: string[];
}
export interface XlsxWorkerInput {
  parts: WorkbookPart[];
  entries: string[];
  sheetId?: string;
}
