import { createHash } from "node:crypto";
import type {
  ApprovedDocumentText,
  LocalPdfDocumentText,
} from "./document_input_types";
import { PDF_INPUT_SCOPE_WARNING_CODES } from "./pdf_input_types";

export const PDF_URI = "file:///owned/complete.pdf";
export function pdfLocal(text = "完整保留的提取文字 😀"): LocalPdfDocumentText {
  return {
    schema: 1,
    format: "pdf",
    selection: "read-decoded-page-text",
    source: {
      root: "/owned",
      path: "/owned/complete.pdf",
      resolvedPath: "/owned/complete.pdf",
      name: "complete.pdf",
      size: 17 * 1024 * 1024,
      sha256: "b".repeat(64),
      version: "unit-version",
    },
    textSha256: createHash("sha256").update(text).digest("hex"),
    utf8Bytes: Buffer.byteLength(text),
    partial: true,
    partialSelected: true,
    scope: {
      mode: "decoded-page-text",
      includePossiblyInvisibleText: true,
      pageCount: 3,
      readPageNumbers: [1, 2, 3],
      extraction: "pdfjs-text-content-v1",
    },
    warnings: PDF_INPUT_SCOPE_WARNING_CODES.map((code) => ({
      code,
      count: 1,
      unit: "scope",
    })),
  };
}
export function approvedPdf(
  text = "完整保留的提取文字 😀",
): ApprovedDocumentText {
  return { text, local: pdfLocal(text) };
}
