import type {
  PdfInputResult,
  PdfInputScope,
  PdfInputWarning,
} from "./pdf_input_types";
import { checkedPdfInputResult, pdfInputUtf8 } from "./pdf_input_validation";
import { pdfSearchRuns, type PdfSearchSpan } from "./pdf_search_geometry";

export interface PdfSearchLocation {
  readonly kind: "pdf";
  readonly pageNumber: number;
  /** Original zero-based item ordinal, including empty items. */
  readonly itemIndex: number;
  readonly decodedRotation: 0 | 90 | 180 | 270;
  /** Present only for one match crossing original item boundaries. UTF-16. */
  readonly itemRanges?: readonly Readonly<{
    itemIndex: number;
    start: number;
    end: number;
  }>[];
}
export interface PdfSearchSegment {
  readonly text: string;
  readonly location: PdfSearchLocation;
  readonly pdfSpans: readonly PdfSearchSpan[];
}
/** Resolve the actual match, never the entire joined run or estimated glyphs. */
export function pdfSearchMatchLocation(
  location: PdfSearchLocation,
  spans: readonly PdfSearchSpan[],
  start: number,
  end: number,
): PdfSearchLocation {
  let lo = 0,
    hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid].end <= start) lo = mid + 1;
    else hi = mid;
  }
  const ranges: Readonly<{ itemIndex: number; start: number; end: number }>[] =
    [];
  for (let i = lo; i < spans.length && spans[i].start < end; i++) {
    const span = spans[i];
    ranges.push(
      Object.freeze({
        itemIndex: span.itemIndex,
        start: Math.max(start, span.start) - span.start,
        end: Math.min(end, span.end) - span.start,
      }),
    );
  }
  if (!ranges.length) throw new Error("invalid PDF match range");
  return Object.freeze({
    kind: location.kind,
    pageNumber: location.pageNumber,
    decodedRotation: location.decodedRotation,
    itemIndex: ranges[0].itemIndex,
    ...(ranges.length > 1 ? { itemRanges: Object.freeze(ranges) } : {}),
  });
}
export interface PdfSearchScope {
  readonly scope: Readonly<Omit<PdfInputScope, "readPageNumbers">> & {
    readonly readPageNumbers: readonly number[];
  };
  readonly partial: true;
  readonly warnings: readonly PdfInputWarning[];
}

/** Preserve actual decoded text; join only narrowly verified adjacent fragments. */
export function pdfSearchText(input: PdfInputResult) {
  const result = checkedPdfInputResult(input);
  const segments: PdfSearchSegment[] = [];
  let bytes = 0,
    hasText = false;
  for (const page of result.pages) {
    page.items.forEach((item) => {
      bytes += pdfInputUtf8(item.text).byteLength;
      if (/\S/u.test(item.text)) hasText = true;
    });
    for (const run of pdfSearchRuns(page)) {
      segments.push(
        Object.freeze({
          text: run.text,
          pdfSpans: run.spans,
          location: Object.freeze({
            kind: "pdf",
            pageNumber: page.number,
            itemIndex: run.spans[0].itemIndex,
            decodedRotation: page.decodedRotation,
          }),
        }),
      );
    }
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
