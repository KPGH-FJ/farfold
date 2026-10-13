import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { PdfInputCapture, PdfInputResult } from "./pdf_input_types";

export const pdfRequest = {
  mode: "decoded-page-text",
  includePossiblyInvisibleText: true,
} as const;
export function pdfResult(text = "literal", pageCount = 1): PdfInputResult {
  const empty = !/\S/u.test(text);
  return {
    scope: {
      ...pdfRequest,
      pageCount,
      readPageNumbers: Array.from({ length: pageCount }, (_, i) => i + 1),
      extraction: "pdfjs-text-content-v1",
    },
    pages: Array.from({ length: pageCount }, (_, i) => ({
      number: i + 1,
      decodedRotation: 0,
      items: [{ text, dir: "ltr", hasEOL: false }],
    })),
    partial: true,
    warnings: [
      { code: "decodedTextOnly", count: 1, unit: "scope" },
      { code: "visibilityUnverified", count: 1, unit: "scope" },
      { code: "readingOrderUnverified", count: 1, unit: "scope" },
      { code: "textDecodingUnverified", count: 1, unit: "scope" },
      ...(empty
        ? [
            {
              code: "pagesWithoutText" as const,
              count: pageCount,
              unit: "pages" as const,
            },
          ]
        : []),
    ],
  };
}
export async function pdfFixture(
  name = "01-pages-hidden-crop-ocr.pdf",
): Promise<Uint8Array> {
  return new Uint8Array(
    await readFile(new URL(`./fixtures/pdf-input/${name}`, import.meta.url)),
  );
}
export function pdfCapture(
  bytes: Uint8Array,
  name = "self.pdf",
): PdfInputCapture {
  return {
    file: {
      root: "/own",
      path: "/own/" + name,
      resolvedPath: "/own/" + name,
      name,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      version: "own-version",
    },
    data: Buffer.from(bytes).toString("base64"),
  };
}
