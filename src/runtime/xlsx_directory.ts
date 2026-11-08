import {
  XLSX_LIMITS,
  XlsxError,
  type WorkbookDirectory,
  type XlsxSheetInfo,
} from "./xlsx_types";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Same directory/selection semantics as the real global workbook parser. */
export function checkedWorkbookDirectory(
  value: unknown,
  requestedId?: string,
): WorkbookDirectory {
  if (
    !record(value) ||
    !exact(value, ["sheets", "selectedId"]) ||
    !Array.isArray(value.sheets) ||
    !value.sheets.length ||
    value.sheets.length > XLSX_LIMITS.sheets ||
    typeof value.selectedId !== "string"
  )
    throw new XlsxError("invalid");
  const ids = new Set<string>();
  const names = new Set<string>();
  const sheets: XlsxSheetInfo[] = value.sheets.map((sheet) => {
    if (
      !record(sheet) ||
      !exact(sheet, ["id", "name", "state"]) ||
      typeof sheet.id !== "string" ||
      !sheet.id ||
      ids.has(sheet.id) ||
      typeof sheet.name !== "string" ||
      !sheet.name ||
      sheet.name.length > 128 ||
      names.has(sheet.name) ||
      typeof sheet.state !== "string" ||
      !["visible", "hidden", "veryHidden"].includes(sheet.state)
    )
      throw new XlsxError("invalid");
    ids.add(sheet.id);
    names.add(sheet.name);
    return {
      id: sheet.id,
      name: sheet.name,
      state: sheet.state as XlsxSheetInfo["state"],
    };
  });
  const selected =
    requestedId ??
    sheets.find((sheet) => sheet.state === "visible")?.id ??
    sheets[0].id;
  if (value.selectedId !== selected || !ids.has(selected))
    throw new XlsxError("invalid");
  return { sheets, selectedId: selected };
}
