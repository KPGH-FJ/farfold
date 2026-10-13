import { coordinate } from "./xlsx_sheet";
import {
  XLSX_LIMITS,
  XlsxError,
  type XlsxSheetInfo,
  type XlsxWorkerInput,
} from "./xlsx_types";
import {
  XLSX_INPUT_WARNING_CODES,
  XLSX_INPUT_WARNING_UNITS,
  XLSX_INPUT_INFORMATIONAL_CODES,
  checkedXlsxInputRequest,
  type XlsxInputRequest,
  type XlsxInputResult,
  type XlsxInputScope,
  type XlsxInputWarning,
} from "./xlsx_input_types";
import {
  attr,
  children,
  child,
  parseXml,
  requireRoot,
  PACKAGE_REL_NS,
  REL_NS,
} from "./xlsx_xml";
import { resolveWorkbookPart } from "./xlsx_workbook_context";
function invalid(): never {
  throw new XlsxError("invalid");
}
function obj(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== keys.length ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    invalid();
  return v;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value;
}
function str(
  value: unknown,
  max = XLSX_LIMITS.outputText,
  empty = true,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.length) ||
    value.includes("\0")
  )
    invalid();
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const b = value.charCodeAt(++i);
      if (!(b >= 0xdc00 && b <= 0xdfff)) invalid();
    } else if (n >= 0xdc00 && n <= 0xdfff) invalid();
  }
  return value;
}
function int(value: unknown, min: number, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    invalid();
  return value as number;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}
function nullable(value: unknown): string | null {
  return value === null ? null : str(value);
}
export function checkedXlsxInputScope(value: unknown): XlsxInputScope {
  const v = obj(value, ["mode", "sheetIds"]),
    { mode } = checkedXlsxInputRequest({ mode: v.mode });
  const sheetIds = list(v.sheetIds, XLSX_LIMITS.sheets).map((s) =>
    str(s, 4096, false),
  );
  if (!sheetIds.length || new Set(sheetIds).size !== sheetIds.length) invalid();
  return { mode, sheetIds };
}
export function checkedXlsxInputWarnings(value: unknown): XlsxInputWarning[] {
  let previous = -1;
  return list(value, XLSX_INPUT_WARNING_CODES.length).map((item) => {
    const v = obj(item, ["code", "count"]),
      index = XLSX_INPUT_WARNING_CODES.indexOf(
        v.code as XlsxInputWarning["code"],
      );
    if (index <= previous || index < 0) invalid();
    previous = index;
    const code = XLSX_INPUT_WARNING_CODES[index],
      unit = XLSX_INPUT_WARNING_UNITS[code];
    const max =
      unit === "presence"
        ? 1
        : unit === "parts"
          ? XLSX_LIMITS.parts
          : unit === "cells" || unit === "formulas"
            ? XLSX_LIMITS.cells
            : unit === "categories"
              ? 64
              : XLSX_LIMITS.xmlNodes;
    return { code, count: int(v.count, 1, max) };
  });
}
/** Compare the returned catalog with captured workbook XML, not a UI tab list.
 * Only small package/catalog parts are decoded here; SST/cells stay in Worker. */
export function capturedXlsxCatalog(input: XlsxWorkerInput): XlsxSheetInfo[] {
  const read = (name: string) => {
    const part = input.parts.find((p) => p.name === name);
    if (!part) invalid();
    if (part.data.length > Math.ceil(XLSX_LIMITS.partBytes / 3) * 4)
      throw new XlsxError("limit");
    const raw = atob(part.data);
    return parseXml(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
  };
  const rel = read("_rels/.rels");
  requireRoot(rel, "Relationships", PACKAGE_REL_NS);
  const docs = children(rel, "Relationship").filter(
    (n) => attr(n, "Type") === REL_NS + "/officeDocument",
  );
  if (docs.length !== 1 || attr(docs[0], "TargetMode") === "External")
    invalid();
  const target = attr(docs[0], "Target");
  if (target === undefined) invalid();
  const workbook = read(resolveWorkbookPart("", target));
  requireRoot(workbook, "workbook");
  const nodes = child(workbook, "sheets");
  if (!nodes) invalid();
  return children(nodes, "sheet").map((n) => {
    const id = attr(n, "id", REL_NS),
      raw = attr(n, "name"),
      state = attr(n, "state") ?? "visible";
    if (!id || !raw || !["visible", "hidden", "veryHidden"].includes(state))
      invalid();
    // Name decoding is identical to the parser; never compare encoded labels.
    return {
      id,
      name: decodeName(raw),
      state: state as XlsxSheetInfo["state"],
    };
  });
}
import { xstring as decodeName } from "./xlsx_xstring";

export function checkedXlsxInputResult(
  value: unknown,
  input?: XlsxWorkerInput,
  request?: XlsxInputRequest,
): XlsxInputResult {
  const v = obj(value, [
    "date1904",
    "sheets",
    "scope",
    "selectedSheets",
    "partial",
    "warnings",
  ]);
  const sheets = list(v.sheets, XLSX_LIMITS.sheets).map((item) => {
    const s = obj(item, ["id", "name", "state"]),
      id = str(s.id, 4096, false),
      name = str(s.name, 128, false);
    if (!["visible", "hidden", "veryHidden"].includes(str(s.state, 32, false)))
      invalid();
    return { id, name, state: s.state as XlsxSheetInfo["state"] };
  });
  if (
    !sheets.length ||
    new Set(sheets.map((s) => s.id)).size !== sheets.length ||
    new Set(sheets.map((s) => s.name)).size !== sheets.length
  )
    invalid();
  if (
    input &&
    JSON.stringify(sheets) !== JSON.stringify(capturedXlsxCatalog(input))
  )
    invalid();
  const scope = checkedXlsxInputScope(v.scope);
  if (request && scope.mode !== checkedXlsxInputRequest(request).mode)
    invalid();
  const expectedIds = sheets
    .filter((s) => scope.mode === "all-saved-cells" || s.state === "visible")
    .map((s) => s.id);
  if (JSON.stringify(expectedIds) !== JSON.stringify(scope.sheetIds)) invalid();
  let cells = 0,
    runs = 0,
    textSize = 0,
    merges = 0,
    area = 0;
  const selectedSheets = list(v.selectedSheets, XLSX_LIMITS.sheets).map(
    (item, index) => {
      const s = obj(item, ["id", "cells", "merges", "protection"]);
      if (
        s.id !== expectedIds[index] ||
        !["active", "inactive", "unknown"].includes(
          str(s.protection, 32, false),
        )
      )
        invalid();
      const seen = new Set<string>();
      let prevRow = 0,
        prevCol = 0;
      const parsedCells = list(s.cells, XLSX_LIMITS.cells).map((item) => {
        const c = obj(item, [
          "reference",
          "row",
          "column",
          "styleId",
          "type",
          "rawValue",
          "text",
          "runs",
          "formula",
          "cacheState",
          "visibility",
          "included",
          "covered",
          "display",
          "displayKnown",
        ]);
        const reference = str(c.reference, 10, false),
          point = coordinate(reference);
        if (
          point.row !== c.row ||
          point.column !== c.column ||
          seen.has(reference) ||
          point.row < prevRow ||
          (point.row === prevRow && point.column <= prevCol)
        )
          invalid();
        seen.add(reference);
        prevRow = point.row;
        prevCol = point.column;
        const rawValue = nullable(c.rawValue),
          text = nullable(c.text),
          display = nullable(c.display);
        const parsedRuns = list(c.runs, XLSX_LIMITS.outputRuns).map((r) =>
          str(r),
        );
        if (parsedRuns.length && parsedRuns.join("") !== text) invalid();
        if (
          !["n", "s", "str", "inlineStr", "b", "e", "d"].includes(
            str(c.type, 32, false),
          )
        )
          invalid();
        if (
          !["notFormula", "present", "missing"].includes(
            str(c.cacheState, 32, false),
          ) ||
          !["visible", "hidden", "unknown"].includes(
            str(c.visibility, 32, false),
          )
        )
          invalid();
        const included = bool(c.included),
          covered = bool(c.covered),
          displayKnown = bool(c.displayKnown);
        if (
          included !==
            (scope.mode === "all-saved-cells" ||
              (c.visibility === "visible" && !covered)) ||
          (displayKnown && display === null)
        )
          invalid();
        const formula =
          c.formula === null
            ? null
            : (() => {
                const f = obj(c.formula, ["text", "attributes", "included"]),
                  formulaText = str(f.text);
                if (
                  !f.attributes ||
                  typeof f.attributes !== "object" ||
                  Array.isArray(f.attributes)
                )
                  invalid();
                const entries = Object.entries(f.attributes);
                if (entries.length > XLSX_LIMITS.attributes) invalid();
                const attributes: Record<string, string> = Object.create(null);
                for (const [key, value] of entries) {
                  str(key, 4096, false);
                  attributes[key] = str(value, 4096);
                }
                const formulaIncluded = bool(f.included);
                if (formulaIncluded && !included) invalid();
                if (scope.mode === "all-saved-cells" && !formulaIncluded)
                  invalid();
                return {
                  text: formulaText,
                  attributes,
                  included: formulaIncluded,
                };
              })();
        if (
          c.cacheState !==
          (!formula
            ? "notFormula"
            : rawValue === null || (c.type === "n" && rawValue === "")
              ? "missing"
              : "present")
        )
          invalid();
        if (
          c.type === "s" &&
          (rawValue === null
            ? text !== null
            : !/^\d+$/.test(rawValue) || text === null)
        )
          invalid();
        if (c.type === "inlineStr" && (rawValue !== null || formula)) invalid();
        if (
          c.type === "str" &&
          text !==
            (rawValue === null || c.cacheState === "missing"
              ? null
              : decodeName(rawValue))
        )
          invalid();
        if (
          !["s", "str", "inlineStr"].includes(str(c.type, 32, false)) &&
          (text !== null || parsedRuns.length)
        )
          invalid();
        if (
          c.type === "n" &&
          rawValue !== null &&
          c.cacheState !== "missing" &&
          !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(rawValue)
        )
          invalid();
        if (
          c.type === "b" &&
          rawValue !== null &&
          !["0", "1", "false", "true"].includes(rawValue)
        )
          invalid();
        if (
          c.type === "e" &&
          rawValue !== null &&
          (!/^#[A-Z0-9_/.!?]+$/.test(rawValue) || rawValue.length > 64)
        )
          invalid();
        cells++;
        runs += parsedRuns.length;
        textSize +=
          (rawValue?.length ?? 0) +
          (text?.length ?? 0) +
          (display?.length ?? 0) +
          (formula?.text.length ?? 0) +
          parsedRuns.reduce((n, r) => n + r.length, 0);
        if (
          cells > XLSX_LIMITS.cells ||
          runs > XLSX_LIMITS.outputRuns ||
          textSize > XLSX_LIMITS.outputText
        )
          throw new XlsxError("limit");
        return {
          reference,
          ...point,
          styleId: int(c.styleId, 0, XLSX_LIMITS.styles - 1),
          type: c.type,
          rawValue,
          text,
          runs: parsedRuns,
          formula,
          cacheState: c.cacheState,
          visibility: c.visibility,
          included,
          covered,
          display,
          displayKnown,
        };
      });
      const parsedMerges = list(s.merges, XLSX_LIMITS.merges).map((item) => {
        const m = obj(item, ["fromRow", "toRow", "fromColumn", "toColumn"]),
          fromRow = int(m.fromRow, 1, 1048576),
          toRow = int(m.toRow, fromRow, 1048576),
          fromColumn = int(m.fromColumn, 1, 16384),
          toColumn = int(m.toColumn, fromColumn, 16384);
        merges++;
        area += (toRow - fromRow + 1) * (toColumn - fromColumn + 1);
        if (merges > XLSX_LIMITS.merges || area > XLSX_LIMITS.cells)
          throw new XlsxError("limit");
        return { fromRow, toRow, fromColumn, toColumn };
      });
      for (let i = 0; i < parsedMerges.length; i++) {
        const a = parsedMerges[i];
        if (
          parsedMerges
            .slice(0, i)
            .some(
              (b) =>
                a.fromRow <= b.toRow &&
                b.fromRow <= a.toRow &&
                a.fromColumn <= b.toColumn &&
                b.fromColumn <= a.toColumn,
            )
        )
          invalid();
      }
      for (const c of parsedCells)
        if (
          c.covered !==
          parsedMerges.some(
            (m) =>
              c.row >= m.fromRow &&
              c.row <= m.toRow &&
              c.column >= m.fromColumn &&
              c.column <= m.toColumn &&
              (c.row !== m.fromRow || c.column !== m.fromColumn),
          )
        )
          invalid();
      return {
        id: s.id,
        protection: s.protection,
        cells: parsedCells,
        merges: parsedMerges,
      };
    },
  );
  if (selectedSheets.length !== expectedIds.length) invalid();
  const warnings = checkedXlsxInputWarnings(v.warnings),
    partial = bool(v.partial);
  const count = (code: XlsxInputWarning["code"]) =>
    warnings.find((w) => w.code === code)?.count ?? 0;
  const allCells = selectedSheets.flatMap((s) => s.cells);
  const includedFormulas = allCells.filter((c) => c.included && c.formula);
  if (
    count("savedFormulaCaches") !== includedFormulas.length ||
    count("missingFormulaCaches") !==
      includedFormulas.filter((c) => c.cacheState === "missing").length ||
    count("formulaTextNotStored") !==
      includedFormulas.filter(
        (c) => c.formula!.included && !c.formula!.text.trim(),
      ).length ||
    count("coveredMergeData") !== allCells.filter((c) => c.covered).length ||
    count("numberDisplayUnknown") !==
      allCells.filter(
        (c) =>
          c.included &&
          c.type === "n" &&
          c.rawValue !== null &&
          c.cacheState !== "missing" &&
          !c.displayKnown,
      ).length
  )
    invalid();
  const unknownCells = allCells.filter(
    (c) => c.visibility === "unknown",
  ).length;
  const omittedFormulas = includedFormulas.filter(
    (c) => !c.formula!.included,
  ).length;
  if (
    count("hiddenFormulasOmitted") > omittedFormulas ||
    count("unknownVisibility") !==
      unknownCells + omittedFormulas - count("hiddenFormulasOmitted")
  )
    invalid();
  const knownHiddenCells = allCells.filter(
    (c) => c.visibility === "hidden" && !c.included,
  ).length;
  if (
    count("hiddenCellsOmitted") < knownHiddenCells ||
    (scope.mode === "all-saved-cells" && count("hiddenCellsOmitted") !== 0)
  )
    invalid();
  if (
    partial !==
    warnings.some((w) => !XLSX_INPUT_INFORMATIONAL_CODES.includes(w.code))
  )
    invalid();
  // All strings and numbers were validated; this cast narrows closed enums.
  return {
    date1904: bool(v.date1904),
    sheets,
    scope,
    selectedSheets,
    partial,
    warnings,
  } as XlsxInputResult;
}
