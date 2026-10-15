import {
  PptxError,
  PPTX_GEOMETRY_LIMITS as G,
  type PptxText,
  type PptxRun,
  type PptxWarningCode,
} from "./pptx_types";
import { A, P, attr, child, children, number, type PptxXml } from "./pptx_xml";
import { emu, flag, placeholder, masterPlaceholderType } from "./pptx_layout";
import {
  checkedFont,
  fontFamily,
  readColor,
  type PptxTheme,
} from "./pptx_theme";

export interface PptxTextContext {
  theme: PptxTheme;
  mapping: Record<string, string>;
  defaults: PptxXml[];
  warn: (code: PptxWarningCode) => void;
  run: (text?: string) => void;
}
interface TextStyle {
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}
const a = (n: PptxXml | undefined, key: string) => n && attr(n, key);
function style(
  n: PptxXml | undefined,
  into: TextStyle,
  c: PptxTextContext,
): void {
  if (!n) return;
  if (a(n, "sz") !== undefined) {
    const size = number(a(n, "sz"), 0, G.fontMax * 75) / 75;
    if (size <= 0) throw new PptxError("limit");
    into.fontSize = size;
  }
  for (const key of ["b", "i"] as const)
    if (a(n, key) !== undefined)
      into[key === "b" ? "bold" : "italic"] = flag(a(n, key), false);
  if (a(n, "u") !== undefined) {
    const u = a(n, "u");
    into.underline = u !== "none";
    if (u !== "none" && u !== "sng") c.warn("unsupportedFormatting");
  }
  if (a(n, "baseline") !== undefined && a(n, "baseline") !== "0")
    throw new PptxError("unsupported");
  for (const key of ["cap", "strike", "spc", "normalizeH", "kumimoji"])
    if (a(n, key) !== undefined && !["0", "false", "none"].includes(a(n, key)!))
      c.warn("unsupportedFormatting");
  const latin = child(n, "latin");
  if (latin) into.fontFamily = fontFamily(a(latin, "typeface") ?? "", c.theme);
  for (const key of ["ea", "cs"]) {
    const family = a(child(n, key), "typeface");
    // Office themes commonly leave these auxiliary collections empty and
    // resolve script fonts per language. This renderer has one Latin family;
    // keep its checked family and state that script typography is partial.
    if (
      family &&
      /^\+(?:mj|mn)-(?:ea|cs)$/.test(family) &&
      !c.theme.fonts.has(family)
    ) {
      c.warn("unsupportedFormatting");
      continue;
    }
    if (
      family &&
      into.fontFamily &&
      fontFamily(family, c.theme) !== into.fontFamily
    )
      c.warn("unsupportedFormatting");
  }
  const fill = child(n, "solidFill");
  if (fill) into.color = readColor(fill, c.theme, c.mapping);
  for (const element of n.children) {
    if (element.uri !== A) throw new PptxError("unsupported");
    if (["solidFill", "latin", "ea", "cs"].includes(element.name)) continue;
    if (["hlinkClick", "hlinkMouseOver"].includes(element.name)) {
      c.warn("hyperlinks");
      continue;
    }
    if (element.name === "effectLst" && !element.children.length) continue;
    // Unknown paint, warp, underline paint or effects cannot silently become
    // a successful plain-text rendering.
    throw new PptxError("unsupported");
  }
}
function paragraphProperties(n: PptxXml | undefined, c: PptxTextContext): void {
  if (!n) return;
  if (
    n.children.filter(
      (element) =>
        element.uri === A &&
        ["buNone", "buChar", "buAutoNum", "buBlip"].includes(element.name),
    ).length > 1
  )
    throw new PptxError("invalid");
  for (const element of n.children) {
    if (element.uri !== A) throw new PptxError("unsupported");
    if (element.name === "defRPr") continue;
    const names = Object.keys(element.attrs).filter(
      (key) => !key.startsWith("http://www.w3.org/2000/xmlns/#"),
    );
    if (["buNone", "buFontTx"].includes(element.name)) {
      if (element.children.length || names.length || element.text.trim())
        throw new PptxError("unsupported");
      continue;
    }
    if (element.name === "buFont") {
      if (
        element.children.length ||
        element.text.trim() ||
        names.some(
          (key) =>
            !["typeface", "panose", "pitchFamily", "charset"].includes(key),
        )
      )
        throw new PptxError("unsupported");
      checkedFont(a(element, "typeface") ?? "");
      continue;
    }
    if (element.name === "buChar") {
      const mark = a(element, "char") ?? "";
      if (Array.from(mark).length !== 1 || /[\p{C}\s]/u.test(mark))
        throw new PptxError("unsupported");
      if (
        element.children.length ||
        element.text.trim() ||
        names.some((key) => key !== "char")
      )
        throw new PptxError("unsupported");
      continue;
    }
    if (["lnSpc", "spcBef", "spcAft", "tabLst"].includes(element.name)) {
      c.warn("unsupportedFormatting");
      continue;
    }
    // Automatic/image bullets remain unsupported; character bullets below
    // retain their actual visible glyph and mark approximate layout partial.
    throw new PptxError("unsupported");
  }
  for (const key of ["marL", "marR", "indent", "defTabSz"])
    if (a(n, key) !== undefined && Number(a(n, key)) !== 0)
      c.warn("unsupportedFormatting");
  if (flag(a(n, "rtl"), false)) throw new PptxError("unsupported");
}
export function text(
  chain: PptxXml[],
  master: PptxXml | undefined,
  context: PptxTextContext,
): PptxText | null {
  const own = child(chain.at(-1), "txBody", P);
  if (!own) return null;
  const bodies = chain
    .map((n) => child(n, "txBody", P))
    .filter((n): n is PptxXml => !!n);
  const bodyProperties = bodies
    .map((n) => child(n, "bodyPr"))
    .filter((n): n is PptxXml => !!n);
  const get = (key: string) =>
    bodyProperties
      .map((n) => attr(n, key))
      .filter((v) => v !== undefined)
      .at(-1);
  const wrap = get("wrap") ?? "square",
    anchor = get("anchor") ?? "t";
  if (!["square", "none"].includes(wrap) || !["t", "ctr", "b"].includes(anchor))
    throw new PptxError("unsupported");
  if (
    (get("vert") ?? "horz") !== "horz" ||
    Number(get("rot") ?? "0") !== 0 ||
    Number(get("numCol") ?? "1") !== 1 ||
    flag(get("rtlCol"), false) ||
    flag(get("anchorCtr"), false) ||
    flag(get("fromWordArt"), false)
  )
    throw new PptxError("unsupported");
  if (
    (get("vertOverflow") ?? "overflow") !== "overflow" ||
    (get("horzOverflow") ?? "overflow") !== "overflow"
  )
    throw new PptxError("unsupported");
  for (const p of bodyProperties) {
    for (const n of p.children) {
      if (n.uri !== A) throw new PptxError("unsupported");
      if (n.name === "noAutofit") continue;
      if (
        n.name === "spAutoFit" &&
        !n.children.length &&
        !Object.keys(n.attrs).some(
          (key) => !key.startsWith("http://www.w3.org/2000/xmlns/#"),
        )
      ) {
        // The stored box is retained; automatic shape resizing is not
        // reproduced by the passive canvas and must stay visibly partial.
        context.warn("unsupportedFormatting");
        continue;
      }
      if (
        n.name === "normAutofit" &&
        (a(n, "fontScale") ?? "100000") === "100000" &&
        (a(n, "lnSpcReduction") ?? "0") === "0"
      )
        continue;
      throw new PptxError("unsupported");
    }
  }
  // Styled sample paragraphs are an extra inheritance source this slice does
  // not model. Never silently fall back to a different master text style.
  for (const inherited of bodies.slice(0, -1)) {
    for (const paragraph of children(inherited, "p")) {
      const p = child(paragraph, "pPr"),
        end = child(paragraph, "endParaRPr");
      if (
        (p &&
          (p.children.length ||
            Object.keys(p.attrs).some((key) => key !== "lvl"))) ||
        (end &&
          (end.children.length ||
            Object.keys(end.attrs).some(
              (key) => !["lang", "dirty"].includes(key),
            )))
      )
        throw new PptxError("unsupported");
    }
  }
  const defaults = [...context.defaults];
  const ph =
    chain.slice(0, -1).reverse().map(placeholder).find(Boolean) ??
    placeholder(chain.at(-1)!);
  const phType = ph && masterPlaceholderType(attr(ph, "type"));
  const kind =
    phType === "title"
      ? "titleStyle"
      : phType === "body"
        ? "bodyStyle"
        : "otherStyle";
  const masterStyle = child(child(master, "txStyles", P), kind, P);
  if (masterStyle) defaults.push(masterStyle);
  for (const b of bodies) {
    const list = child(b, "lstStyle");
    if (list) defaults.push(list);
  }
  const base: TextStyle = { bold: false, italic: false, underline: false };
  for (const n of chain) {
    const ref = child(child(n, "style", P), "fontRef");
    if (ref) {
      const idx = attr(ref, "idx");
      if (idx !== "major" && idx !== "minor")
        throw new PptxError("unsupported");
      base.fontFamily = fontFamily(
        idx === "major" ? "+mj-lt" : "+mn-lt",
        context.theme,
      );
      if (ref.children.length)
        base.color = readColor(ref, context.theme, context.mapping);
    }
  }
  const paragraphs = children(own, "p").map((paragraph) => {
    const direct = child(paragraph, "pPr"),
      level = number(a(direct, "lvl") ?? "0", 0, 8);
    if (!Number.isInteger(level)) throw new PptxError("invalid");
    const properties = defaults
      .flatMap((n) => [child(n, "defPPr"), child(n, `lvl${level + 1}pPr`)])
      .filter((n): n is PptxXml => !!n);
    if (direct) properties.push(direct);
    const resolved = { ...base };
    let alignment: "left" | "center" | "right" = "left";
    let bullet: string | null = null,
      bulletFont: string | undefined;
    for (const p of properties) {
      paragraphProperties(p, context);
      style(child(p, "defRPr"), resolved, context);
      if (child(p, "buNone")) bullet = null;
      const mark = child(p, "buChar");
      if (mark) bullet = attr(mark, "char")!;
      const font = child(p, "buFont");
      if (font) bulletFont = checkedFont(attr(font, "typeface") ?? "");
      if (child(p, "buFontTx")) bulletFont = undefined;
      const algn = attr(p, "algn");
      if (algn !== undefined) {
        if (!["l", "ctr", "r"].includes(algn))
          throw new PptxError("unsupported");
        alignment = algn === "l" ? "left" : algn === "ctr" ? "center" : "right";
      }
    }
    const runs: PptxRun[] = [];
    for (const n of paragraph.children) {
      if (n.uri !== A) throw new PptxError("unsupported");
      if (["pPr", "endParaRPr"].includes(n.name)) continue;
      if (n.name === "br") {
        if (n.children.length) context.warn("unsupportedFormatting");
        context.run();
        runs.push({ kind: "break" });
        continue;
      }
      if (n.name !== "r") throw new PptxError("unsupported");
      const t = child(n, "t");
      if (
        !t ||
        t.children.length ||
        n.children.some((v) => v.uri !== A || !["rPr", "t"].includes(v.name))
      )
        throw new PptxError("invalid");
      const value = { ...resolved };
      style(child(n, "rPr"), value, context);
      if (!value.fontFamily || value.fontSize === undefined || !value.color)
        throw new PptxError("unsupported");
      context.run(t.text);
      context.warn("fontSubstitution");
      runs.push({
        kind: "text",
        text: t.text,
        fontFamily: value.fontFamily,
        fontSize: value.fontSize,
        color: value.color,
        bold: value.bold,
        italic: value.italic,
        underline: value.underline,
      });
    }
    const first = runs.find((run) => run.kind === "text" && run.text.length);
    if (bullet && first?.kind === "text") {
      context.run(bullet + " ");
      context.warn("unsupportedFormatting");
      runs.unshift({
        ...first,
        text: bullet + " ",
        fontFamily: bulletFont ?? first.fontFamily,
      });
    }
    if (!runs.length) context.warn("unsupportedFormatting");
    return { alignment, runs };
  });
  if (
    own.children.some(
      (n) => n.uri !== A || !["bodyPr", "lstStyle", "p"].includes(n.name),
    )
  )
    throw new PptxError("unsupported");
  return {
    inset: {
      left: emu(get("lIns") ?? "91440", 0, G.inset),
      right: emu(get("rIns") ?? "91440", 0, G.inset),
      top: emu(get("tIns") ?? "45720", 0, G.inset),
      bottom: emu(get("bIns") ?? "45720", 0, G.inset),
    },
    wrap: wrap as "none" | "square",
    verticalAlign:
      anchor === "ctr" ? "center" : anchor === "b" ? "bottom" : "top",
    paragraphs,
  };
}
