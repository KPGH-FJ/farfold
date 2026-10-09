import { xstring } from "./xlsx_xstring";
import * as SSF from "ssf";
import {
  attr,
  boolean,
  child,
  children,
  decimal,
  integer,
  requireRoot,
  type XmlNode,
} from "./xlsx_xml";
import {
  XLSX_LIMITS,
  XlsxError,
  type XlsxFont,
  type XlsxStyle,
} from "./xlsx_types";

const THEME_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const THEME_NAMES = [
  "lt1",
  "dk1",
  "lt2",
  "dk2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
];
const PALETTE = [
  "000000",
  "FFFFFF",
  "FF0000",
  "00FF00",
  "0000FF",
  "FFFF00",
  "FF00FF",
  "00FFFF",
  "000000",
  "FFFFFF",
  "FF0000",
  "00FF00",
  "0000FF",
  "FFFF00",
  "FF00FF",
  "00FFFF",
];
export const defaultStyle = (): XlsxStyle => ({
  numFmt: "General",
  font: {},
  borders: {},
});

export function themeColors(
  theme: XmlNode | undefined,
): (string | undefined)[] {
  if (!theme) return [];
  requireRoot(theme, "theme", THEME_NS);
  const elements = child(theme, "themeElements"),
    scheme = elements && child(elements, "clrScheme");
  if (!scheme) throw new XlsxError("invalid");
  return THEME_NAMES.map((name) => {
    const entry = child(scheme, name);
    const rgb = entry && child(entry, "srgbClr"),
      system = entry && child(entry, "sysClr");
    const value = rgb
      ? attr(rgb, "val")
      : system
        ? attr(system, "lastClr")
        : undefined;
    if (value !== undefined && !/^[0-9a-f]{6}$/i.test(value))
      throw new XlsxError("invalid");
    return value?.toUpperCase();
  });
}
// Spreadsheet theme tint changes HSL luminance, not each RGB channel separately.
function tinted(hex: string, tint: number): string {
  const [r, g, b] = [0, 2, 4].map(
    (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
  );
  const hi = Math.max(r, g, b),
    lo = Math.min(r, g, b),
    delta = hi - lo,
    light = (hi + lo) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * light - 1));
  let hue =
    delta === 0
      ? 0
      : hi === r
        ? ((g - b) / delta) % 6
        : hi === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4;
  if (hue < 0) hue += 6;
  const l = tint < 0 ? light * (1 + tint) : light * (1 - tint) + tint;
  const c = (1 - Math.abs(2 * l - 1)) * saturation,
    x = c * (1 - Math.abs((hue % 2) - 1)),
    m = l - c / 2;
  const channels =
    hue < 1
      ? [c, x, 0]
      : hue < 2
        ? [x, c, 0]
        : hue < 3
          ? [0, c, x]
          : hue < 4
            ? [0, x, c]
            : hue < 5
              ? [x, 0, c]
              : [c, 0, x];
  return channels
    .map((v) =>
      Math.round((v + m) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase();
}
export function color(
  node: XmlNode | undefined,
  themes: (string | undefined)[],
  warnings: Set<string>,
): string | undefined {
  if (!node) return undefined;
  const rgb = attr(node, "rgb"),
    theme = attr(node, "theme"),
    indexed = attr(node, "indexed");
  let hex: string | undefined;
  if (rgb !== undefined) {
    if (!/^[0-9a-f]{8}$/i.test(rgb)) throw new XlsxError("invalid");
    hex = rgb.slice(2);
  } else if (theme !== undefined) hex = themes[integer(theme, 0, 11)];
  else if (indexed !== undefined) {
    const index = integer(indexed, 0, 65);
    // A workbook palette overrides these indices; do not invent default colors
    // while its custom palette remains outside this reader's style subset.
    if (!warnings.has("customIndexedColors")) hex = PALETTE[index];
  } else if (boolean(attr(node, "auto"))) {
    warnings.add("automaticColor");
    return undefined;
  }
  if (!hex) {
    warnings.add("unsupportedColor");
    return undefined;
  }
  const tint = attr(node, "tint");
  return (
    "#" +
    (tint === undefined ? hex.toUpperCase() : tinted(hex, decimal(tint, -1, 1)))
  );
}
export function font(
  node: XmlNode | undefined,
  themes: (string | undefined)[],
  warnings: Set<string>,
): XlsxFont {
  if (!node) return {};
  const result: XlsxFont = {};
  for (const [key, tag] of [
    ["bold", "b"],
    ["italic", "i"],
    ["strike", "strike"],
  ] as const) {
    const v = child(node, tag);
    if (v) result[key] = boolean(attr(v, "val"), true);
  }
  const u = child(node, "u");
  if (u) {
    result.underline = attr(u, "val") !== "none";
    if (attr(u, "val") && !["single", "none"].includes(attr(u, "val")!))
      warnings.add("underlineVariant");
  }
  const name = child(node, "name") ?? child(node, "rFont"),
    size = child(node, "sz");
  if (name) {
    const raw = attr(name, "val");
    const v = raw === undefined ? undefined : xstring(raw);
    if (!v || v.length > 128) throw new XlsxError("invalid");
    result.name = v;
  }
  if (size) result.size = decimal(attr(size, "val"), 1, 409);
  result.color = color(child(node, "color"), themes, warnings);
  if (child(node, "vertAlign")) warnings.add("fontVerticalAlignment");
  return result;
}
export function parseStyles(
  root: XmlNode | undefined,
  themes: (string | undefined)[],
  warnings: Set<string>,
): XlsxStyle[] {
  if (!root) return [defaultStyle()];
  requireRoot(root, "styleSheet");
  const formats = new Map<number, string>(
    Object.entries(SSF.get_table()).map(([id, code]) => [Number(id), code]),
  );
  const nf = child(root, "numFmts");
  if (nf) {
    const seen = new Set<number>();
    for (const n of children(nf, "numFmt")) {
      const id = integer(attr(n, "numFmtId"), 0, 65535),
        raw = attr(n, "formatCode"),
        code = raw === undefined ? undefined : xstring(raw);
      if (seen.has(id) || code === undefined) throw new XlsxError("invalid");
      seen.add(id);
      if (seen.size > XLSX_LIMITS.styles || code.length > XLSX_LIMITS.format)
        throw new XlsxError("limit");
      formats.set(id, code);
    }
  }
  const list = (name: string, item: string) => {
    const n = child(root, name);
    const result = n ? children(n, item) : [];
    if (result.length > XLSX_LIMITS.styles) throw new XlsxError("limit");
    return result;
  };
  const fonts = list("fonts", "font"),
    fills = list("fills", "fill"),
    borders = list("borders", "border"),
    bases = list("cellStyleXfs", "xf"),
    cells = list("cellXfs", "xf");
  if (child(root, "colors")) warnings.add("customIndexedColors");
  if (child(root, "dxfs")?.children.length) warnings.add("differentialStyles");
  if (!cells.length) return [defaultStyle()];
  return cells.map((xf) => {
    const baseIndex = attr(xf, "xfId"),
      base =
        baseIndex === undefined
          ? undefined
          : bases[integer(baseIndex, 0, bases.length - 1)];
    const id = (name: string, apply: string, max: number) => {
      const source =
        attr(xf, apply) !== undefined && !boolean(attr(xf, apply)) ? base : xf;
      const raw = (source && attr(source, name)) ?? (base && attr(base, name));
      return integer(raw, 0, Math.max(0, max - 1), 0);
    };
    const numFmtId = id("numFmtId", "applyNumberFormat", 65536),
      numFmt = formats.get(numFmtId);
    if (numFmt === undefined) warnings.add("unknownNumberFormat");
    const result: XlsxStyle = {
      numFmt: numFmt ?? "[unsupported]",
      font: font(
        fonts[id("fontId", "applyFont", fonts.length)],
        themes,
        warnings,
      ),
      borders: {},
    };
    const fill = fills[id("fillId", "applyFill", fills.length)],
      pattern = fill && child(fill, "patternFill");
    if (pattern && attr(pattern, "patternType") === "solid")
      result.fill = color(child(pattern, "fgColor"), themes, warnings);
    else if (
      fill &&
      (!pattern || ![undefined, "none"].includes(attr(pattern, "patternType")))
    )
      warnings.add("patternFill");
    const border = borders[id("borderId", "applyBorder", borders.length)];
    if (border)
      for (const side of ["left", "right", "top", "bottom"] as const) {
        const n = child(border, side),
          style = n && attr(n, "style");
        if (style && style !== "none") {
          if (
            ![
              "thin",
              "medium",
              "dashed",
              "dotted",
              "thick",
              "double",
              "hair",
              "mediumDashed",
              "dashDot",
              "mediumDashDot",
              "dashDotDot",
              "mediumDashDotDot",
              "slantDashDot",
            ].includes(style)
          ) {
            warnings.add("borderStyle");
            continue;
          }
          result.borders[side] = {
            style,
            color: color(child(n!, "color"), themes, warnings),
          };
        }
      }
    if (
      border &&
      (child(border, "diagonal")?.attrs.style ||
        boolean(attr(border, "diagonalUp")) ||
        boolean(attr(border, "diagonalDown")))
    )
      warnings.add("diagonalBorder");
    const alignment =
      (attr(xf, "applyAlignment") !== undefined &&
      !boolean(attr(xf, "applyAlignment"))
        ? undefined
        : child(xf, "alignment")) ??
      (base && child(base, "alignment"));
    if (alignment) {
      const horizontal = attr(alignment, "horizontal"),
        vertical = attr(alignment, "vertical");
      if (horizontal && horizontal !== "general") {
        if (
          [
            "left",
            "center",
            "right",
            "justify",
            "fill",
            "distributed",
          ].includes(horizontal)
        )
          result.horizontal = horizontal as XlsxStyle["horizontal"];
        else warnings.add("alignment");
      }
      if (vertical) {
        if (
          ["top", "center", "bottom", "justify", "distributed"].includes(
            vertical,
          )
        )
          result.vertical = vertical as XlsxStyle["vertical"];
        else warnings.add("alignment");
      }
      result.wrap = boolean(attr(alignment, "wrapText"));
      result.shrink = boolean(attr(alignment, "shrinkToFit"));
      result.indent = integer(attr(alignment, "indent"), 0, 250, 0);
      result.rotation = integer(attr(alignment, "textRotation"), 0, 255, 0);
      if (result.rotation) warnings.add("rotatedText");
      if (result.shrink) warnings.add("shrinkToFit");
    }
    return result;
  });
}
