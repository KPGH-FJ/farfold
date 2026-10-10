import { MAX_PDF_PAGES } from "./visual_preview";
import { isDocxSourcePosition } from "./docx_source_position";
import {
  validVisualAreaRect,
  type VisualAreaRect,
} from "./visual_area_coordinates";

export type PdfPageAnchor = {
  kind: "pdf-page";
  page: number;
  pageCount: number;
};

/** Historical coordinates only; this shape never proves a current disk read. */
export type TextRangeAnchor = {
  kind: "text-range";
  byteStart: number;
  byteEnd: number;
  startLine: number;
  endLine: number;
};

/** One cell or a whole merge in the workbook version saved with the opinion. */
export type XlsxRangeAnchor = {
  kind: "xlsx-range";
  sheetId: string;
  sheetName: string;
  fromRow: number;
  toRow: number;
  fromColumn: number;
  toColumn: number;
};

/** A whole source block in the document version saved with the opinion. */
export type DocxBlockAnchor = {
  kind: "docx-block";
  part: string;
  elementPath: readonly number[];
  blockKind: "paragraph" | "table";
};

/** Historical displayed coordinates; never original PDF/JPEG internal axes. */
export type ImageAreaAnchor = VisualAreaRect & {
  kind: "image-area";
  space: "display-oriented-v1";
};
export type PdfAreaAnchor = VisualAreaRect & {
  kind: "pdf-area";
  space: "display-oriented-v1";
  page: number;
  pageCount: number;
};

export type FileFeedbackAnchor =
  | PdfPageAnchor
  | TextRangeAnchor
  | XlsxRangeAnchor
  | DocxBlockAnchor
  | ImageAreaAnchor
  | PdfAreaAnchor;

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

export function validVisualAreaAnchor(
  value: unknown,
): value is ImageAreaAnchor | PdfAreaAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as ImageAreaAnchor | PdfAreaAnchor;
  const keys = ["kind", "space", "left", "top", "right", "bottom"];
  return (
    (a.kind === "image-area" || a.kind === "pdf-area") &&
    exactKeys(
      a,
      a.kind === "pdf-area" ? [...keys, "page", "pageCount"] : keys,
    ) &&
    a.space === "display-oriented-v1" &&
    validVisualAreaRect({
      left: a.left,
      top: a.top,
      right: a.right,
      bottom: a.bottom,
    }) &&
    (a.kind === "image-area" || validPdfPage(a.page, a.pageCount))
  );
}

export function validDocxBlock(value: unknown): value is DocxBlockAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as DocxBlockAnchor;
  return (
    exactKeys(a, ["kind", "part", "elementPath", "blockKind"]) &&
    a.kind === "docx-block" &&
    (a.blockKind === "paragraph" || a.blockKind === "table") &&
    isDocxSourcePosition({ part: a.part, elementPath: a.elementPath })
  );
}

export function validXlsxRange(value: unknown): value is XlsxRangeAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as XlsxRangeAnchor;
  return (
    exactKeys(a, [
      "kind",
      "sheetId",
      "sheetName",
      "fromRow",
      "toRow",
      "fromColumn",
      "toColumn",
    ]) &&
    a.kind === "xlsx-range" &&
    typeof a.sheetId === "string" &&
    a.sheetId.length > 0 &&
    a.sheetId.length <= 4096 &&
    typeof a.sheetName === "string" &&
    a.sheetName.length > 0 &&
    a.sheetName.length <= 128 &&
    [a.fromRow, a.toRow, a.fromColumn, a.toColumn].every(
      Number.isSafeInteger,
    ) &&
    a.fromRow >= 1 &&
    a.toRow >= a.fromRow &&
    a.toRow <= 1_048_576 &&
    a.fromColumn >= 1 &&
    a.toColumn >= a.fromColumn &&
    a.toColumn <= 16_384
  );
}

export function validTextRange(value: unknown): value is TextRangeAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as TextRangeAnchor;
  return (
    exactKeys(a, ["kind", "byteStart", "byteEnd", "startLine", "endLine"]) &&
    a.kind === "text-range" &&
    [a.byteStart, a.byteEnd, a.startLine, a.endLine].every(
      Number.isSafeInteger,
    ) &&
    a.byteStart >= 0 &&
    a.byteEnd > a.byteStart &&
    a.byteEnd <= 256 * 1024 * 1024 &&
    a.startLine >= 1 &&
    a.startLine <= a.byteStart + 1 &&
    a.endLine >= a.startLine &&
    a.endLine - a.startLine < a.byteEnd - a.byteStart
  );
}

/** Decode only the existing checked disk identity, never file contents. */
export function feedbackDiskVersion(path: string, contentId?: string) {
  if (!contentId?.startsWith("disk:")) return null;
  try {
    const value: unknown = JSON.parse(contentId.slice(5));
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      value[0] !== path ||
      typeof value[1] !== "string" ||
      !value[1] ||
      typeof value[2] !== "string" ||
      !/^[a-f0-9]{64}$/i.test(value[2])
    )
      return null;
    return { version: value[1], sha256: value[2] };
  } catch {
    return null;
  }
}

export function validPdfPage(page: unknown, pageCount: unknown): boolean {
  return (
    Number.isSafeInteger(page) &&
    Number.isSafeInteger(pageCount) &&
    Number(page) >= 1 &&
    Number(pageCount) >= Number(page) &&
    Number(pageCount) <= MAX_PDF_PAGES
  );
}

export function parseFeedbackAnchor(
  value: unknown,
  context: {
    path: string;
    contentId?: string;
    scope: unknown;
    selection: unknown;
    lineInput: unknown;
  },
): FileFeedbackAnchor | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid feedback anchor");
  const anchor = value as Record<string, unknown>;
  if (
    context.scope !== "file" ||
    context.selection !== null ||
    context.lineInput !== undefined ||
    !feedbackDiskVersion(context.path, context.contentId)
  )
    throw new Error("invalid feedback anchor");
  if (validTextRange(value)) return { ...value };
  if (validXlsxRange(value)) return { ...value };
  if (validDocxBlock(value))
    return { ...value, elementPath: [...value.elementPath] };
  if (validVisualAreaAnchor(value)) return { ...value };
  if (
    !exactKeys(anchor, ["kind", "page", "pageCount"]) ||
    anchor.kind !== "pdf-page" ||
    !validPdfPage(anchor.page, anchor.pageCount)
  )
    throw new Error("invalid feedback anchor");
  return {
    kind: "pdf-page",
    page: Number(anchor.page),
    pageCount: Number(anchor.pageCount),
  };
}
