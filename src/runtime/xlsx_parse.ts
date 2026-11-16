import { parseSheet } from "./xlsx_sheet";
import { boolean, attr, child } from "./xlsx_xml";
import {
  XlsxError,
  type WorkbookPreview,
  type WorkbookDirectory,
  type XlsxWorkerInput,
} from "./xlsx_types";
import { workbookContext } from "./xlsx_workbook_context";
import {
  checkedWorkbookSheetRestore,
  selectedWorkbookSheetId,
} from "./xlsx_directory";

export function parseWorkbook(
  input: XlsxWorkerInput,
  onDirectory?: (directory: WorkbookDirectory) => void,
): WorkbookPreview {
  const {
    entries,
    relations,
    warnings,
    workbook,
    sheetParts,
    sheets,
    date1904,
    styles,
    strings,
    themes,
    read,
  } = workbookContext(input);
  const selected = selectedWorkbookSheetId(
    sheets,
    input.sheetId,
    checkedWorkbookSheetRestore(input.restoreSheet),
  );
  if (!selected) throw new XlsxError("invalid");
  const sheetPart = sheetParts.get(selected);
  if (!sheetPart) throw new XlsxError("invalid");
  // Global package, directory and shared metadata have passed. A bad sheet
  // may still fail below; these choices never declare its content ready.
  onDirectory?.({
    sheets: sheets.map((sheet) => ({ ...sheet })),
    selectedId: selected,
  });
  // Relationships are checked even though no links or embedded assets are opened.
  relations(sheetPart);
  const sheet = parseSheet(
    read(sheetPart),
    selected,
    styles,
    strings,
    themes,
    date1904,
    warnings,
  );
  for (const name of entries) {
    const feature = name
      .split("/")
      .find((p) =>
        [
          "media",
          "charts",
          "pivotTables",
          "pivotCache",
          "externalLinks",
          "embeddings",
          "activeX",
        ].includes(p),
      );
    if (feature)
      warnings.add(
        (
          {
            media: "images",
            charts: "charts",
            pivotTables: "pivotTables",
            pivotCache: "pivotTables",
            externalLinks: "externalLinks",
            embeddings: "embeddedObjects",
            activeX: "embeddedObjects",
          } as Record<string, string>
        )[feature],
      );
    if (/vbaProject|macrosheets/i.test(name)) warnings.add("macrosNotExecuted");
  }
  const calc = child(workbook, "calcPr");
  if (
    calc &&
    (boolean(attr(calc, "fullCalcOnLoad")) ||
      boolean(attr(calc, "forceFullCalc")) ||
      attr(calc, "calcMode") === "manual")
  )
    warnings.add("recalculationRequested");
  return { date1904, sheets, styles, sheet, warnings: [...warnings] };
}
