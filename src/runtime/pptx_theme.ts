import { PptxError } from "./pptx_types";
import { A, P, attr, child, number, root, type PptxXml } from "./pptx_xml";

export interface PptxTheme {
  colors: Map<string, string>;
  fonts: Map<string, string>;
  formats?: PptxXml;
}
export function readTheme(node: PptxXml): PptxTheme {
  root(node, "theme", A);
  // a:objectDefaults describes formatting imprinted when a NEW object is
  // inserted (ISO 29500 objectDefaults). It is not a current-shape override.
  const elements = child(node, "themeElements"),
    scheme = child(elements, "clrScheme"),
    fonts = child(elements, "fontScheme");
  if (!elements || !scheme) throw new PptxError("invalid");
  const result: PptxTheme = {
    colors: new Map(),
    fonts: new Map(),
    formats: child(elements, "fmtScheme"),
  };
  for (const n of scheme.children) {
    if (n.uri !== A || result.colors.has(n.name))
      throw new PptxError("invalid");
    result.colors.set(n.name, readColor(n, result, {}));
  }
  for (const [group, prefix] of [
    ["majorFont", "mj"],
    ["minorFont", "mn"],
  ]) {
    const f = child(fonts, group);
    for (const [kind, suffix] of [
      ["latin", "lt"],
      ["ea", "ea"],
      ["cs", "cs"],
    ]) {
      const family = attrOptional(child(f, kind), "typeface");
      if (family) result.fonts.set(`+${prefix}-${suffix}`, checkedFont(family));
    }
  }
  return result;
}
function attrOptional(n: PptxXml | undefined, key: string): string | undefined {
  return n && attr(n, key);
}
export function checkedFont(raw: string): string {
  if (!raw || raw.length > 256 || !/^[\p{L}\p{N} _.\-]+$/u.test(raw))
    throw new PptxError("unsupported");
  return raw;
}
export function fontFamily(raw: string, theme: PptxTheme): string {
  return checkedFont(raw.startsWith("+") ? (theme.fonts.get(raw) ?? "") : raw);
}
export function colorMap(
  master: PptxXml | undefined,
  layout: PptxXml | undefined,
  slide: PptxXml,
): Record<string, string> {
  const base: Record<string, string> = Object.assign(Object.create(null), {
    bg1: "lt1",
    tx1: "dk1",
    bg2: "lt2",
    tx2: "dk2",
    accent1: "accent1",
    accent2: "accent2",
    accent3: "accent3",
    accent4: "accent4",
    accent5: "accent5",
    accent6: "accent6",
    hlink: "hlink",
    folHlink: "folHlink",
  });
  const apply = (into: Record<string, string>, n: PptxXml | undefined) => {
    if (!n) return;
    for (const [key, value] of Object.entries(n.attrs))
      if (!key.includes("#")) into[key] = value;
  };
  apply(base, child(master, "clrMap", P));
  let result = { ...base };
  for (const n of [layout, slide]) {
    const o = child(n, "clrMapOvr", P);
    if (!o) continue;
    const explicit = child(o, "overrideClrMapping"),
      masterMapping = child(o, "masterClrMapping");
    if (!!explicit === !!masterMapping) throw new PptxError("unsupported");
    result = { ...base };
    if (explicit) apply(result, explicit);
  }
  return result;
}
/** Resolve only explicit RGB/theme colours. Unsupported colour spaces/effects reject. */
export function readColor(
  parent: PptxXml,
  theme: PptxTheme,
  mapping: Record<string, string>,
  placeholder?: string,
): string {
  const candidates = parent.children.filter(
    (n) => n.uri === A && /Clr$/.test(n.name),
  );
  if (candidates.length !== 1) throw new PptxError("unsupported");
  const n = candidates[0];
  if (
    n.text.trim() ||
    Object.keys(n.attrs).some(
      (key) =>
        !(n.name === "sysClr" ? ["val", "lastClr"] : ["val"]).includes(key) &&
        !key.startsWith("http://www.w3.org/2000/xmlns/#"),
    )
  )
    throw new PptxError("unsupported");
  let raw: string | undefined;
  if (n.name === "srgbClr") raw = attr(n, "val");
  else if (n.name === "sysClr") raw = attr(n, "lastClr");
  else if (n.name === "schemeClr") {
    const key = attr(n, "val");
    if (!key) throw new PptxError("invalid");
    const value =
      key === "phClr" ? placeholder : theme.colors.get(mapping[key] ?? key);
    raw = value?.replace(/^#/, "");
  } else throw new PptxError("unsupported");
  if (!raw || !/^[\da-f]{6}$/i.test(raw)) throw new PptxError("unsupported");
  let rgb = [0, 2, 4].map((at) => parseInt(raw!.slice(at, at + 2), 16));
  for (const effect of n.children) {
    if (
      effect.uri !== A ||
      effect.children.length ||
      effect.text.trim() ||
      Object.keys(effect.attrs).some(
        (key) =>
          key !== "val" && !key.startsWith("http://www.w3.org/2000/xmlns/#"),
      )
    )
      throw new PptxError("unsupported");
    const value = attr(effect, "val");
    if (!value || !/^[+-]?\d+$/.test(value)) throw new PptxError("invalid");
    // DrawingML satMod uses CT_Percentage / signed Int32 (unlike fixed
    // shade/alpha). Keep the schema range; saturation itself is bounded HSL.
    const v =
      number(
        value,
        effect.name === "satMod" ? -2_147_483_648 : 0,
        effect.name === "satMod" ? 2_147_483_647 : 100_000,
      ) / 100_000;
    if (effect.name === "alpha" && v === 1) continue;
    else if (effect.name === "shade") rgb = rgb.map((channel) => channel * v);
    else if (effect.name === "satMod") rgb = saturation(rgb, v);
    else throw new PptxError("unsupported");
  }
  return (
    "#" +
    rgb
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

/** DrawingML saturation modulation keeps HSL hue/lightness, changing only S. */
function saturation(rgb: number[], factor: number): number[] {
  const [r, g, b] = rgb.map((channel) => channel / 255),
    high = Math.max(r, g, b),
    low = Math.min(r, g, b),
    delta = high - low,
    light = (high + low) / 2;
  if (!delta) return rgb;
  const hue =
    (high === r
      ? (g - b) / delta + (g < b ? 6 : 0)
      : high === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4) * 60;
  const sat = Math.max(
      0,
      Math.min(1, (delta / (1 - Math.abs(2 * light - 1))) * factor),
    ),
    amplitude = sat * Math.min(light, 1 - light);
  return [0, 8, 4].map((n) => {
    const k = (n + hue / 30) % 12;
    return (light - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  });
}

export function matrixStyle(
  reference: PptxXml | undefined,
  kind: "fillStyleLst" | "lnStyleLst" | "effectStyleLst" | "bgFillStyleLst",
  theme: PptxTheme,
): PptxXml | undefined {
  if (!reference) return;
  const idx = number(attr(reference, "idx"), 0, 100_003);
  if (!Number.isInteger(idx)) throw new PptxError("invalid");
  if (idx === 0) return;
  const list = child(theme.formats, kind);
  const offset = kind === "bgFillStyleLst" ? 1001 : 1;
  const value = list?.children[idx - offset];
  if (!value || value.uri !== A) throw new PptxError("unsupported");
  return value;
}
