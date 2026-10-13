import { XLSX_LIMITS, XlsxError } from "./xlsx_types";
import type { XlsxInputResult, XlsxInputWarning } from "./xlsx_input_types";

export interface XlsxSearchLocation {
  readonly kind: "xlsx";
  readonly sheetId: string;
  readonly sheetName: string;
  readonly reference: string;
  readonly row: number;
  readonly column: number;
  readonly field: "value" | "savedCache" | "formula";
}
export interface XlsxSearchScope {
  readonly mode: "visible-saved-cells";
  readonly partial: boolean;
  readonly warnings: readonly XlsxInputWarning[];
}
export interface XlsxSearchText {
  readonly segments: readonly Readonly<{
    text: string;
    location: XlsxSearchLocation;
  }>[];
  readonly bytes: number;
  readonly workbook: XlsxSearchScope;
}

/** Project checked saved cells, never formatted display, labels or calculated values. */
export function xlsxSearchText(input: XlsxInputResult): XlsxSearchText {
  if (input.scope.mode !== "visible-saved-cells")
    throw new XlsxError("invalid");
  if (
    input.scope.sheetIds.length !== input.selectedSheets.length ||
    new Set(input.scope.sheetIds).size !== input.scope.sheetIds.length ||
    input.scope.sheetIds.some(
      (id, index) => input.selectedSheets[index].id !== id,
    )
  )
    throw new XlsxError("invalid");
  const segments: { text: string; location: XlsxSearchLocation }[] = [];
  const encoder = new TextEncoder();
  let bytes = 0,
    chars = 0;
  for (const sheet of input.selectedSheets) {
    const catalog = input.sheets.filter((s) => s.id === sheet.id);
    if (
      catalog.length !== 1 ||
      catalog[0].state !== "visible" ||
      !input.scope.sheetIds.includes(sheet.id)
    )
      throw new XlsxError("invalid");
    for (const cell of sheet.cells) {
      if (!cell.included) continue;
      if (cell.visibility !== "visible" || cell.covered)
        throw new XlsxError("invalid");
      const add = (text: string | null, field: XlsxSearchLocation["field"]) => {
        // Empty and absent saved values are distinct in the checked model;
        // neither creates searchable characters or a synthetic placeholder.
        if (text === null || text === "") return;
        if (
          /\u0000|[\uD800-\uDFFF]/u.test(
            text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
          )
        )
          throw new XlsxError("invalid");
        chars += text.length;
        if (
          chars > XLSX_LIMITS.text ||
          segments.length >= XLSX_LIMITS.cells * 2
        )
          throw new XlsxError("limit");
        bytes += encoder.encode(text).length;
        segments.push(
          Object.freeze({
            text,
            location: Object.freeze({
              kind: "xlsx",
              sheetId: sheet.id,
              sheetName: catalog[0].name,
              reference: cell.reference,
              row: cell.row,
              column: cell.column,
              field,
            }),
          }),
        );
      };
      if (cell.cacheState !== "missing") {
        add(
          ["s", "str", "inlineStr"].includes(cell.type)
            ? cell.text
            : cell.rawValue,
          cell.formula ? "savedCache" : "value",
        );
      }
      // A shared-formula follower can have no stored expression. Do not expand
      // it, prepend '=', or join a formula with its cache or another cell.
      if (cell.formula?.included) add(cell.formula.text, "formula");
    }
  }
  return Object.freeze({
    segments: Object.freeze(segments),
    bytes,
    workbook: Object.freeze({
      mode: "visible-saved-cells",
      partial: input.partial,
      warnings: Object.freeze(
        input.warnings.map((w) => Object.freeze({ ...w })),
      ),
    }),
  });
}
