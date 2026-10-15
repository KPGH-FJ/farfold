import {
  PPTX_LIMITS as L,
  PptxError,
  type PptxCapture,
  type PptxDocument,
  type PptxSource,
  type PptxWarning,
} from "./pptx_types";
import { checkedPptxDocument } from "./pptx_validation";

export interface PptxSearchLocation {
  readonly kind: "pptx";
  readonly slidePart: string;
  /** Preview order, never the source file's slide number or character offset. */
  readonly previewSlide: number;
  readonly previewTotal: number;
  readonly shape: number;
  readonly paragraph: number;
  readonly segment: number;
  readonly source: Readonly<PptxSource>;
}
export interface PptxSearchScope {
  readonly partial: true;
  readonly slideCount: number;
  readonly imageReferences: number;
  readonly warnings: readonly PptxWarning[];
}

/** Snapshot the inert DTO before an asynchronous parser receives it. The caller
 * separately checks the exact seven-field file receipt against its selection. */
export function snapshotPptxSearchCapture(capture: PptxCapture): PptxCapture {
  if (
    Object.keys(capture).length !== 4 ||
    !["file", "parts", "entries", "inflatedBytes"].every((k) =>
      Object.hasOwn(capture, k),
    ) ||
    !Array.isArray(capture.parts) ||
    !Array.isArray(capture.entries)
  )
    throw new PptxError("invalid");
  if (
    !Number.isSafeInteger(capture.inflatedBytes) ||
    capture.inflatedBytes < 1 ||
    capture.inflatedBytes > L.bytes ||
    capture.parts.length > L.entries ||
    capture.entries.length > L.entries
  )
    throw new PptxError("limit");
  const entries = new Set<string>();
  for (const entry of capture.entries) {
    if (
      typeof entry !== "string" ||
      !entry ||
      entry.length > 1024 ||
      entries.has(entry)
    )
      throw new PptxError("invalid");
    entries.add(entry);
  }
  const parts = new Set<string>();
  let bytes = 0;
  const copied = capture.parts.map((part) => {
    if (
      !part ||
      typeof part !== "object" ||
      Object.keys(part).length !== 2 ||
      !Object.hasOwn(part, "name") ||
      !Object.hasOwn(part, "data") ||
      typeof part.name !== "string" ||
      typeof part.data !== "string" ||
      !entries.has(part.name) ||
      parts.has(part.name)
    )
      throw new PptxError("invalid");
    if (part.data.length > Math.ceil(L.part / 3) * 4)
      throw new PptxError("limit");
    bytes += part.data.length;
    if (bytes > Math.ceil(L.bytes / 3) * 4 + L.entries * 4)
      throw new PptxError("limit");
    parts.add(part.name);
    return Object.freeze({ name: part.name, data: part.data });
  });
  const snapshot = {
    file: Object.freeze({ ...capture.file }),
    parts: copied,
    entries: [...entries],
    inflatedBytes: capture.inflatedBytes,
  };
  Object.freeze(snapshot.parts);
  Object.freeze(snapshot.entries);
  return Object.freeze(snapshot);
}

/** Search the closed preview model, including its source-format bullet text.
 * No labels, shape names, XML, notes, image text or visual-order claims enter it. */
export function pptxSearchText(
  input: PptxDocument,
  capturedParts: ReadonlySet<string>,
) {
  const document = checkedPptxDocument(input, capturedParts);
  const segments: Readonly<{ text: string; location: PptxSearchLocation }>[] =
    [];
  let bytes = 0,
    imageReferences = 0;
  const encoder = new TextEncoder();
  document.slides.forEach((slide, slideIndex) => {
    slide.shapes.forEach((shape, shapeIndex) => {
      if (shape.kind === "image") {
        imageReferences++;
        return;
      }
      if (!shape.text) return;
      shape.text.paragraphs.forEach((paragraph, paragraphIndex) => {
        let parts: string[] = [],
          segment = 1;
        const flush = () => {
          const text = parts.join("");
          parts = [];
          if (!text) return;
          if (segments.length >= L.runs) throw new PptxError("limit");
          bytes += encoder.encode(text).length;
          segments.push(
            Object.freeze({
              text,
              location: Object.freeze({
                kind: "pptx",
                slidePart: slide.part,
                previewSlide: slideIndex + 1,
                previewTotal: document.slides.length,
                shape: shapeIndex + 1,
                paragraph: paragraphIndex + 1,
                segment,
                source: Object.freeze({ ...shape.source }),
              }),
            }),
          );
        };
        for (const run of paragraph.runs) {
          if (run.kind === "text") {
            // Separate malformed runs cannot manufacture one valid scalar when
            // their text is joined for a style-independent segment.
            if (
              run.text.includes("\0") ||
              /[\uD800-\uDFFF]/u.test(
                run.text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
              )
            )
              throw new PptxError("invalid");
            parts.push(run.text);
          } else {
            flush();
            segment++;
          }
        }
        flush();
      });
    });
  });
  return Object.freeze({
    segments: Object.freeze(segments),
    bytes,
    presentation: Object.freeze({
      partial: true as const,
      slideCount: document.slides.length,
      imageReferences,
      warnings: Object.freeze(
        document.warnings.map((warning) => Object.freeze({ ...warning })),
      ),
    }) satisfies PptxSearchScope,
  });
}
