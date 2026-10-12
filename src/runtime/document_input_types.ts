import type { VerifiedFile } from "./file_delivery";
import { isAbsoluteFilePath } from "./file_paths";
import {
  DOCX_LIMITS,
  DOCX_WARNING_CODES,
  type DocxFailure,
  type DocxWarning,
} from "./docx_types";
import { documentInputFailure } from "./document_input_strings";

export const DOCUMENT_INPUT_MAX_BYTES = 256 * 1024;
/** Retained unknown text remains user input, never dispatch authority. */
export const DOCUMENT_INPUT_RETAINED_MAX_BYTES = 32 * 1024 * 1024;

export type DocumentInputFailure =
  | DocxFailure
  | "noText"
  | "textLimit"
  | "sourceUnknown"
  | "capabilityUnsupported"
  | "capabilityUnknown"
  | "recoveryRequired";

export class DocumentInputError extends Error {
  constructor(readonly code: DocumentInputFailure) {
    super(documentInputFailure({ code }));
  }
}

/** Only metadata of explicitly retained unsent text; no document cache. */
export interface LocalDocumentText {
  schema: 1;
  format: "docx";
  source: VerifiedFile;
  textSha256: string;
  utf8Bytes: number;
  selection: "read-visible-text";
  partial: boolean;
  partialSelected: boolean;
  warnings: DocxWarning[];
  imageReferences: number;
}

export interface ApprovedDocumentText {
  text: string;
  /** null preserves historical text without inventing a verified source. */
  local: LocalDocumentText | null;
}

function invalid(): never {
  throw new DocumentInputError("invalid");
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) invalid();
  return record;
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
function string(value: unknown, max = 32768): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    value.includes("\0")
  )
    invalid();
  return value;
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
function absolute(value: unknown): string {
  const path = string(value);
  if (!isAbsoluteFilePath(path)) invalid();
  return path;
}
function source(value: unknown): VerifiedFile {
  const file = object(value, [
    "root",
    "path",
    "resolvedPath",
    "name",
    "size",
    "sha256",
    "version",
  ]);
  return {
    root: absolute(file.root),
    path: absolute(file.path),
    resolvedPath: absolute(file.resolvedPath),
    name: string(file.name, 4096),
    size: integer(file.size, 1, DOCX_LIMITS.archive),
    sha256: sha(file.sha256),
    version: string(file.version, 4096),
  };
}

/** Reject lone surrogates: distinct JS strings must not hash to the same replacement bytes. */
export function documentTextBytes(text: unknown, max: number): Uint8Array {
  if (typeof text !== "string" || text.length > max)
    throw new DocumentInputError("textLimit");
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++at);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > max) throw new DocumentInputError("textLimit");
  return bytes;
}

/** A synchronous shape check, not a file read or a hash verification. */
export function parseLocalDocumentText(
  value: unknown,
): LocalDocumentText | null {
  if (value === null) return null;
  const item = object(value, [
    "schema",
    "format",
    "source",
    "textSha256",
    "utf8Bytes",
    "selection",
    "partial",
    "partialSelected",
    "warnings",
    "imageReferences",
  ]);
  if (
    item.schema !== 1 ||
    item.format !== "docx" ||
    item.selection !== "read-visible-text" ||
    typeof item.partial !== "boolean" ||
    typeof item.partialSelected !== "boolean"
  )
    invalid();
  if (
    !Array.isArray(item.warnings) ||
    item.warnings.length > DOCX_WARNING_CODES.length
  )
    invalid();
  const codes = new Set<string>();
  const warnings = item.warnings.map((value) => {
    const warning = object(value, ["code", "count"]);
    if (
      typeof warning.code !== "string" ||
      !DOCX_WARNING_CODES.includes(warning.code as DocxWarning["code"]) ||
      codes.has(warning.code)
    )
      invalid();
    codes.add(warning.code);
    return {
      code: warning.code as DocxWarning["code"],
      count: integer(warning.count, 1, DOCX_LIMITS.nodes),
    };
  });
  if (!codes.has("continuousLayout")) invalid();
  return {
    schema: 1,
    format: "docx",
    source: source(item.source),
    textSha256: sha(item.textSha256),
    utf8Bytes: integer(item.utf8Bytes, 1, DOCUMENT_INPUT_MAX_BYTES),
    selection: "read-visible-text",
    partial: item.partial,
    partialSelected: item.partialSelected,
    warnings,
    imageReferences: integer(item.imageReferences, 0, DOCX_LIMITS.images),
  };
}

export function parseApprovedDocumentText(
  value: unknown,
): ApprovedDocumentText {
  const item = object(value, ["text", "local"]);
  const local = parseLocalDocumentText(item.local);
  if (typeof item.text !== "string") invalid();
  const bytes = documentTextBytes(
    item.text,
    local ? DOCUMENT_INPUT_MAX_BYTES : DOCUMENT_INPUT_RETAINED_MAX_BYTES,
  );
  if (local && (bytes.byteLength !== local.utf8Bytes || !bytes.byteLength))
    invalid();
  if (local?.partial && !local.partialSelected) invalid();
  return { text: item.text, local };
}
