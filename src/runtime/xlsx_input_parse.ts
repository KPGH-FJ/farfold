import { workbookContext } from "./xlsx_workbook_context";
import { inputFormulaProtection } from "./xlsx_input_styles";
import { parseInputSheet, type InputBudget } from "./xlsx_input_sheet";
import { attr, boolean, child, children, requireRoot } from "./xlsx_xml";
import { XLSX_LIMITS, XlsxError, type XlsxWorkerInput } from "./xlsx_types";
import {
  checkedXlsxInputRequest,
  XLSX_INPUT_WARNING_CODES,
  XLSX_INPUT_INFORMATIONAL_CODES,
  XlsxInputError,
  type XlsxInputRequest,
  type XlsxInputResult,
  type XlsxInputWarningCode,
} from "./xlsx_input_types";

/** One captured archive, one XML/SST/style context, one aggregate budget. */
export function parseWorkbookInput(
  input: XlsxWorkerInput,
  request: XlsxInputRequest,
): XlsxInputResult {
  const { mode } = checkedXlsxInputRequest(request),
    ctx = workbookContext(input, true);
  const selected = ctx.sheets.filter(
    (s) => mode === "all-saved-cells" || s.state === "visible",
  );
  if (!selected.length) throw new XlsxInputError("scopeEmpty");
  const counts = new Map<XlsxInputWarningCode, number>();
  const warn = (code: XlsxInputWarningCode, count = 1) => {
    const next = (counts.get(code) ?? 0) + count;
    if (!Number.isSafeInteger(next) || next < 1 || next > XLSX_LIMITS.xmlNodes)
      throw new XlsxError("limit");
    counts.set(code, next);
  };
  const budget: InputBudget = {
    cells: 0,
    rows: 0,
    runs: 0,
    text: 0,
    merges: 0,
    mergeArea: 0,
  };
  const protection = inputFormulaProtection(ctx.styleRoot, ctx.styles.length);
  const selectedSheets = selected.map((s) => {
    const part = ctx.sheetParts.get(s.id)!;
    if (ctx.relations(part).some((r) => r.external))
      counts.set("externalContent", 1);
    return parseInputSheet(
      ctx.read(part),
      s.id,
      ctx,
      mode,
      protection,
      budget,
      warn,
    );
  });
  // Hidden names/body do not enter the delivered text. Only the number of
  // saved cell elements excluded by the explicit default scope is recorded.
  if (mode === "visible-saved-cells")
    for (const s of ctx.sheets.filter((s) => s.state !== "visible")) {
      const root = ctx.read(ctx.sheetParts.get(s.id)!);
      requireRoot(root, "worksheet");
      const data = child(root, "sheetData");
      if (!data) throw new XlsxError("invalid");
      let count = 0;
      for (const row of children(data, "row"))
        count += children(row, "c").length;
      if (count) warn("hiddenCellsOmitted", count);
    }
  const names = child(ctx.workbook, "definedNames");
  const nameCount = names ? children(names, "definedName").length : 0;
  if (nameCount) warn("definedNames", nameCount);
  const supportedWorkbook = new Set([
    "workbookPr",
    "sheets",
    "definedNames",
    "calcPr",
    "bookViews",
    "fileVersion",
  ]);
  const extra = ctx.workbook.children.filter(
    (n) => n.uri !== ctx.workbook.uri || !supportedWorkbook.has(n.name),
  );
  if (extra.length) warn("unsupportedContent", extra.length);
  for (const name of ctx.entries) {
    if (name.endsWith("/")) continue;
    const dirs = name.split("/").slice(0, -1);
    if (dirs.includes("media")) warn("images");
    if (dirs.includes("drawings") && !dirs.includes("_rels")) warn("drawings");
    if (dirs.includes("charts") && !dirs.includes("_rels")) warn("charts");
    if (
      (dirs.includes("pivotTables") || dirs.includes("pivotCache")) &&
      !dirs.includes("_rels")
    )
      warn("pivotTables");
    if (dirs.includes("externalLinks")) counts.set("externalContent", 1);
    if (/vbaProject|macrosheets/i.test(name)) warn("macrosNotExecuted");
    if (
      dirs.some((d) => ["embeddings", "activeX"].includes(d)) &&
      !dirs.includes("_rels")
    )
      warn("unsupportedAssets");
    if (
      /\/comments[^/]*\.xml$/.test(name) ||
      (dirs.includes("threadedComments") && name.endsWith(".xml"))
    ) {
      const root = ctx.read(name);
      const features =
        root.name === "comments"
          ? (child(root, "commentList")?.children.length ?? 0)
          : root.children.length;
      if (features) warn("unsupportedContent", features);
      else warn("unsupportedAssets");
    }
  }
  // Verify relationships in the captured package without fetching any target.
  for (const part of ctx.entries)
    if (part.endsWith(".rels")) {
      const match = /^(.*\/)?_rels\/([^/]*)\.rels$/.exec(part);
      if (!match) throw new XlsxError("invalid");
      const source = (match[1] ?? "") + match[2];
      const relations = ctx.relations(source);
      if (relations.some((r) => !r.external && !ctx.entries.has(r.target)))
        throw new XlsxError("invalid");
      if (relations.some((r) => r.external)) counts.set("externalContent", 1);
    }
  const calc = child(ctx.workbook, "calcPr");
  if (
    calc &&
    (boolean(attr(calc, "fullCalcOnLoad")) ||
      boolean(attr(calc, "forceFullCalc")) ||
      attr(calc, "calcMode") === "manual")
  )
    warn("recalculationRequested");
  const styleCategories = [...ctx.warnings].filter(
    (code) =>
      !["cachedFormulas", "externalRelationships", "phoneticText"].includes(
        code,
      ),
  );
  if (styleCategories.length)
    warn("styleDisplayUnknown", styleCategories.length);
  if (ctx.sharedRoot) {
    const count = children(ctx.sharedRoot, "si").reduce(
      (n, si) =>
        n + children(si, "rPh").length + children(si, "phoneticPr").length,
      0,
    );
    if (count) warn("unsupportedContent", count);
  }
  const warnings = XLSX_INPUT_WARNING_CODES.filter((code) =>
    counts.has(code),
  ).map((code) => ({ code, count: counts.get(code)! }));
  return {
    date1904: ctx.date1904,
    sheets: ctx.sheets,
    scope: { mode, sheetIds: selected.map((s) => s.id) },
    selectedSheets,
    partial: warnings.some(
      (w) => !XLSX_INPUT_INFORMATIONAL_CODES.includes(w.code),
    ),
    warnings,
  };
}
