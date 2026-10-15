import {
  PptxError,
  PPTX_GEOMETRY_LIMITS as G,
  type PptxShape,
  type PptxSource,
} from "./pptx_types";
import { A, P, R, attr, child, number, type PptxXml } from "./pptx_xml";
import { box, emu, flag, shapeId } from "./pptx_layout";
import { matrixStyle, readColor } from "./pptx_theme";
import { text, type PptxTextContext } from "./pptx_text";
import type { PptxPackage } from "./pptx_package";
import type { PptxImages } from "./pptx_images";

export interface PptxShapeContext extends PptxTextContext {
  pkg: PptxPackage;
  images: PptxImages;
  master?: PptxXml;
}
function properties(chain: PptxXml[]): PptxXml[] {
  return chain.map((n) => child(n, "spPr", P)).filter((n): n is PptxXml => !!n);
}
function last(chain: PptxXml[], names: string[], uri = A): PptxXml | undefined {
  let result: PptxXml | undefined;
  for (const n of chain) {
    const matches = n.children.filter(
      (v) => v.uri === uri && names.includes(v.name),
    );
    if (matches.length > 1) throw new PptxError("invalid");
    if (matches.length) result = matches[0];
  }
  return result;
}
function reference(chain: PptxXml[], name: string): PptxXml | undefined {
  return last(
    chain.map((n) => child(n, "style", P)).filter((n): n is PptxXml => !!n),
    [name],
  );
}
const fills = [
  "solidFill",
  "noFill",
  "gradFill",
  "blipFill",
  "pattFill",
  "grpFill",
];
function fill(
  chain: PptxXml[],
  props: PptxXml[],
  c: PptxShapeContext,
): string | null | undefined {
  const direct = last(props, fills);
  if (direct) {
    if (direct.name === "noFill") return null;
    if (direct.name !== "solidFill") throw new PptxError("unsupported");
    return readColor(direct, c.theme, c.mapping);
  }
  const ref = reference(chain, "fillRef");
  if (!ref) return;
  const idx = number(attr(ref, "idx"), 0, 100_003);
  if (idx === 0) return null;
  const format = matrixStyle(
    ref,
    idx >= 1001 ? "bgFillStyleLst" : "fillStyleLst",
    c.theme,
  );
  if (!format || format.name !== "solidFill")
    throw new PptxError("unsupported");
  return readColor(
    format,
    c.theme,
    c.mapping,
    readColor(ref, c.theme, c.mapping),
  );
}
function stroke(
  chain: PptxXml[],
  props: PptxXml[],
  c: PptxShapeContext,
): { color: string; width: number } | null | undefined {
  const ref = reference(chain, "lnRef");
  const format = matrixStyle(ref, "lnStyleLst", c.theme);
  const lines = [
    ...(format ? [format] : []),
    ...props.map((n) => child(n, "ln")).filter((n): n is PptxXml => !!n),
  ];
  if (!lines.length) return ref ? null : undefined;
  let width = 12700 / 9525;
  for (const n of lines) {
    if (attr(n, "w") !== undefined) width = emu(attr(n, "w"), 0, G.stroke);
    for (const key of ["cap", "cmpd", "algn"]) {
      const v = attr(n, key);
      if (
        v !== undefined &&
        v !== { cap: "flat", cmpd: "sng", algn: "ctr" }[key]
      )
        throw new PptxError("unsupported");
    }
    for (const v of n.children) {
      if (v.uri !== A) throw new PptxError("unsupported");
      if (fills.includes(v.name)) continue;
      if (v.name === "prstDash" && attr(v, "val") === "solid") continue;
      if (v.name === "miter") continue;
      if (
        ["headEnd", "tailEnd"].includes(v.name) &&
        (attr(v, "type") ?? "none") === "none"
      )
        continue;
      throw new PptxError("unsupported");
    }
  }
  const paint = last(lines, fills);
  if (!paint) throw new PptxError("unsupported");
  if (paint.name === "noFill") return null;
  if (paint.name !== "solidFill") throw new PptxError("unsupported");
  const ph = ref?.children.length
    ? readColor(ref, c.theme, c.mapping)
    : undefined;
  return { color: readColor(paint, c.theme, c.mapping, ph), width };
}
function effects(
  chain: PptxXml[],
  props: PptxXml[],
  c: PptxShapeContext,
): void {
  const own = last(props, ["effectLst", "effectDag"]);
  if (own) {
    if (own.name !== "effectLst" || own.children.length)
      throw new PptxError("unsupported");
    return;
  }
  const ref = reference(chain, "effectRef");
  const style = matrixStyle(ref, "effectStyleLst", c.theme);
  if (
    style &&
    style.children.some(
      (n) => n.uri !== A || n.name !== "effectLst" || n.children.length,
    )
  )
    throw new PptxError("unsupported");
}
function geometry(
  chain: PptxXml[],
  props: PptxXml[],
): "rect" | "ellipse" | null {
  const n = last(props, ["prstGeom", "custGeom"]);
  if (n) {
    const preset = attr(n, "prst");
    if (
      n.name !== "prstGeom" ||
      (preset !== "rect" && preset !== "ellipse") ||
      n.children.some(
        (v) => v.uri !== A || v.name !== "avLst" || v.children.length,
      )
    )
      throw new PptxError("unsupported");
    return preset;
  }
  const nv = child(chain.at(-1), "nvSpPr", P),
    sp = child(nv, "cNvSpPr", P);
  if (flag(sp && attr(sp, "txBox"), false)) return null;
  throw new PptxError("unsupported");
}
export function shape(
  chain: PptxXml[],
  part: string,
  layer: PptxSource["layer"],
  c: PptxShapeContext,
): PptxShape {
  const own = chain.at(-1)!;
  if (own.name !== "sp" && own.name !== "pic")
    throw new PptxError("unsupported");
  if (flag(attr(own, "useBgFill"), false)) throw new PptxError("unsupported");
  const nonVisual = child(own, own.name === "pic" ? "nvPicPr" : "nvSpPr", P);
  const nonVisualProperties = child(nonVisual, "nvPr", P);
  if (nonVisualProperties?.children.some((n) => n.uri !== P || n.name !== "ph"))
    throw new PptxError("unsupported");
  const commonProperties = child(nonVisual, "cNvPr", P);
  for (const n of commonProperties?.children ?? []) {
    if (
      n.uri === A &&
      ["hlinkClick", "hlinkHover", "hlinkMouseOver"].includes(n.name)
    )
      c.warn("hyperlinks");
    else throw new PptxError("unsupported");
  }
  for (const node of chain) {
    const style = child(node, "style", P);
    if (
      style?.children.some(
        (n) =>
          n.uri !== A ||
          !["lnRef", "fillRef", "effectRef", "fontRef"].includes(n.name),
      )
    )
      throw new PptxError("unsupported");
  }
  const id = shapeId(own),
    source = { part, shapeId: id, layer },
    bounds = box(chain),
    props = properties(chain);
  for (const p of props)
    for (const n of p.children)
      if (
        n.uri !== A ||
        ![
          "xfrm",
          "prstGeom",
          "custGeom",
          ...fills,
          "ln",
          "effectLst",
          "effectDag",
        ].includes(n.name)
      )
        throw new PptxError("unsupported");
  for (const n of own.children) {
    if (
      n.uri !== P ||
      !["nvSpPr", "nvPicPr", "spPr", "style", "txBody", "blipFill"].includes(
        n.name,
      )
    )
      throw new PptxError("unsupported");
  }
  const identifier = `${layer}:${part}#${id}`;
  effects(chain, props, c);
  if (own.name === "sp") {
    const geom = geometry(chain, props),
      paint = fill(chain, props, c),
      line = stroke(chain, props, c),
      tx = text(chain, c.master, c);
    // No undocumented fill/line defaults: ordinary geometry needs explicit
    // paint, an inherited paint, or an actual theme style reference.
    if (geom === null && (paint || line)) throw new PptxError("unsupported");
    if (geom !== null && (paint === undefined || line === undefined))
      throw new PptxError("unsupported");
    return {
      kind: "shape",
      id: identifier,
      source,
      box: bounds,
      geometry: geom,
      fill: paint ?? null,
      stroke: line ?? null,
      text: tx,
    };
  }
  if (bounds.width <= 0 || bounds.height <= 0) throw new PptxError("invalid");
  if (fill(chain, props, c)) throw new PptxError("unsupported");
  if (geometry(chain, props) !== "rect") throw new PptxError("unsupported");
  const line = stroke(chain, props, c);
  if (line) throw new PptxError("unsupported");
  const blipFill = child(own, "blipFill", P),
    blip = child(blipFill, "blip"),
    stretch = child(blipFill, "stretch");
  if (!blipFill || !blip || !stretch || !child(stretch, "fillRect"))
    throw new PptxError("unsupported");
  if (attr(blip, "link", R)) throw new PptxError("unsupported");
  if (
    blipFill.children.some(
      (n) => n.uri !== A || !["blip", "srcRect", "stretch"].includes(n.name),
    )
  )
    throw new PptxError("unsupported");
  for (const n of [child(blipFill, "srcRect"), child(stretch, "fillRect")])
    if (n && Object.values(n.attrs).some((v) => Number(v) !== 0))
      throw new PptxError("unsupported");
  for (const n of blip.children)
    if (
      n.uri !== A ||
      n.name !== "alphaModFix" ||
      (attr(n, "amt") ?? "100000") !== "100000"
    )
      throw new PptxError("unsupported");
  const embed = attr(blip, "embed", R),
    relation = embed && c.pkg.relation(part, embed);
  if (!relation || relation.external || relation.type !== R + "/image")
    throw new PptxError("invalid");
  const image = c.images.get(relation.target);
  return {
    kind: "image",
    id: identifier,
    source,
    box: bounds,
    imageId: image.id,
  };
}
