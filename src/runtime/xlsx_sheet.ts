import { xstring } from "./xlsx_xstring";
import { formatXlsxValue } from "./xlsx_format";
import { font } from "./xlsx_styles";
import {
  attr,
  boolean,
  child,
  children,
  decimal,
  integer,
  requireRoot,
  type XmlNode,
} from "./xlsx_xml";
import {
  XLSX_LIMITS,
  XlsxError,
  type XlsxCell,
  type XlsxSheet,
  type XlsxStyle,
} from "./xlsx_types";

export function coordinate(raw: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(raw);
  if (!match) throw new XlsxError("invalid");
  const column = [...match[1]].reduce(
      (n, c) => n * 26 + c.charCodeAt(0) - 64,
      0,
    ),
    row = Number(match[2]);
  if (column > 16384 || row > 1048576) throw new XlsxError("invalid");
  return { row, column };
}
function reference(row: number, column: number): string {
  let letters = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26))
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters + row;
}
export function richText(
  node: XmlNode,
  themes: (string | undefined)[],
  warnings: Set<string>,
): { text: string; runs?: XlsxCell["runs"] } {
  if (node.text.trim()) throw new XlsxError("invalid");
  if (
    node.children.some(
      (n) =>
        n.uri !== node.uri || !["t", "r", "rPh", "phoneticPr"].includes(n.name),
    )
  )
    throw new XlsxError("unsupported");
  const textValue = (text: XmlNode | undefined) => {
    if (!text) throw new XlsxError("invalid");
    if (text.children.length) throw new XlsxError("unsupported");
    return xstring(text.text);
  };
  const text = child(node, "t"),
    runs = children(node, "r");
  if (text && runs.length) throw new XlsxError("invalid");
  if (children(node, "rPh").length || child(node, "phoneticPr"))
    warnings.add("phoneticText");
  if (text) return { text: textValue(text) };
  const parsed = runs.map((run) => {
    if (
      run.children.some(
        (n) => n.uri !== run.uri || !["t", "rPr"].includes(n.name),
      )
    )
      throw new XlsxError("unsupported");
    return {
      text: textValue(child(run, "t")),
      font: font(child(run, "rPr"), themes, warnings),
    };
  });
  return {
    text: parsed.map((r) => r.text).join(""),
    ...(parsed.length ? { runs: parsed } : {}),
  };
}
export type SharedText = ReturnType<typeof richText>;
function readCell(
  node: XmlNode,
  ref: string,
  styleId: number,
  styles: XlsxStyle[],
  strings: SharedText[],
  themes: (string | undefined)[],
  date1904: boolean,
  warnings: Set<string>,
): XlsxCell {
  if (
    node.children.some(
      (n) => n.uri !== node.uri || !["f", "v", "is", "extLst"].includes(n.name),
    )
  )
    throw new XlsxError("unsupported");
  if (child(node, "extLst")) warnings.add("unsupportedSheetContent");
  const f = child(node, "f"),
    v = child(node, "v"),
    inline = child(node, "is"),
    t = attr(node, "t") ?? "n";
  if (node.text.trim()) throw new XlsxError("invalid");
  if (f?.children.length || v?.children.length)
    throw new XlsxError("unsupported");
  if (!["inlineStr", "s", "str", "n", "b", "e", "d"].includes(t))
    throw new XlsxError("unsupported");
  // Validate the cell shape before the missing-cache early return. An absent
  // result must not conceal conflicting inline text or a malformed formula.
  if (t === "inlineStr" ? f || v : inline || (t === "s" && f))
    throw new XlsxError("invalid");
  const missingCache = !!f && (!v || (t === "n" && v.text === ""));
  const result: XlsxCell = {
    reference: ref,
    ...coordinate(ref),
    styleId,
    type: "blank",
    raw: v?.text ?? null,
    value: null,
    formulaPresent: !!f,
    formula: f?.text.trim() ? f.text : null,
    cacheState: f ? (missingCache ? "missing" : "present") : "notFormula",
    display: "",
  };
  if (f) {
    warnings.add("cachedFormulas");
    if (
      attr(f, "t") &&
      !["normal", "shared", "array", "dataTable"].includes(attr(f, "t")!)
    )
      warnings.add("formulaVariant");
  }
  if (missingCache) {
    result.display = null;
    result.formatIssue = "missingCache";
    return result;
  }
  if (t === "inlineStr") {
    // Ordinary writers can retain an empty inline-typed cell without an is
    // payload. Keep its coordinate/style, without inventing encoded text.
    if (!inline) return result;
    const rich = richText(inline, themes, warnings);
    result.type = "text";
    result.raw = rich.text;
    result.value = rich.text;
    result.runs = rich.runs;
  } else if (!v) return result;
  else if (t === "s") {
    const rich = strings[integer(v.text, 0, strings.length - 1)];
    result.type = "text";
    result.value = rich.text;
    result.runs = rich.runs;
  } else if (t === "str") {
    result.type = "text";
    result.value = xstring(v.text);
  } else if (t === "n") {
    result.type = "number";
    result.value = decimal(v.text);
  } else if (t === "b") {
    result.type = "boolean";
    result.value = boolean(v.text);
  } else if (t === "e") {
    if (!/^#[A-Z0-9_/.!?]+$/.test(v.text) || v.text.length > 64)
      throw new XlsxError("invalid");
    result.type = "error";
    result.value = v.text;
    result.display = v.text;
    return result;
  } else if (t === "d") {
    result.type = "date";
    result.value = v.text;
    result.display = null;
    result.formatIssue = "isoDateValue";
    return result;
  } else throw new XlsxError("unsupported");
  const rendered = formatXlsxValue(
    result.value!,
    styles[styleId].numFmt,
    date1904,
  );
  result.display = rendered.display;
  result.formatIssue = rendered.issue;
  result.displayColor = rendered.color;
  return result;
}
export function parseSheet(
  root: XmlNode,
  id: string,
  styles: XlsxStyle[],
  strings: SharedText[],
  themes: (string | undefined)[],
  date1904: boolean,
  warnings: Set<string>,
): XlsxSheet {
  requireRoot(root, "worksheet");
  const result: XlsxSheet = {
    id,
    cells: [],
    rows: [],
    columns: [],
    merges: [],
  };
  const colStyles: { min: number; max: number; style: number }[] = [];
  const cols = child(root, "cols");
  if (cols)
    for (const col of children(cols, "col")) {
      const min = integer(attr(col, "min"), 1, 16384),
        max = integer(attr(col, "max"), min, 16384);
      if (
        result.columns.length >= 16384 ||
        colStyles.some((c) => c.min <= max && min <= c.max)
      )
        throw new XlsxError("invalid");
      const width = attr(col, "width"),
        style = integer(attr(col, "style"), 0, styles.length - 1, 0);
      result.columns.push({
        min,
        max,
        hidden: boolean(attr(col, "hidden")),
        ...(attr(col, "style") !== undefined ? { styleId: style } : {}),
        ...(width !== undefined ? { width: decimal(width, 0, 255) } : {}),
      });
      colStyles.push({ min, max, style });
      if (
        boolean(attr(col, "bestFit")) ||
        integer(attr(col, "outlineLevel"), 0, 7, 0)
      )
        warnings.add("columnLayout");
    }
  const data = child(root, "sheetData");
  if (!data) throw new XlsxError("invalid");
  let previousRow = 0,
    outputText = 0,
    outputRuns = 0;
  const rowIds = new Set<number>(),
    cellIds = new Set<string>();
  if (data.children.some((n) => n.uri !== data.uri || n.name !== "row"))
    throw new XlsxError("unsupported");
  for (const row of children(data, "row")) {
    if (row.children.some((n) => n.uri !== row.uri || n.name !== "c"))
      throw new XlsxError("unsupported");
    const index = integer(attr(row, "r"), 1, 1048576, previousRow + 1);
    previousRow = index;
    if (rowIds.has(index)) throw new XlsxError("invalid");
    rowIds.add(index);
    if (rowIds.size > XLSX_LIMITS.cells) throw new XlsxError("limit");
    const height = attr(row, "ht"),
      rowStyle = boolean(attr(row, "customFormat"))
        ? integer(attr(row, "s"), 0, styles.length - 1, 0)
        : undefined;
    result.rows.push({
      index,
      hidden: boolean(attr(row, "hidden")),
      ...(rowStyle !== undefined ? { styleId: rowStyle } : {}),
      ...(height !== undefined ? { height: decimal(height, 0, 409) } : {}),
    });
    if (integer(attr(row, "outlineLevel"), 0, 7, 0)) warnings.add("rowOutline");
    let previousColumn = 0;
    for (const c of children(row, "c")) {
      if (result.cells.length >= XLSX_LIMITS.cells)
        throw new XlsxError("limit");
      const ref = attr(c, "r") ?? reference(index, previousColumn + 1),
        coord = coordinate(ref);
      previousColumn = coord.column;
      if (coord.row !== index || cellIds.has(ref))
        throw new XlsxError("invalid");
      cellIds.add(ref);
      const fallback =
        rowStyle ??
        colStyles.find((c) => c.min <= coord.column && coord.column <= c.max)
          ?.style ??
        0;
      const style = integer(attr(c, "s"), 0, styles.length - 1, fallback);
      const cell = readCell(
        c,
        ref,
        style,
        styles,
        strings,
        themes,
        date1904,
        warnings,
      );
      // Count logical expansion, including repeated references to one SST item.
      // Structured clone or a later renderer may materialize each occurrence.
      outputText +=
        (cell.raw?.length ?? 0) +
        (typeof cell.value === "string" ? cell.value.length : 0) +
        (cell.formula?.length ?? 0) +
        (cell.display?.length ?? 0);
      outputRuns += cell.runs?.length ?? 0;
      if (outputRuns > XLSX_LIMITS.outputRuns) throw new XlsxError("limit");
      for (const run of cell.runs ?? [])
        outputText += run.text.length + (run.font?.name?.length ?? 0);
      if (outputText > XLSX_LIMITS.outputText) throw new XlsxError("limit");
      result.cells.push(cell);
    }
  }
  const merges = child(root, "mergeCells");
  let mergeArea = 0;
  if (merges)
    for (const n of children(merges, "mergeCell")) {
      if (result.merges.length >= XLSX_LIMITS.merges)
        throw new XlsxError("limit");
      const refs = attr(n, "ref")?.split(":");
      if (!refs || refs.length !== 2) throw new XlsxError("invalid");
      const a = coordinate(refs[0]),
        b = coordinate(refs[1]);
      if (a.row > b.row || a.column > b.column) throw new XlsxError("invalid");
      mergeArea += (b.row - a.row + 1) * (b.column - a.column + 1);
      if (mergeArea > XLSX_LIMITS.cells) throw new XlsxError("limit");
      if (
        result.merges.some(
          (m) =>
            m.fromRow <= b.row &&
            a.row <= m.toRow &&
            m.fromColumn <= b.column &&
            a.column <= m.toColumn,
        )
      )
        throw new XlsxError("invalid");
      result.merges.push({
        fromRow: a.row,
        toRow: b.row,
        fromColumn: a.column,
        toColumn: b.column,
      });
    }
  const simple = new Set(["dimension", "sheetData", "cols", "mergeCells"]);
  const features: Record<string, string> = {
    sheetPr: "sheetProperties",
    sheetFormatPr: "sheetDefaults",
    sheetViews: "sheetViews",
    conditionalFormatting: "conditionalFormatting",
    dataValidations: "dataValidation",
    hyperlinks: "hyperlinks",
    pageMargins: "printLayout",
    pageSetup: "printLayout",
    printOptions: "printLayout",
    headerFooter: "printLayout",
    rowBreaks: "printLayout",
    colBreaks: "printLayout",
    autoFilter: "autoFilter",
    sheetProtection: "sheetProtection",
    tableParts: "tables",
    drawing: "images",
    legacyDrawing: "embeddedObjects",
  };
  // Unimplemented layout/features are observable, never silently called faithful.
  for (const node of root.children)
    if (node.uri !== root.uri || !simple.has(node.name))
      warnings.add(features[node.name] ?? "unsupportedSheetContent");
  result.cells.sort((a, b) => a.row - b.row || a.column - b.column);
  result.rows.sort((a, b) => a.index - b.index);
  return result;
}
