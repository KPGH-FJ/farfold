import { MAX_PDF_PAGES } from "./visual_preview";

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

export type FileFeedbackAnchor = PdfPageAnchor | TextRangeAnchor;

export function validTextRange(value: unknown): value is TextRangeAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as TextRangeAnchor;
  return (
    Object.keys(a).length === 5 &&
    Object.keys(a).every((key) =>
      ["kind", "byteStart", "byteEnd", "startLine", "endLine"].includes(key),
    ) &&
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
  if (
    Object.keys(anchor).some(
      (key) => !["kind", "page", "pageCount"].includes(key),
    ) ||
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
