import { parseSheet } from "./xlsx_sheet";
import { boolean, attr, child } from "./xlsx_xml";
import {
  XlsxError,
  type WorkbookPreview,
  type XlsxWorkerInput,
} from "./xlsx_types";
import { workbookContext } from "./xlsx_workbook_context";

export function parseWorkbook(input: XlsxWorkerInput): WorkbookPreview {
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
  const selected =
    input.sheetId ??
    sheets.find((s) => s.state === "visible")?.id ??
    sheets[0].id;
  const sheetPart = sheetParts.get(selected);
  if (!sheetPart) throw new XlsxError("invalid");
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
