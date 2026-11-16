import {
  PptxError,
  PPTX_GEOMETRY_LIMITS as G,
  type PptxGroupTransform,
  type PptxWarningCode,
} from "./pptx_types";
import { A, P, attr, child, number, type PptxXml } from "./pptx_xml";
import { emu, flag } from "./pptx_layout";

function known(node: PptxXml, names: string[]): void {
  if (
    node.text.trim() ||
    Object.keys(node.attrs).some(
      (key) =>
        !names.includes(key) &&
        !key.startsWith("http://www.w3.org/2000/xmlns/#"),
    )
  )
    throw new PptxError("unsupported");
}

/** ISO/IEC 29500 DrawingML group transform: off + (point - chOff) * ext/chExt.
 * Apply the child's mapping first, then its parent. Preserve paint order and
 * local typography instead of guessing scaled font sizes or flattening text. */
export function pptxGroup(
  node: PptxXml,
  parent: PptxGroupTransform | undefined,
  warn: (code: PptxWarningCode) => void,
): { transform: PptxGroupTransform; shapes: PptxXml[] } {
  known(node, []);
  const nonVisual = child(node, "nvGrpSpPr", P),
    properties = child(node, "grpSpPr", P);
  if (!nonVisual || !properties) throw new PptxError("invalid");
  known(nonVisual, []);
  for (const n of nonVisual.children) {
    if (n.uri !== P || !["cNvPr", "cNvGrpSpPr", "nvPr"].includes(n.name))
      throw new PptxError("unsupported");
    known(
      n,
      n.name === "cNvPr" ? ["id", "name", "descr", "title", "hidden"] : [],
    );
    for (const c of n.children) {
      if (
        n.name === "cNvPr" &&
        c.uri === A &&
        ["hlinkClick", "hlinkHover", "hlinkMouseOver"].includes(c.name)
      )
        warn("hyperlinks");
      else throw new PptxError("unsupported");
    }
  }
  for (const name of ["cNvPr", "cNvGrpSpPr", "nvPr"])
    if (!child(nonVisual, name, P)) throw new PptxError("invalid");
  known(properties, []);
  const xfrm = child(properties, "xfrm");
  if (!xfrm) throw new PptxError("invalid");
  if (properties.children.length !== 1) throw new PptxError("unsupported");
  known(xfrm, ["rot", "flipH", "flipV"]);
  if (
    flag(attr(xfrm, "flipH"), false) ||
    flag(attr(xfrm, "flipV"), false) ||
    number(attr(xfrm, "rot") ?? "0", -21600000, 21600000) !== 0
  )
    throw new PptxError("unsupported");
  for (const n of xfrm.children) {
    if (n.uri !== A || !["off", "ext", "chOff", "chExt"].includes(n.name))
      throw new PptxError("unsupported");
    known(
      n,
      n.name.endsWith("Off") || n.name === "off" ? ["x", "y"] : ["cx", "cy"],
    );
    if (n.children.length) throw new PptxError("unsupported");
  }
  const off = child(xfrm, "off"),
    ext = child(xfrm, "ext"),
    childOff = child(xfrm, "chOff"),
    childExt = child(xfrm, "chExt");
  if (!off || !ext || !childOff || !childExt) throw new PptxError("invalid");
  const readPoint = (n: PptxXml) => ({
    x: emu(attr(n, "x"), -G.coordinate, G.coordinate),
    y: emu(attr(n, "y"), -G.coordinate, G.coordinate),
  });
  const readSize = (n: PptxXml) => ({
    x: emu(attr(n, "cx"), 0, G.extent),
    y: emu(attr(n, "cy"), 0, G.extent),
  });
  const at = readPoint(off),
    size = readSize(ext),
    origin = readPoint(childOff),
    extent = readSize(childExt);
  if (!extent.x || !extent.y) throw new PptxError("invalid");
  if (!size.x || !size.y) throw new PptxError("unsupported");
  const scaleX = size.x / extent.x,
    scaleY = size.y / extent.y;
  const local = {
    x: at.x - origin.x * scaleX,
    y: at.y - origin.y * scaleY,
    scaleX,
    scaleY,
  };
  const transform = parent
    ? {
        x: parent.x + local.x * parent.scaleX,
        y: parent.y + local.y * parent.scaleY,
        scaleX: parent.scaleX * local.scaleX,
        scaleY: parent.scaleY * local.scaleY,
      }
    : local;
  if (
    Object.values(transform).some((v) => !Number.isFinite(v)) ||
    Math.abs(transform.x) > G.coordinate ||
    Math.abs(transform.y) > G.coordinate ||
    transform.scaleX <= 0 ||
    transform.scaleY <= 0 ||
    transform.scaleX > G.extent ||
    transform.scaleY > G.extent
  )
    throw new PptxError("limit");
  const shapes = node.children.filter(
    (n) => n !== nonVisual && n !== properties,
  );
  if (
    shapes.some((n) => n.uri !== P || !["sp", "pic", "grpSp"].includes(n.name))
  )
    throw new PptxError("unsupported");
  return { transform, shapes };
}
