import {
  PDF_INPUT_LIMITS as L,
  PDF_INPUT_SCOPE_WARNING_CODES,
  PdfInputError,
  type PdfInputRequest,
  type PdfInputResult,
  type PdfInputScope,
  type PdfInputWarning,
} from "./pdf_input_types";

function invalid(): never {
  throw new PdfInputError("invalid");
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(item, k))
  )
    invalid();
  return item;
}
function integer(value: unknown, min: number, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    invalid();
  return value as number;
}
function dense(value: unknown, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    Object.keys(value).length !== value.length
  )
    invalid();
  for (let at = 0; at < value.length; at++)
    if (!Object.hasOwn(value, at)) invalid();
  return value;
}
/** Whole UTF-8 only. Reject ill-formed JS strings instead of replacing bytes. */
export function pdfInputUtf8(value: unknown, max = L.textBytes): Uint8Array {
  if (typeof value !== "string") invalid();
  if (value.length > max) throw new PdfInputError("textLimit");
  for (let at = 0; at < value.length; at++) {
    const unit = value.charCodeAt(at);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++at);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > max) throw new PdfInputError("textLimit");
  return bytes;
}
export function checkedPdfInputRequest(value: unknown): PdfInputRequest {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("includePossiblyInvisibleText" in value) ||
    value.includePossiblyInvisibleText !== true
  )
    throw new PdfInputError("scopeRequired");
  const item = object(value, ["mode", "includePossiblyInvisibleText"]);
  if (item.mode !== "decoded-page-text") invalid();
  return { mode: "decoded-page-text", includePossiblyInvisibleText: true };
}
export function checkedPdfInputScope(value: unknown): PdfInputScope {
  const item = object(value, [
    "mode",
    "includePossiblyInvisibleText",
    "pageCount",
    "readPageNumbers",
    "extraction",
  ]);
  const request = checkedPdfInputRequest({
    mode: item.mode,
    includePossiblyInvisibleText: item.includePossiblyInvisibleText,
  });
  const count = integer(item.pageCount, 1, L.pages);
  const pageNumbers = dense(item.readPageNumbers, L.pages);
  if (
    item.extraction !== "pdfjs-text-content-v1" ||
    pageNumbers.length !== count ||
    pageNumbers.some((n, i) => n !== i + 1)
  )
    invalid();
  return {
    ...request,
    pageCount: count,
    readPageNumbers: pageNumbers.map((n) => integer(n, 1, L.pages)),
    extraction: "pdfjs-text-content-v1",
  };
}
export function checkedPdfInputWarnings(value: unknown): PdfInputWarning[] {
  const entries = dense(value, 5);
  if (entries.length < 4) invalid();
  return entries.map((entry, at) => {
    const item = object(entry, ["code", "count", "unit"]);
    if (at < 4) {
      if (
        item.code !== PDF_INPUT_SCOPE_WARNING_CODES[at] ||
        item.count !== 1 ||
        item.unit !== "scope"
      )
        invalid();
      return {
        code: PDF_INPUT_SCOPE_WARNING_CODES[at],
        count: 1,
        unit: "scope",
      };
    }
    if (item.code !== "pagesWithoutText" || item.unit !== "pages") invalid();
    return {
      code: "pagesWithoutText",
      count: integer(item.count, 1, L.pages),
      unit: "pages",
    };
  });
}
export function checkedPdfInputResult(value: unknown): PdfInputResult {
  const item = object(value, ["scope", "pages", "partial", "warnings"]);
  const scope = checkedPdfInputScope(item.scope);
  const storedPages = dense(item.pages, L.pages);
  if (item.partial !== true || storedPages.length !== scope.pageCount)
    invalid();
  let count = 0,
    bytes = 0,
    emptyPages = 0;
  const pages = storedPages.map((value, at) => {
    const page = object(value, ["number", "decodedRotation", "items"]);
    if (
      page.number !== at + 1 ||
      ![0, 90, 180, 270].includes(page.decodedRotation as number) ||
      !Array.isArray(page.items)
    )
      invalid();
    count += page.items.length;
    if (count > L.items) throw new PdfInputError("limit");
    let authored = false;
    const items = dense(page.items, L.items).map((value) => {
      const entry = object(value, ["text", "dir", "hasEOL"]);
      bytes += pdfInputUtf8(entry.text).byteLength;
      if (bytes > L.textBytes) throw new PdfInputError("textLimit");
      if (
        !["ltr", "rtl", "ttb"].includes(entry.dir as string) ||
        typeof entry.hasEOL !== "boolean"
      )
        invalid();
      if (/\S/u.test(entry.text as string)) authored = true;
      return {
        text: entry.text as string,
        dir: entry.dir as "ltr" | "rtl" | "ttb",
        hasEOL: entry.hasEOL,
      };
    });
    if (!authored) emptyPages++;
    return {
      number: at + 1,
      decodedRotation: page.decodedRotation as 0 | 90 | 180 | 270,
      items,
    };
  });
  const warnings = checkedPdfInputWarnings(item.warnings);
  const empty = warnings.find((w) => w.code === "pagesWithoutText");
  if ((empty?.count ?? 0) !== emptyPages) invalid();
  const result: PdfInputResult = { scope, pages, partial: true, warnings };
  // Structural expansion is bounded before it can become a review. The final
  // representation, including all user-visible scope text, is checked again.
  pdfInputUtf8(JSON.stringify(result));
  return result;
}
