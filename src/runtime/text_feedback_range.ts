import type { TextPreview, VerifiedFile } from "./file_delivery";
import { validTextRange, type TextRangeAnchor } from "./file_feedback_anchor";
import { samePreviewFile } from "./preview_capture";
import { parseTextBlock, type TextBlockPreview } from "./text_block_preview";

export type TextFeedbackSource = Readonly<{
  file: Readonly<VerifiedFile>;
  text: string;
  byteStart: number;
  byteEnd: number;
  startLine: number;
  endLine: number;
  startsMidLine: boolean;
  endsMidLine: boolean;
}>;

// Only live factory results can supply coordinates. This is a receipt-shape
// boundary, not authentication: callers must pass an actual successful read
// and separately retain view/request ownership. Nothing here reads a file.
const sources = new WeakSet<TextFeedbackSource>();
const encoder = new TextEncoder();
const invalidScalar =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const fileKeys = [
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "sha256",
  "version",
] as const;

function validFile(file: VerifiedFile): boolean {
  return (
    !!file &&
    typeof file === "object" &&
    !Array.isArray(file) &&
    fileKeys.every(
      (key) =>
        key === "size" ||
        (typeof file[key] === "string" && file[key].length > 0),
    ) &&
    /^[a-f0-9]{64}$/i.test(file.sha256) &&
    Number.isSafeInteger(file.size) &&
    file.size >= 0 &&
    file.size <= 256 * 1024 * 1024
  );
}

/** Call only on the exact successful text-read receipt for this displayed file. */
export function createTextFeedbackSource(
  receipt: TextPreview | TextBlockPreview,
  expectedFile: VerifiedFile,
): TextFeedbackSource | null {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    !validFile(expectedFile) ||
    !validFile(receipt.file) ||
    !samePreviewFile(receipt.file, expectedFile) ||
    typeof receipt.text !== "string" ||
    receipt.text.length > 1024 * 1024 ||
    invalidScalar.test(receipt.text)
  )
    return null;
  let coordinates: Omit<TextFeedbackSource, "file" | "text">;
  if ("blockIndex" in receipt) {
    try {
      const b = parseTextBlock(receipt, expectedFile, receipt.blockIndex);
      if (b.startLine > b.byteStart + 1) return null;
      coordinates = {
        byteStart: b.byteStart,
        byteEnd: b.byteEnd,
        startLine: b.startLine,
        endLine: b.endLine,
        startsMidLine: b.startsMidLine,
        endsMidLine: b.endsMidLine,
      };
    } catch {
      return null;
    }
  } else {
    if (
      Object.keys(receipt).length !== 2 ||
      Object.keys(receipt).some((key) => key !== "file" && key !== "text") ||
      expectedFile.size > 1024 * 1024 ||
      receipt.text.length > 1024 * 1024 ||
      encoder.encode(receipt.text).length !== expectedFile.size
    )
      return null;
    const breaks = receipt.text.match(/\r\n|\r|\n/g)?.length ?? 0;
    coordinates = {
      byteStart: 0,
      byteEnd: expectedFile.size,
      startLine: 1,
      endLine: 1 + breaks - (/[\r\n]$/.test(receipt.text) ? 1 : 0),
      startsMidLine: false,
      endsMidLine: false,
    };
  }
  const source = Object.freeze({
    file: Object.freeze(
      Object.fromEntries(
        fileKeys.map((key) => [key, receipt.file[key]]),
      ) as unknown as VerifiedFile,
    ),
    text: receipt.text,
    ...coordinates,
  });
  sources.add(source);
  return source;
}

function boundary(text: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length)
    return false;
  if (offset === 0 || offset === text.length) return true;
  const before = text.charCodeAt(offset - 1),
    after = text.charCodeAt(offset);
  return (
    !(
      before >= 0xd800 &&
      before <= 0xdbff &&
      after >= 0xdc00 &&
      after <= 0xdfff
    ) && !(text[offset - 1] === "\r" && text[offset] === "\n")
  );
}

function width(code: number) {
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}
function position(source: TextFeedbackSource, end: number) {
  let bytes = source.byteStart,
    line = source.startLine;
  for (let i = 0; i < end;) {
    const code = source.text.codePointAt(i)!;
    if (code === 13 && source.text[i + 1] === "\n") {
      bytes += 2;
      line++;
      i += 2;
    } else {
      bytes += width(code);
      if (code === 10 || code === 13) line++;
      i += code > 0xffff ? 2 : 1;
    }
  }
  return { bytes, line };
}

/** UTF-16 DOM offsets become absolute half-open UTF-8 coordinates, unchanged. */
export function textFeedbackRange(
  source: TextFeedbackSource,
  anchorUtf16: number,
  focusUtf16: number,
): TextRangeAnchor | null {
  if (
    !sources.has(source) ||
    !Number.isSafeInteger(anchorUtf16) ||
    !Number.isSafeInteger(focusUtf16)
  )
    return null;
  const start = Math.min(anchorUtf16, focusUtf16),
    end = Math.max(anchorUtf16, focusUtf16);
  if (
    start === end ||
    !boundary(source.text, start) ||
    !boundary(source.text, end)
  )
    return null;
  const a = position(source, start),
    b = position(source, end);
  const range: TextRangeAnchor = {
    kind: "text-range",
    byteStart: a.bytes,
    byteEnd: b.bytes,
    startLine: a.line,
    endLine: b.line - (/[\r\n]/.test(source.text[end - 1]) ? 1 : 0),
  };
  return validTextRange(range) ? range : null;
}

/** Includes line endings, but only the part actually loaded in this source. */
export function textFeedbackLineOffsets(
  source: TextFeedbackSource,
  startLine: number,
  endLine: number,
): { start: number; end: number } | null {
  if (
    !sources.has(source) ||
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < source.startLine ||
    endLine < startLine ||
    endLine > source.endLine ||
    !source.text.length
  )
    return null;
  let line = source.startLine,
    start = 0;
  for (let i = 0; i < source.text.length;) {
    const code = source.text.codePointAt(i)!;
    i += code === 13 && source.text[i + 1] === "\n" ? 2 : code > 0xffff ? 2 : 1;
    if (code === 10 || code === 13) {
      if (line === endLine) return { start, end: i };
      line++;
      if (line <= startLine) start = i;
    }
  }
  return { start, end: source.text.length };
}

/** Compares to a currently loaded source; saved JSON alone cannot call this true. */
export function textFeedbackRangeMatches(
  source: TextFeedbackSource,
  anchor: TextRangeAnchor,
): boolean {
  if (
    !sources.has(source) ||
    !validTextRange(anchor) ||
    anchor.byteStart < source.byteStart ||
    anchor.byteEnd > source.byteEnd
  )
    return false;
  let bytes = source.byteStart,
    start = -1,
    end = -1;
  for (let i = 0; i <= source.text.length;) {
    if (bytes === anchor.byteStart) start = i;
    if (bytes === anchor.byteEnd) {
      end = i;
      break;
    }
    if (i === source.text.length) break;
    const code = source.text.codePointAt(i)!;
    bytes += width(code);
    i += code > 0xffff ? 2 : 1;
  }
  const current = textFeedbackRange(source, start, end);
  return (
    current !== null &&
    current.byteStart === anchor.byteStart &&
    current.byteEnd === anchor.byteEnd &&
    current.startLine === anchor.startLine &&
    current.endLine === anchor.endLine
  );
}
