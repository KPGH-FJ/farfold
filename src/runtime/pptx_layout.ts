import {
  PptxError,
  PPTX_GEOMETRY_LIMITS as G,
  type PptxBox,
} from "./pptx_types";
import { A, P, attr, child, number, type PptxXml } from "./pptx_xml";

export interface PptxLayer {
  part: string;
  node: PptxXml;
  shapes: PptxXml[];
}
export function flag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (["1", "true"].includes(raw)) return true;
  if (["0", "false"].includes(raw)) return false;
  throw new PptxError("invalid");
}
export function placeholder(shape: PptxXml): PptxXml | undefined {
  const nv = shape.children.find(
    (n) => n.uri === P && /^nv(?:Sp|Pic|CxnSp|GraphicFrame)Pr$/.test(n.name),
  );
  return child(child(nv, "nvPr", P), "ph", P);
}
export function shapeId(shape: PptxXml): string {
  const nv = shape.children.find((n) => n.uri === P && n.name.startsWith("nv"));
  const id = child(nv, "cNvPr", P);
  const raw = id && attr(id, "id");
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new PptxError("invalid");
  return raw;
}
export function hiddenShape(shape: PptxXml): boolean {
  const nv = shape.children.find((n) => n.uri === P && n.name.startsWith("nv"));
  const props = child(nv, "cNvPr", P);
  return flag(props && attr(props, "hidden"), false);
}
export function layer(part: string, node: PptxXml): PptxLayer {
  const tree = child(child(node, "cSld", P), "spTree", P);
  if (!tree) throw new PptxError("invalid");
  const shapes: PptxXml[] = [],
    ids = new Set<string>();
  for (const n of tree.children) {
    if (n.uri === P && n.name === "nvGrpSpPr") continue;
    if (n.uri === P && n.name === "grpSpPr") {
      // The root shape-tree container is not a group. Nonidentity transforms
      // would require a separate affine transform implementation.
      const transform = child(n, "xfrm");
      if (transform) {
        if (
          Object.keys(transform.attrs).some(
            (k) => !["rot", "flipH", "flipV"].includes(k),
          )
        )
          throw new PptxError("unsupported");
        for (const v of Object.values(transform.attrs))
          if (!["0", "false"].includes(v)) throw new PptxError("unsupported");
        for (const c of transform.children) {
          if (
            c.uri !== A ||
            !["off", "ext", "chOff", "chExt"].includes(c.name) ||
            Object.values(c.attrs).some((v) => Number(v) !== 0)
          )
            throw new PptxError("unsupported");
        }
      }
      continue;
    }
    if (n.uri === P && n.name === "extLst") throw new PptxError("unsupported");
    if (
      n.uri !== P ||
      !["sp", "pic", "grpSp", "cxnSp", "graphicFrame", "contentPart"].includes(
        n.name,
      )
    )
      throw new PptxError("unsupported");
    const id = shapeId(n);
    if (ids.has(id)) throw new PptxError("invalid");
    ids.add(id);
    shapes.push(n);
  }
  return { part, node, shapes };
}
/** Regular slide layouts map related placeholder categories to a master role.
 * python-pptx's LayoutPlaceholder._base_placeholder and its published layout
 * observations agree on this table; idx is not a master join key. Notes-only
 * types and unknown roles are deliberately unsupported. */
export function masterPlaceholderType(raw: string | undefined): string {
  const mapping: Record<string, string> = {
    title: "title",
    ctrTitle: "title",
    body: "body",
    subTitle: "body",
    obj: "body",
    pic: "body",
    chart: "body",
    clipArt: "body",
    dgm: "body",
    media: "body",
    tbl: "body",
    dt: "dt",
    ftr: "ftr",
    sldNum: "sldNum",
  };
  const result = Object.hasOwn(mapping, raw ?? "obj")
    ? mapping[raw ?? "obj"]
    : undefined;
  if (!result) throw new PptxError("unsupported");
  return result;
}
/** Slide-to-layout uses idx (default 0), layout-to-master the explicit role
 * mapping above. Shape IDs are never placeholder join keys. */
export function inheritance(
  shape: PptxXml,
  layout: PptxLayer | undefined,
  master: PptxLayer | undefined,
): PptxXml[] {
  const ph = placeholder(shape);
  if (!ph) return [shape];
  masterPlaceholderType(attr(ph, "type"));
  const idx = attr(ph, "idx") ?? "0";
  const layouts =
    layout?.shapes.filter((s) => {
      const p = placeholder(s);
      return p && (attr(p, "idx") ?? "0") === idx;
    }) ?? [];
  if (layouts.length > 1) throw new PptxError("invalid");
  const l = layouts[0];
  if (!l) return [shape];
  const type = masterPlaceholderType(attr(placeholder(l)!, "type"));
  const masters =
    master?.shapes.filter((s) => {
      const p = placeholder(s);
      return p && (attr(p, "type") ?? "obj") === type;
    }) ?? [];
  if (masters.length > 1) throw new PptxError("unsupported");
  return [...masters, ...(l ? [l] : []), shape];
}
export function emu(raw: string | undefined, min: number, max: number): number {
  const value = number(raw, min * 9525, max * 9525) / 9525;
  if (!Number.isFinite(value)) throw new PptxError("limit");
  return value;
}
export function box(chain: PptxXml[]): PptxBox {
  let found: PptxXml | undefined;
  for (const s of chain) {
    const x = child(child(s, "spPr", P), "xfrm");
    if (x) found = x;
  }
  if (!found) throw new PptxError("unsupported");
  if (
    flag(attr(found, "flipH"), false) ||
    flag(attr(found, "flipV"), false) ||
    number(attr(found, "rot") ?? "0", -21600000, 21600000) !== 0
  )
    throw new PptxError("unsupported");
  if (
    found.children.some((n) => n.uri !== A || !["off", "ext"].includes(n.name))
  )
    throw new PptxError("unsupported");
  const off = child(found, "off"),
    ext = child(found, "ext");
  if (!off || !ext) throw new PptxError("invalid");
  return {
    x: emu(attr(off, "x"), -G.coordinate, G.coordinate),
    y: emu(attr(off, "y"), -G.coordinate, G.coordinate),
    width: emu(attr(ext, "cx"), 0, G.extent),
    height: emu(attr(ext, "cy"), 0, G.extent),
  };
}
