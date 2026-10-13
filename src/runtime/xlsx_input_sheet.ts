import { coordinate, richText } from "./xlsx_sheet";
import { xstring } from "./xlsx_xstring";
import {
  attr,
  boolean,
  child,
  children,
  integer,
  requireRoot,
  type XmlNode,
} from "./xlsx_xml";
import { XLSX_LIMITS, XlsxError } from "./xlsx_types";
import { inputCellDisplay, type FormulaProtection } from "./xlsx_input_styles";
import type { WorkbookContext } from "./xlsx_workbook_context";
import type {
  XlsxInputCell,
  XlsxInputSheet,
  XlsxInputScopeMode,
  XlsxInputWarningCode,
} from "./xlsx_input_types";

export interface InputBudget {
  cells: number;
  rows: number;
  runs: number;
  text: number;
  merges: number;
  mergeArea: number;
}
export type InputWarn = (code: XlsxInputWarningCode, count?: number) => void;
const refFor = (row: number, column: number) => {
  let name = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name + row;
};
export function parseInputSheet(
  root: XmlNode,
  id: string,
  ctx: WorkbookContext,
  mode: XlsxInputScopeMode,
  protectionStyles: FormulaProtection[],
  budget: InputBudget,
  warn: InputWarn,
): XlsxInputSheet {
  requireRoot(root, "worksheet");
  const p = child(root, "sheetProtection"),
    active = p && attr(p, "sheet");
  const protection = !p
    ? "inactive"
    : active === undefined
      ? "unknown"
      : boolean(active)
        ? "active"
        : "inactive";
  const result: XlsxInputSheet = { id, protection, cells: [], merges: [] };
  const cols: { min: number; max: number; hidden: boolean; style: number }[] =
    [];
  for (const c of children(
    child(root, "cols") ?? { ...root, children: [] },
    "col",
  )) {
    const min = integer(attr(c, "min"), 1, 16384),
      max = integer(attr(c, "max"), min, 16384);
    if (cols.length >= 16384 || cols.some((c) => c.min <= max && min <= c.max))
      throw new XlsxError("invalid");
    cols.push({
      min,
      max,
      hidden: boolean(attr(c, "hidden")),
      style: integer(attr(c, "style"), 0, ctx.styles.length - 1, 0),
    });
  }
  const merges = child(root, "mergeCells");
  for (const m of merges ? children(merges, "mergeCell") : []) {
    const parts = attr(m, "ref")?.split(":");
    if (!parts || parts.length !== 2) throw new XlsxError("invalid");
    const a = coordinate(parts[0]),
      b = coordinate(parts[1]);
    if (
      a.row > b.row ||
      a.column > b.column ||
      result.merges.some(
        (m) =>
          m.fromRow <= b.row &&
          a.row <= m.toRow &&
          m.fromColumn <= b.column &&
          a.column <= m.toColumn,
      )
    )
      throw new XlsxError("invalid");
    budget.merges++;
    budget.mergeArea += (b.row - a.row + 1) * (b.column - a.column + 1);
    if (
      budget.merges > XLSX_LIMITS.merges ||
      budget.mergeArea > XLSX_LIMITS.cells
    )
      throw new XlsxError("limit");
    result.merges.push({
      fromRow: a.row,
      toRow: b.row,
      fromColumn: a.column,
      toColumn: b.column,
    });
  }
  const conditional = children(root, "conditionalFormatting");
  if (conditional.length) warn("conditionalFormatting", conditional.length);
  // Bound a rule's recorded range without executing formulas. If its range is
  // not represented safely, every saved cell in that sheet remains uncertain.
  const ranges = conditional.flatMap((n) =>
    (attr(n, "sqref") ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((raw) => {
        try {
          const refs = raw.split(":"),
            a = coordinate(refs[0]),
            b = coordinate(refs[1] ?? refs[0]);
          return refs.length <= 2 && a.row <= b.row && a.column <= b.column
            ? { a, b }
            : null;
        } catch {
          return null;
        }
      }),
  );
  const uncertainRange =
    conditional.some((n) => !(attr(n, "sqref") ?? "").trim()) ||
    ranges.some((r) => !r);
  const simple = new Set([
    "dimension",
    "sheetData",
    "cols",
    "mergeCells",
    "sheetProtection",
    "conditionalFormatting",
    "sheetPr",
    "sheetFormatPr",
    "sheetViews",
  ]);
  const ignored = root.children.filter(
    (n) => n.uri !== root.uri || !simple.has(n.name),
  );
  if (ignored.length) warn("unsupportedContent", ignored.length);
  const data = child(root, "sheetData");
  if (!data) throw new XlsxError("invalid");
  if (data.children.some((n) => n.uri !== data.uri || n.name !== "row"))
    throw new XlsxError("unsupported");
  let previousRow = 0;
  const rows = new Set<number>(),
    ids = new Set<string>();
  for (const row of children(data, "row")) {
    const index = integer(attr(row, "r"), 1, 1048576, previousRow + 1);
    previousRow = index;
    if (rows.has(index)) throw new XlsxError("invalid");
    rows.add(index);
    if (++budget.rows > XLSX_LIMITS.cells) throw new XlsxError("limit");
    const rowHidden = boolean(attr(row, "hidden")),
      rowStyle = boolean(attr(row, "customFormat"))
        ? integer(attr(row, "s"), 0, ctx.styles.length - 1, 0)
        : undefined;
    if (row.children.some((n) => n.uri !== row.uri || n.name !== "c"))
      throw new XlsxError("unsupported");
    let previousColumn = 0;
    for (const c of children(row, "c")) {
      if (++budget.cells > XLSX_LIMITS.cells) throw new XlsxError("limit");
      const ref = attr(c, "r") ?? refFor(index, previousColumn + 1),
        point = coordinate(ref);
      previousColumn = point.column;
      if (point.row !== index || ids.has(ref)) throw new XlsxError("invalid");
      ids.add(ref);
      const col = cols.find(
        (n) => n.min <= point.column && point.column <= n.max,
      );
      const styleId = integer(
        attr(c, "s"),
        0,
        ctx.styles.length - 1,
        rowStyle ?? col?.style ?? 0,
      );
      const type = attr(c, "t") ?? "n",
        f = child(c, "f"),
        v = child(c, "v"),
        inline = child(c, "is");
      if (
        c.text.trim() ||
        c.children.some(
          (n) =>
            n.uri !== c.uri || !["v", "f", "is", "extLst"].includes(n.name),
        )
      )
        throw new XlsxError("unsupported");
      if (f?.children.length || v?.children.length)
        throw new XlsxError("unsupported");
      if (!["n", "s", "inlineStr", "str", "b", "e", "d"].includes(type))
        throw new XlsxError("unsupported");
      if (type === "inlineStr" ? f || v : inline || (type === "s" && f))
        throw new XlsxError("invalid");
      if (child(c, "extLst")) warn("unsupportedContent");
      const raw = v?.text ?? null,
        cacheState = !f
          ? "notFormula"
          : !v || (type === "n" && raw === "")
            ? "missing"
            : "present";
      let text: string | null = null,
        runs: string[] = [];
      if (type === "inlineStr" && inline) {
        const phonetic =
          children(inline, "rPh").length +
          children(inline, "phoneticPr").length;
        if (phonetic) warn("unsupportedContent", phonetic);
        const rich = richText(inline, ctx.themes, ctx.warnings);
        text = rich.text;
        runs = rich.runs?.map((r) => r.text) ?? [];
      } else if (v && cacheState !== "missing") {
        if (type === "s") {
          const rich = ctx.strings[integer(raw!, 0, ctx.strings.length - 1)];
          text = rich.text;
          runs = rich.runs?.map((r) => r.text) ?? [];
        } else if (type === "str") text = xstring(raw!);
        else if (
          type === "n" &&
          !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(raw!)
        )
          throw new XlsxError("invalid");
        else if (type === "b") boolean(raw!);
        else if (
          type === "e" &&
          (!/^#[A-Z0-9_/.!?]+$/.test(raw!) || raw!.length > 64)
        )
          throw new XlsxError("invalid");
        else if (
          type === "d" &&
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/.test(
            raw!,
          )
        )
          throw new XlsxError("invalid");
      }
      const display = inputCellDisplay(
        type,
        raw,
        text,
        ctx.styles[styleId],
        ctx.date1904,
        cacheState === "missing",
      );
      const covered = result.merges.some(
        (m) =>
          point.row >= m.fromRow &&
          point.row <= m.toRow &&
          point.column >= m.fromColumn &&
          point.column <= m.toColumn &&
          (point.row !== m.fromRow || point.column !== m.fromColumn),
      );
      const conditionalUnknown =
        uncertainRange ||
        ranges.some(
          (r) =>
            r &&
            point.row >= r.a.row &&
            point.row <= r.b.row &&
            point.column >= r.a.column &&
            point.column <= r.b.column,
        );
      const visibility =
        rowHidden || col?.hidden || display.visibility === "hidden"
          ? "hidden"
          : conditionalUnknown || display.visibility === "unknown"
            ? "unknown"
            : "visible";
      const included =
        mode === "all-saved-cells" || (visibility === "visible" && !covered);
      const protectedFormula =
        protection === "inactive"
          ? "visible"
          : protection === "unknown"
            ? "unknown"
            : protectionStyles[styleId];
      const formulaIncluded =
        included &&
        (mode === "all-saved-cells" || protectedFormula === "visible");
      if (visibility === "unknown") warn("unknownVisibility");
      if (mode === "visible-saved-cells" && visibility === "hidden")
        warn("hiddenCellsOmitted");
      if (covered) warn("coveredMergeData");
      if (f) {
        if (included) {
          warn("savedFormulaCaches");
          if (cacheState === "missing") warn("missingFormulaCaches");
          if (!f.text.trim() && formulaIncluded) warn("formulaTextNotStored");
        }
        if (
          included &&
          mode === "visible-saved-cells" &&
          protectedFormula !== "visible"
        ) {
          if (protectedFormula === "hidden") warn("hiddenFormulasOmitted");
          else if (visibility !== "unknown") warn("unknownVisibility");
        }
        if (
          (attr(f, "t") && !["normal", "shared"].includes(attr(f, "t")!)) ||
          Object.keys(f.attrs).some(
            (key) =>
              ![
                "t",
                "ref",
                "si",
                "aca",
                "ca",
                "dt2D",
                "dtr",
                "r1",
                "r2",
                "del1",
                "del2",
                "bx",
              ].includes(key),
          )
        )
          warn("unsupportedFormula");
      }
      if (
        included &&
        type === "n" &&
        raw !== null &&
        cacheState !== "missing" &&
        !display.known
      )
        warn("numberDisplayUnknown");
      const cell: XlsxInputCell = {
        reference: ref,
        ...point,
        styleId,
        type: type as XlsxInputCell["type"],
        rawValue: raw,
        text,
        runs,
        formula: f
          ? {
              text: f.text,
              attributes: { ...f.attrs },
              included: formulaIncluded,
            }
          : null,
        cacheState,
        visibility,
        included,
        covered,
        display: display.display,
        displayKnown: display.known,
      };
      budget.runs += runs.length;
      budget.text +=
        (raw?.length ?? 0) +
        (text?.length ?? 0) +
        (f?.text.length ?? 0) +
        (display.display?.length ?? 0) +
        runs.reduce((n, r) => n + r.length, 0);
      if (
        budget.runs > XLSX_LIMITS.outputRuns ||
        budget.text > XLSX_LIMITS.outputText
      )
        throw new XlsxError("limit");
      result.cells.push(cell);
    }
  }
  result.cells.sort((a, b) => a.row - b.row || a.column - b.column);
  return result;
}
