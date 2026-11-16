import {
  XLSX_LIMITS,
  XlsxError,
  type WorkbookDirectory,
  type WorkbookSheetRestore,
  type XlsxSheetInfo,
} from "./xlsx_types";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function checkedWorkbookSheetRestore(
  value: unknown,
): WorkbookSheetRestore | undefined {
  if (value === undefined) return undefined;
  if (
    !record(value) ||
    !Object.hasOwn(value, "id") ||
    !Object.hasOwn(value, "name") ||
    Object.keys(value).some(
      (key) => !["id", "name", "hiddenSelected"].includes(key),
    ) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.name !== "string" ||
    !value.name ||
    value.name.length > 128 ||
    (Object.hasOwn(value, "hiddenSelected") &&
      typeof value.hiddenSelected !== "boolean")
  )
    throw new XlsxError("invalid");
  return {
    id: value.id,
    name: value.name,
    ...(Object.hasOwn(value, "hiddenSelected") &&
    typeof value.hiddenSelected === "boolean"
      ? { hiddenSelected: value.hiddenSelected }
      : {}),
  };
}

/** A recycled ID alone cannot borrow an old page; hidden pages need the saved
 * explicit choice. Reading position never changes a version-bound opinion. */
export function restoredWorkbookSheetId(
  sheets: XlsxSheetInfo[],
  restore?: WorkbookSheetRestore,
): string | undefined {
  if (!restore) return undefined;
  const sheet =
    sheets.find(
      (item) => item.id === restore.id && item.name === restore.name,
    ) ?? sheets.find((item) => item.name === restore.name);
  return sheet && (sheet.state === "visible" || restore.hiddenSelected === true)
    ? sheet.id
    : undefined;
}

export function selectedWorkbookSheetId(
  sheets: XlsxSheetInfo[],
  requestedId?: string,
  restore?: WorkbookSheetRestore,
): string | undefined {
  return (
    requestedId ??
    restoredWorkbookSheetId(sheets, restore) ??
    sheets.find((sheet) => sheet.state === "visible")?.id ??
    sheets[0]?.id
  );
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
  restore?: WorkbookSheetRestore,
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
  const selected = selectedWorkbookSheetId(sheets, requestedId, restore);
  if (!selected || value.selectedId !== selected || !ids.has(selected))
    throw new XlsxError("invalid");
  return { sheets, selectedId: selected };
}
