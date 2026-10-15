import { PptxError } from "./pptx_types";
import { A, P, attr, child, number, root, type PptxXml } from "./pptx_xml";

export interface PptxTheme {
  colors: Map<string, string>;
  fonts: Map<string, string>;
  formats?: PptxXml;
}
export function readTheme(node: PptxXml): PptxTheme {
  root(node, "theme", A);
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
  const rgb = [0, 2, 4].map((at) => parseInt(raw!.slice(at, at + 2), 16));
  for (const effect of n.children) {
    if (effect.uri !== A) throw new PptxError("unsupported");
    const v = number(attr(effect, "val"), 0, 100_000) / 100_000;
    if (effect.name === "alpha" && v === 1) continue;
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
