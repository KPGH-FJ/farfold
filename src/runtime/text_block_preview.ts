import { invoke } from "@tauri-apps/api/core";
import type { VerifiedFile } from "./file_delivery";
import { samePreviewFile } from "./preview_capture";

export const TEXT_BLOCK_BYTES = 128 * 1024;
export const TEXT_BLOCK_LINES = 2000;
export interface TextBlockPreview {
  file: VerifiedFile;
  blockIndex: number;
  blockCount: number;
  byteStart: number;
  byteEnd: number;
  startLine: number;
  endLine: number;
  startsMidLine: boolean;
  endsMidLine: boolean;
  text: string;
}
export type TextBlockFailureCode =
  | "pending"
  | "busy"
  | "changed"
  | "tooLarge"
  | "unsupportedText"
  | "unreadable"
  | "unavailable"
  | "invalidBlock";
const codes: readonly string[] = [
  "pending",
  "busy",
  "changed",
  "tooLarge",
  "unsupportedText",
  "unreadable",
  "unavailable",
  "invalidBlock",
];
export function textBlockFailure(error: unknown): TextBlockFailureCode {
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && codes.includes(code)
    ? (code as TextBlockFailureCode)
    : "unavailable";
}
function invalid(): never {
  throw { code: "unavailable" };
}
const integer = (v: unknown, min: number) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min;
/** Validate a bounded receipt, not a second file ledger. Raw offsets retain BOM and CRLF. */
export function parseTextBlock(
  value: unknown,
  file: VerifiedFile,
  index: number,
  restore = false,
): TextBlockPreview {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !integer(index, 0)
  )
    invalid();
  const b = value as TextBlockPreview;
  const keys = [
    "file",
    "blockIndex",
    "blockCount",
    "byteStart",
    "byteEnd",
    "startLine",
    "endLine",
    "startsMidLine",
    "endsMidLine",
    "text",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    !b.file ||
    !samePreviewFile(b.file, file) ||
    !integer(b.blockIndex, 0) ||
    !integer(b.blockCount, 1) ||
    b.blockCount > Math.max(1, file.size) ||
    b.blockIndex !== (restore ? Math.min(index, b.blockCount - 1) : index) ||
    b.blockIndex >= b.blockCount ||
    !integer(b.byteStart, 0) ||
    !integer(b.byteEnd, b.byteStart) ||
    b.byteEnd > file.size ||
    !integer(b.startLine, 1) ||
    !integer(b.endLine, b.startLine) ||
    typeof b.startsMidLine !== "boolean" ||
    typeof b.endsMidLine !== "boolean" ||
    typeof b.text !== "string" ||
    b.text.length > TEXT_BLOCK_BYTES ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      b.text,
    )
  )
    invalid();
  const bytes = new TextEncoder().encode(b.text).length;
  const breaks = b.text.match(/\r\n|\r|\n/g)?.length ?? 0;
  const endsNewline = /[\r\n]$/.test(b.text);
  if (
    bytes > TEXT_BLOCK_BYTES ||
    bytes !== b.byteEnd - b.byteStart ||
    breaks > TEXT_BLOCK_LINES ||
    b.endLine !== b.startLine + breaks - (endsNewline ? 1 : 0) ||
    (b.blockIndex === 0 &&
      (b.byteStart !== 0 || b.startLine !== 1 || b.startsMidLine)) ||
    (b.blockIndex > 0 && b.byteStart === 0) ||
    (b.blockIndex === b.blockCount - 1 &&
      (b.byteEnd !== file.size || b.endsMidLine)) ||
    (b.blockIndex < b.blockCount - 1 &&
      (b.byteEnd >= file.size || b.endsMidLine === endsNewline)) ||
    (file.size > 0 && bytes === 0) ||
    (file.size === 0 &&
      (b.blockCount !== 1 || b.startLine !== 1 || b.endLine !== 1))
  )
    invalid();
  return b;
}
export async function readTextBlock(
  file: VerifiedFile,
  blockIndex: number,
  restorePosition = false,
): Promise<TextBlockPreview> {
  if (!integer(blockIndex, 0)) throw { code: "invalidBlock" };
  const value = await invoke<unknown>("file_delivery_read_text_block", {
    file,
    blockIndex,
    restorePosition,
  });
  return parseTextBlock(value, file, blockIndex, restorePosition);
}
