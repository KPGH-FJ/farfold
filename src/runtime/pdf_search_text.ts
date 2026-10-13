import type {
  PdfInputResult,
  PdfInputScope,
  PdfInputWarning,
} from "./pdf_input_types";
import { checkedPdfInputResult, pdfInputUtf8 } from "./pdf_input_validation";

export interface PdfSearchLocation {
  readonly kind: "pdf";
  readonly pageNumber: number;
  /** Original zero-based item ordinal, including empty items. */
  readonly itemIndex: number;
  readonly decodedRotation: 0 | 90 | 180 | 270;
}
export interface PdfSearchScope {
  readonly scope: Readonly<Omit<PdfInputScope, "readPageNumbers">> & {
    readonly readPageNumbers: readonly number[];
  };
  readonly partial: true;
  readonly warnings: readonly PdfInputWarning[];
}

/** Search only actual decoded items. Never join items, pages, or generated labels. */
export function pdfSearchText(input: PdfInputResult) {
  const result = checkedPdfInputResult(input);
  const segments: Readonly<{ text: string; location: PdfSearchLocation }>[] =
    [];
  let bytes = 0,
    hasText = false;
  for (const page of result.pages) {
    page.items.forEach((item, itemIndex) => {
      bytes += pdfInputUtf8(item.text).byteLength;
      if (/\S/u.test(item.text)) hasText = true;
      if (!item.text) return;
      segments.push(
        Object.freeze({
          text: item.text,
          location: Object.freeze({
            kind: "pdf",
            pageNumber: page.number,
            itemIndex,
            decodedRotation: page.decodedRotation,
          }),
        }),
      );
    });
  }
  if (!hasText) throw { code: "pdfNoText" };
  return Object.freeze({
    segments: Object.freeze(segments),
    bytes,
    pdf: Object.freeze({
      scope: Object.freeze({
        ...result.scope,
        readPageNumbers: Object.freeze([...result.scope.readPageNumbers]),
      }),
      partial: true as const,
      warnings: Object.freeze(
        result.warnings.map((w) => Object.freeze({ ...w })),
      ),
    }) satisfies PdfSearchScope,
  });
}
