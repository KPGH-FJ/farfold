import {
  DOCX_LIMITS as L,
  DOCX_WARNING_CODES,
  DocxError,
  type DocxDocument,
} from "./docx_types";
import { inspectDocxImage } from "./docx_images";
type ObjectValue = Record<string, unknown>;
function invalid(): never {
  throw new DocxError("invalid");
}
function object(v: unknown, keys: string[]): ObjectValue {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    invalid();
  return v as ObjectValue;
}
function array(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) invalid();
  return v;
}
function number(v: unknown, min: number, max: number, integer = false): number {
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    v < min ||
    v > max ||
    (integer && !Number.isSafeInteger(v))
  )
    invalid();
  return v;
}
function choice(v: unknown, values: readonly unknown[]): void {
  if (!values.includes(v)) invalid();
}
const color = (v: unknown) => {
  if (typeof v !== "string" || !/^#[\da-f]{6}$/i.test(v)) invalid();
};
const optional = (v: unknown, check: (v: unknown) => unknown) => {
  if (v !== undefined) check(v);
};
/** Validate the closed Worker response vocabulary before it reaches DOM/CSS. */
export function checkedDocxDocument(value: unknown): DocxDocument {
  const d = object(value, [
    "blocks",
    "stories",
    "images",
    "warnings",
    "partial",
  ]);
  choice(d.partial, [true, false]);
  let text = 0,
    blocks = 0,
    cells = 0,
    runs = 0,
    pixels = 0,
    displayPixels = 0,
    references = 0;
  const string = (v: unknown, max = L.text as number): string => {
    if (typeof v !== "string" || v.length > max) invalid();
    text += v.length;
    if (text > L.text) invalid();
    return v;
  };
  const ids = new Set<string>(),
    images = new Map<string, number>();
  const id = (v: unknown) => {
    const s = string(v, 1024);
    if (!s || ids.has(s)) invalid();
    ids.add(s);
    return s;
  };
  const textStyle = (v: unknown) => {
    const s = object(v, [
      "bold",
      "italic",
      "strike",
      "underline",
      "color",
      "background",
      "fontSizePt",
      "verticalAlign",
    ]);
    for (const key of ["bold", "italic", "strike"])
      optional(s[key], (v) => choice(v, [true, false]));
    optional(s.underline, (v) => choice(v, ["single", "double", "none"]));
    optional(s.verticalAlign, (v) =>
      choice(v, ["baseline", "superscript", "subscript"]),
    );
    optional(s.color, color);
    optional(s.background, color);
    optional(s.fontSizePt, (v) => number(v, 0.5, 400));
  };
  const paragraphStyle = (v: unknown) => {
    const s = object(v, [
      "alignment",
      "leftPt",
      "rightPt",
      "firstLinePt",
      "spaceBeforePt",
      "spaceAfterPt",
      "lineHeight",
    ]);
    optional(s.alignment, (v) =>
      choice(v, ["left", "center", "right", "justify"]),
    );
    for (const k of ["leftPt", "rightPt", "firstLinePt"])
      optional(s[k], (v) => number(v, -1584, 1584));
    for (const k of ["spaceBeforePt", "spaceAfterPt"])
      optional(s[k], (v) => number(v, 0, 1584));
    optional(s.lineHeight, (v) => number(v, 1 / 240, 10));
  };
  for (const raw of array(d.images, L.images)) {
    const image = object(raw, ["id", "mimeType", "bytes", "width", "height"]),
      name = id(image.id);
    if (
      !(image.bytes instanceof Uint8Array) ||
      image.bytes.byteLength > L.imageBytes
    )
      invalid();
    const info = inspectDocxImage(image.bytes);
    choice(image.mimeType, ["image/png", "image/jpeg"]);
    if (
      info.width !== image.width ||
      info.height !== image.height ||
      info.mimeType !== image.mimeType
    )
      invalid();
    const count = info.width * info.height;
    pixels += count;
    if (pixels > L.imagePixels) invalid();
    images.set(name, count);
  }
  const warnings = array(d.warnings, DOCX_WARNING_CODES.length),
    codes = new Set<unknown>();
  for (const raw of warnings) {
    const w = object(raw, ["code", "count"]);
    choice(w.code, DOCX_WARNING_CODES);
    number(w.count, 1, L.nodes, true);
    if (codes.has(w.code)) invalid();
    codes.add(w.code);
  }
  if (!codes.has("continuousLayout")) invalid();
  const run = (raw: unknown) => {
    if (++runs > L.runs) invalid();
    const r = object(raw, [
      "kind",
      "text",
      "style",
      "page",
      "imageId",
      "widthPt",
      "heightPt",
      "alt",
      "code",
    ]);
    if (r.kind === "text") {
      object(raw, ["kind", "text", "style"]);
      string(r.text);
      textStyle(r.style);
    } else if (r.kind === "break") {
      object(raw, ["kind", "page"]);
      optional(r.page, (v) => choice(v, [true, false]));
    } else if (r.kind === "tab") object(raw, ["kind"]);
    else if (r.kind === "notice") {
      object(raw, ["kind", "code"]);
      choice(r.code, DOCX_WARNING_CODES);
    } else if (r.kind === "image") {
      object(raw, ["kind", "imageId", "widthPt", "heightPt", "alt"]);
      const image = typeof r.imageId === "string" && images.get(r.imageId);
      if (!image) invalid();
      displayPixels += image;
      if (++references > L.images || displayPixels > L.imagePixels) invalid();
      number(r.widthPt, 1 / 12700, 1584);
      number(r.heightPt, 1 / 12700, 1584);
      string(r.alt, 4096);
    } else invalid();
  };
  const blockList = (raw: unknown, depth: number): void => {
    for (const item of array(raw, L.blocks)) {
      if (++blocks > L.blocks) invalid();
      const b = object(item, [
        "kind",
        "id",
        "runs",
        "style",
        "headingLevel",
        "list",
        "code",
        "columnsPt",
        "rows",
      ]);
      id(b.id);
      if (b.kind === "paragraph") {
        object(item, ["kind", "id", "runs", "style", "headingLevel", "list"]);
        paragraphStyle(b.style);
        optional(b.headingLevel, (v) => number(v, 1, 9, true));
        if (b.list !== undefined) {
          const l = object(b.list, ["label", "level"]);
          string(l.label, 2048);
          number(l.level, 0, 8, true);
        }
        for (const r of array(b.runs, L.runs)) run(r);
      } else if (b.kind === "notice") {
        object(item, ["kind", "id", "code"]);
        choice(b.code, DOCX_WARNING_CODES);
      } else if (b.kind === "table") {
        object(item, ["kind", "id", "columnsPt", "rows"]);
        if (depth >= L.tableDepth) invalid();
        const cols = array(b.columnsPt, L.tableColumns);
        if (!cols.length) invalid();
        for (const c of cols) number(c, 0, 1584);
        const rows = array(b.rows, L.cells);
        if (!rows.length) invalid();
        const occupied = Array.from({ length: cols.length }, () => 0);
        rows.forEach((rawRow, index) => {
          const row = object(rawRow, ["cells"]);
          let last = -1;
          for (const rawCell of array(row.cells, L.tableColumns)) {
            if (++cells > L.cells) invalid();
            const c = object(rawCell, [
              "blocks",
              "column",
              "rowSpan",
              "columnSpan",
              "widthPt",
              "background",
              "verticalAlign",
              "borders",
            ]);
            const column = number(c.column, 0, cols.length - 1, true),
              span = number(c.columnSpan, 1, cols.length - column, true),
              height = number(c.rowSpan, 1, rows.length - index, true);
            if (column <= last) invalid();
            last = column;
            for (let at = column; at < column + span; at++) {
              if (occupied[at] > index) invalid();
              occupied[at] = index + height;
            }
            optional(c.widthPt, (v) => number(v, 0, 1584));
            optional(c.background, color);
            optional(c.verticalAlign, (v) =>
              choice(v, ["top", "center", "bottom"]),
            );
            if (c.borders !== undefined) {
              const borders = object(c.borders, [
                "top",
                "right",
                "bottom",
                "left",
              ]);
              for (const rawBorder of Object.values(borders))
                if (rawBorder !== undefined) {
                  const border = object(rawBorder, [
                    "color",
                    "widthPt",
                    "style",
                  ]);
                  color(border.color);
                  number(border.widthPt, 0, 12);
                  choice(border.style, ["solid", "dashed", "dotted", "double"]);
                }
            }
            blockList(c.blocks, depth + 1);
          }
          if (occupied.some((until) => until <= index)) invalid();
        });
      } else invalid();
    }
  };
  blockList(d.blocks, 0);
  for (const raw of array(d.stories, L.blocks)) {
    const s = object(raw, ["id", "kind", "noteId", "blocks"]);
    id(s.id);
    choice(s.kind, ["header", "footer", "footnote", "endnote"]);
    optional(s.noteId, (v) => string(v, 1024));
    blockList(s.blocks, 0);
  }
  return value as DocxDocument;
}
