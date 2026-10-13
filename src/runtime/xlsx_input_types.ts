import {
  XlsxError,
  type XlsxFailure,
  type XlsxSheetInfo,
  type XlsxWorkerInput,
} from "./xlsx_types";

export type XlsxInputScopeMode = "visible-saved-cells" | "all-saved-cells";
export interface XlsxInputRequest {
  mode: XlsxInputScopeMode;
}
export interface XlsxInputScope extends XlsxInputRequest {
  sheetIds: string[];
}
export type XlsxInputFailure = XlsxFailure | "scopeEmpty";
export class XlsxInputError extends Error {
  constructor(readonly code: XlsxInputFailure) {
    super(code);
  }
}
export const XLSX_INPUT_WARNING_CODES = [
  "hiddenCellsOmitted",
  "hiddenFormulasOmitted",
  "unknownVisibility",
  "coveredMergeData",
  "savedFormulaCaches",
  "missingFormulaCaches",
  "formulaTextNotStored",
  "unsupportedFormula",
  "numberDisplayUnknown",
  "styleDisplayUnknown",
  "conditionalFormatting",
  "definedNames",
  "drawings",
  "images",
  "charts",
  "pivotTables",
  "externalContent",
  "unsupportedContent",
  "unsupportedAssets",
  "macrosNotExecuted",
  "recalculationRequested",
] as const;
export type XlsxInputWarningCode = (typeof XLSX_INPUT_WARNING_CODES)[number];
export interface XlsxInputWarning {
  code: XlsxInputWarningCode;
  count: number;
}
/** A count is never a guessed number of objects hidden inside an unread part. */
export const XLSX_INPUT_WARNING_UNITS: Record<
  XlsxInputWarningCode,
  "cells" | "formulas" | "categories" | "elements" | "parts" | "presence"
> = {
  hiddenCellsOmitted: "cells",
  hiddenFormulasOmitted: "formulas",
  unknownVisibility: "cells",
  coveredMergeData: "cells",
  savedFormulaCaches: "formulas",
  missingFormulaCaches: "formulas",
  formulaTextNotStored: "formulas",
  unsupportedFormula: "formulas",
  numberDisplayUnknown: "cells",
  styleDisplayUnknown: "categories",
  conditionalFormatting: "elements",
  definedNames: "elements",
  drawings: "parts",
  images: "parts",
  charts: "parts",
  pivotTables: "parts",
  externalContent: "presence",
  unsupportedContent: "elements",
  unsupportedAssets: "parts",
  macrosNotExecuted: "parts",
  recalculationRequested: "presence",
};
export const XLSX_INPUT_INFORMATIONAL_CODES: readonly XlsxInputWarningCode[] = [
  "savedFormulaCaches",
  "recalculationRequested",
];
export type XlsxInputCellType =
  "n" | "s" | "inlineStr" | "str" | "b" | "e" | "d";
export interface XlsxInputCell {
  reference: string;
  row: number;
  column: number;
  styleId: number;
  type: XlsxInputCellType;
  /** Original v lexeme, not Number(value); null differs from an empty v. */
  rawValue: string | null;
  /** Decoded authored text for string types, never a shared-string index. */
  text: string | null;
  runs: string[];
  formula: null | {
    text: string;
    attributes: Record<string, string>;
    included: boolean;
  };
  cacheState: "notFormula" | "present" | "missing";
  visibility: "visible" | "hidden" | "unknown";
  included: boolean;
  covered: boolean;
  display: string | null;
  displayKnown: boolean;
}
export interface XlsxInputSheet {
  id: string;
  cells: XlsxInputCell[];
  merges: {
    fromRow: number;
    toRow: number;
    fromColumn: number;
    toColumn: number;
  }[];
  protection: "active" | "inactive" | "unknown";
}
export interface XlsxInputResult {
  date1904: boolean;
  sheets: XlsxSheetInfo[];
  scope: XlsxInputScope;
  selectedSheets: XlsxInputSheet[];
  partial: boolean;
  warnings: XlsxInputWarning[];
}
export interface XlsxInputWorkerInput extends XlsxWorkerInput {
  kind: "input";
  request: XlsxInputRequest;
}
export function checkedXlsxInputRequest(value: unknown): XlsxInputRequest {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("mode" in value) ||
    typeof value.mode !== "string" ||
    !["visible-saved-cells", "all-saved-cells"].includes(value.mode)
  )
    throw new XlsxError("invalid");
  return { mode: value.mode as XlsxInputScopeMode };
}
