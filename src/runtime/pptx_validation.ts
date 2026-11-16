import {
  PPTX_GEOMETRY_LIMITS as G,
  PPTX_LIMITS as L,
  PPTX_WARNING_CODES,
  PptxError,
  type PptxDocument,
} from "./pptx_types";
import { inspectPptxImage } from "./pptx_images";

type Value = Record<string, unknown>;
function invalid(): never {
  throw new PptxError("invalid");
}
function object(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Value {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    invalid();
  return value as Value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) invalid();
  if (value.length > max) throw new PptxError("limit");
  return value;
}
function number(
  value: unknown,
  min: number,
  max: number,
  integer = false,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value))
  )
    invalid();
  if (value < min || value > max) throw new PptxError("limit");
  return value;
}
function string(value: unknown, max = 1024): string {
  if (
    typeof value !== "string" ||
    !value ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    invalid();
  if (value.length > max) throw new PptxError("limit");
  return value;
}
function choice(value: unknown, values: readonly unknown[]): void {
  if (!values.includes(value)) invalid();
}
function color(value: unknown): void {
  if (typeof value !== "string" || !/^#[\da-f]{6}$/i.test(value)) invalid();
}

/** A closed, bounded display model. No document HTML, CSS, URL or executable field
 * reaches the renderer; all source parts must belong to this exact capture. */
export function checkedPptxDocument(
  value: unknown,
  capturedParts: ReadonlySet<string>,
): PptxDocument {
  if (!(capturedParts instanceof Set) || capturedParts.size > L.entries)
    invalid();
  const document = object(value, [
    "width",
    "height",
    "slides",
    "images",
    "warnings",
    "partial",
  ]);
  const width = number(document.width, G.slideMin, G.slideMax);
  const height = number(document.height, G.slideMin, G.slideMax);
  if (width * height > G.slidePixels) throw new PptxError("limit");
  choice(document.partial, [true, false]);
  let pixels = 0,
    bytes = 0,
    shapes = 0,
    runs = 0,
    paragraphs = 0,
    text = 0;
  const images = new Map<string, number>();
  for (const raw of array(document.images, L.images)) {
    const image = object(raw, ["id", "mimeType", "bytes", "width", "height"]);
    const id = string(image.id);
    if (
      images.has(id) ||
      !capturedParts.has(id) ||
      !(image.bytes instanceof Uint8Array)
    )
      invalid();
    if (image.bytes.byteLength > L.imageBytes) throw new PptxError("limit");
    const info = inspectPptxImage(image.bytes);
    if (
      image.mimeType !== info.mimeType ||
      image.width !== info.width ||
      image.height !== info.height
    )
      invalid();
    pixels += info.width * info.height;
    bytes += image.bytes.byteLength;
    if (pixels > L.imagePixels || bytes > L.bytes) throw new PptxError("limit");
    images.set(id, info.width * info.height);
  }
  const slides = array(document.slides, G.slides),
    ids = new Set<string>(),
    parts = new Set<string>();
  if (!slides.length) invalid();
  for (const raw of slides) {
    const slide = object(raw, ["id", "part", "background", "shapes"]);
    const id = string(slide.id),
      part = string(slide.part);
    if (ids.has(id) || parts.has(part) || !capturedParts.has(part)) invalid();
    ids.add(id);
    parts.add(part);
    color(slide.background);
    const shapeIds = new Set<string>(),
      sourceIds = new Set<string>();
    let displayPixels = 0;
    for (const raw of array(slide.shapes, L.shapes)) {
      if (++shapes > L.shapes) throw new PptxError("limit");
      const base = object(
        raw,
        ["kind", "id", "source", "box"],
        ["geometry", "fill", "stroke", "text", "imageId", "groupTransform"],
      );
      const id = string(base.id);
      if (shapeIds.has(id)) invalid();
      shapeIds.add(id);
      const source = object(base.source, ["part", "shapeId", "layer"]);
      const sourcePart = string(source.part),
        shapeId = string(source.shapeId);
      choice(source.layer, ["master", "layout", "slide"]);
      if (
        !capturedParts.has(sourcePart) ||
        (source.layer === "slide" && sourcePart !== part)
      )
        invalid();
      const sourceKey = JSON.stringify([sourcePart, shapeId, source.layer]);
      if (sourceIds.has(sourceKey)) invalid();
      sourceIds.add(sourceKey);
      const box = object(base.box, ["x", "y", "width", "height"]);
      number(box.x, -G.coordinate, G.coordinate);
      number(box.y, -G.coordinate, G.coordinate);
      const w = number(box.width, 0, G.extent),
        h = number(box.height, 0, G.extent);
      let scaleX = 1,
        scaleY = 1;
      if (Object.hasOwn(base, "groupTransform")) {
        const group = object(base.groupTransform, [
          "x",
          "y",
          "scaleX",
          "scaleY",
        ]);
        const x = number(group.x, -G.coordinate, G.coordinate),
          y = number(group.y, -G.coordinate, G.coordinate);
        scaleX = number(group.scaleX, Number.MIN_VALUE, G.extent);
        scaleY = number(group.scaleY, Number.MIN_VALUE, G.extent);
        number(x + (box.x as number) * scaleX, -G.coordinate, G.coordinate);
        number(y + (box.y as number) * scaleY, -G.coordinate, G.coordinate);
        number(w * scaleX, 0, G.extent);
        number(h * scaleY, 0, G.extent);
      }
      if (base.kind === "image") {
        object(
          raw,
          ["kind", "id", "source", "box", "imageId"],
          ["groupTransform"],
        );
        const count = images.get(string(base.imageId));
        if (!count || w <= 0 || h <= 0) invalid();
        displayPixels += count;
        if (displayPixels > L.imagePixels) throw new PptxError("limit");
        continue;
      }
      if (base.kind !== "shape") invalid();
      object(
        raw,
        ["kind", "id", "source", "box", "geometry", "fill", "stroke", "text"],
        ["groupTransform"],
      );
      choice(base.geometry, ["rect", "ellipse", null]);
      if (base.fill !== null) color(base.fill);
      if (base.stroke !== null) {
        const stroke = object(base.stroke, ["color", "width"]);
        color(stroke.color);
        number(
          number(stroke.width, 0, G.stroke) * Math.max(scaleX, scaleY),
          0,
          G.stroke,
        );
      }
      if (
        base.geometry === null &&
        (base.fill !== null || base.stroke !== null)
      )
        invalid();
      if (base.text === null) continue;
      const body = object(base.text, [
        "inset",
        "wrap",
        "verticalAlign",
        "paragraphs",
      ]);
      const inset = object(body.inset, ["top", "right", "bottom", "left"]);
      for (const [key, value] of Object.entries(inset))
        number(
          number(value, 0, G.inset) *
            (["left", "right"].includes(key) ? scaleX : scaleY),
          0,
          G.inset,
        );
      choice(body.wrap, ["none", "square"]);
      choice(body.verticalAlign, ["top", "center", "bottom"]);
      for (const rawParagraph of array(body.paragraphs, L.runs)) {
        if (++paragraphs > L.runs) throw new PptxError("limit");
        const paragraph = object(rawParagraph, ["alignment", "runs"]);
        choice(paragraph.alignment, ["left", "center", "right"]);
        for (const rawRun of array(paragraph.runs, L.runs)) {
          if (++runs > L.runs) throw new PptxError("limit");
          const run = object(
            rawRun,
            ["kind"],
            [
              "text",
              "fontFamily",
              "fontSize",
              "color",
              "bold",
              "italic",
              "underline",
            ],
          );
          if (run.kind === "break") {
            object(rawRun, ["kind"]);
            continue;
          }
          if (run.kind !== "text") invalid();
          object(rawRun, [
            "kind",
            "text",
            "fontFamily",
            "fontSize",
            "color",
            "bold",
            "italic",
            "underline",
          ]);
          if (typeof run.text !== "string") invalid();
          text += run.text.length;
          if (text > L.text) throw new PptxError("limit");
          const family = string(run.fontFamily, 256);
          if (!/^[\p{L}\p{N} _.-]+$/u.test(family)) invalid();
          if (number(run.fontSize, G.fontMin, G.fontMax) <= 0) invalid();
          number(
            (run.fontSize as number) * Math.max(scaleX, scaleY),
            G.fontMin,
            G.fontMax,
          );
          color(run.color);
          for (const key of ["bold", "italic", "underline"])
            choice(run[key], [true, false]);
        }
      }
    }
  }
  const warnings = array(
      document.warnings,
      PPTX_WARNING_CODES.length * (slides.length + 1),
    ),
    warningIds = new Set<string>();
  let omitted = false;
  for (const raw of warnings) {
    const warning = object(raw, ["code", "count"], ["slideId"]);
    choice(warning.code, PPTX_WARNING_CODES);
    number(warning.count, 1, L.nodes, true);
    if (Object.hasOwn(warning, "slideId") && !ids.has(string(warning.slideId)))
      invalid();
    const key = JSON.stringify([warning.code, warning.slideId ?? null]);
    if (warningIds.has(key)) invalid();
    warningIds.add(key);
    if (
      ["unsupportedFormatting", "unsupportedContent", "hiddenContent"].includes(
        warning.code as string,
      )
    )
      omitted = true;
  }
  if (Boolean(document.partial) !== omitted) invalid();
  return value as PptxDocument;
}
