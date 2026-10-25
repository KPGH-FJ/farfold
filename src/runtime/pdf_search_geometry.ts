import type { PdfInputPage, PdfInputTextItem } from "./pdf_input_types";

export interface PdfSearchSpan {
  readonly itemIndex: number;
  /** UTF-16 bounds in the run; source item text is copied without alteration. */
  readonly start: number;
  readonly end: number;
}
export interface PdfSearchRun {
  readonly text: string;
  readonly spans: readonly PdfSearchSpan[];
}
/** Floating-point roundoff only, not a font-derived word-spacing heuristic. */
function near(a: number, b: number, scale: number) {
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a - b) <=
      Math.min(
        1e-5,
        scale * 1e-6,
        Number.EPSILON * 32 * Math.max(1, Math.abs(a), Math.abs(b)),
      )
  );
}
function horizontal(item: PdfInputTextItem) {
  const g = item.geometry;
  if (
    !g ||
    item.dir !== "ltr" ||
    !item.text ||
    /[\r\n\u2028\u2029]/u.test(item.text)
  )
    return null;
  const [a, b, c, d, x, y] = g.transform;
  if (
    a <= 0 ||
    d <= 0 ||
    b !== 0 ||
    c !== 0 ||
    g.width <= 0 ||
    g.height <= 0 ||
    !Number.isFinite(x + g.width) ||
    x + g.width <= x
  )
    return null;
  return { a, d, x, y, width: g.width, height: g.height };
}
function adjacent(left: PdfInputTextItem, right: PdfInputTextItem) {
  if (left.hasEOL) return false;
  const a = horizontal(left),
    b = horizontal(right);
  const scale = Math.min(a?.height ?? 0, b?.height ?? 0);
  return (
    !!a &&
    !!b &&
    near(a.a, b.a, scale) &&
    near(a.d, b.d, scale) &&
    near(a.height, b.height, scale) &&
    near(a.y, b.y, scale) &&
    near(a.x + a.width, b.x, scale)
  );
}
/** Keep extraction order. Unknown geometry is a barrier, never a failed read.
 * Runs replace their members, so local matches and text budgets cannot double. */
export function pdfSearchRuns(page: PdfInputPage): readonly PdfSearchRun[] {
  const runs: PdfSearchRun[] = [];
  let parts: string[] = [],
    spans: PdfSearchSpan[] = [],
    offset = 0;
  const flush = () => {
    if (spans.length)
      runs.push(
        Object.freeze({ text: parts.join(""), spans: Object.freeze(spans) }),
      );
    parts = [];
    spans = [];
    offset = 0;
  };
  page.items.forEach((item, itemIndex) => {
    if (!item.text) {
      flush();
      return;
    }
    if (
      spans.length &&
      (page.decodedRotation !== 0 || !adjacent(page.items[itemIndex - 1], item))
    )
      flush();
    parts.push(item.text);
    spans.push(
      Object.freeze({
        itemIndex,
        start: offset,
        end: offset + item.text.length,
      }),
    );
    offset += item.text.length;
  });
  flush();
  return Object.freeze(runs);
}
