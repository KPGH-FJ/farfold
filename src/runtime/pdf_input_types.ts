import type { VerifiedFile } from "./file_delivery";

export const PDF_INPUT_LIMITS = {
  sourceBytes: 32 * 1024 * 1024,
  pages: 1000,
  items: 100_000,
  textBytes: 256 * 1024,
  wait: 15_000,
} as const;

export const PDF_INPUT_FAILURE_CODES = [
  "changed",
  "unreadable",
  "encrypted",
  "invalid",
  "limit",
  "unsupported",
  "timeout",
  "cancelled",
  "busy",
  "readPending",
  "readBusy",
  "scopeRequired",
  "textLimit",
  "incomplete",
] as const;
export type PdfInputFailure = (typeof PDF_INPUT_FAILURE_CODES)[number];
export class PdfInputError extends Error {
  constructor(readonly code: PdfInputFailure) {
    super(code);
  }
}

export interface PdfInputRequest {
  mode: "decoded-page-text";
  includePossiblyInvisibleText: true;
}
export interface PdfInputScope extends PdfInputRequest {
  pageCount: number;
  readPageNumbers: number[];
  extraction: "pdfjs-text-content-v1";
}
/** Temporary PDF.js fragment geometry, not character boxes or visibility. */
export interface PdfInputGeometry {
  transform: [number, number, number, number, number, number];
  width: number;
  height: number;
}
export interface PdfInputTextItem {
  text: string;
  dir: "ltr" | "rtl" | "ttb";
  hasEOL: boolean;
  geometry?: PdfInputGeometry;
}
export interface PdfInputPage {
  number: number;
  decodedRotation: 0 | 90 | 180 | 270;
  items: PdfInputTextItem[];
}
export const PDF_INPUT_SCOPE_WARNING_CODES = [
  "decodedTextOnly",
  "visibilityUnverified",
  "readingOrderUnverified",
  "textDecodingUnverified",
] as const;
export type PdfInputWarning =
  | {
      code: (typeof PDF_INPUT_SCOPE_WARNING_CODES)[number];
      count: 1;
      unit: "scope";
    }
  | { code: "pagesWithoutText"; count: number; unit: "pages" };
export interface PdfInputResult {
  scope: PdfInputScope;
  pages: PdfInputPage[];
  partial: true;
  warnings: PdfInputWarning[];
}
export interface PdfInputCapture {
  file: VerifiedFile;
  data: string;
}
/** Own per-read messages, never a persisted session identity or protocol block. */
export interface PdfDiagnosticEvent {
  kind: "pdfDiagnostic";
  owner: string;
  count: number;
}
export interface PdfDiagnosticSnapshotRequest {
  kind: "pdfDiagnosticSnapshot";
  owner: string;
  nonce: string;
}
export interface PdfDiagnosticSnapshot {
  kind: "pdfDiagnosticSnapshotResult";
  owner: string;
  nonce: string;
  count: number;
}
