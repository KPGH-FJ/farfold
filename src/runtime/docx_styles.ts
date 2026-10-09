import {
  DOCX_LIMITS,
  DocxError,
  type DocxParagraphStyle,
  type DocxTextStyle,
  type DocxWarningCode,
} from "./docx_types";
import { DocxPackage } from "./docx_package";
import {
  A,
  W,
  attr,
  child,
  children,
  number,
  onOff,
  root,
  val,
  type DocxXml,
} from "./docx_xml";

export type Warn = (code: DocxWarningCode, partial?: boolean) => void;
export interface TextStyle extends DocxTextStyle {
  hidden?: boolean;
  webHidden?: boolean;
}
export interface ResolvedStyle {
  text: TextStyle;
  paragraph: DocxParagraphStyle;
  headingLevel?: number;
  numbering?: { id: string; level: number };
}
const HIGHLIGHT: Record<string, string> = {
  black: "#000000",
  blue: "#0000FF",
  cyan: "#00FFFF",
  green: "#00FF00",
  magenta: "#FF00FF",
  red: "#FF0000",
  yellow: "#FFFF00",
  white: "#FFFFFF",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  darkGray: "#808080",
  lightGray: "#C0C0C0",
};
export class DocxStyles {
  private styles = new Map<string, DocxXml>();
  private theme = new Map<string, string>();
  private defaults?: DocxXml;
  private defaultParagraph?: string;
  constructor(
    pkg: DocxPackage,
    private warn: Warn,
  ) {
    const theme = pkg.one(pkg.document, "theme");
    if (theme) {
      const tree = pkg.xml(theme);
      root(tree, "theme", A);
      const scheme = child(child(tree, "themeElements", A), "clrScheme", A);
      for (const n of scheme?.children ?? []) {
        if (n.uri !== A) continue;
        const color = child(n, "srgbClr", A) ?? child(n, "sysClr", A);
        const value =
          color && (attr(color, "lastClr", "") ?? attr(color, "val", ""));
        if (value && /^[\da-f]{6}$/i.test(value))
          this.theme.set(n.name, "#" + value.toUpperCase());
      }
    }
    const path = pkg.one(pkg.document, "styles");
    if (!path) return;
    const tree = pkg.xml(path);
    root(tree, "styles");
    this.defaults = child(tree, "docDefaults");
    for (const n of children(tree, "style")) {
      const id = attr(n, "styleId");
      if (!id || this.styles.has(id)) throw new DocxError("invalid");
      if (this.styles.size >= DOCX_LIMITS.styles) throw new DocxError("limit");
      this.styles.set(id, n);
      if (
        attr(n, "type") === "paragraph" &&
        ["1", "true", "on"].includes(attr(n, "default") ?? "")
      ) {
        if (this.defaultParagraph) throw new DocxError("invalid");
        this.defaultParagraph = id;
      }
    }
    // Cycles in unused styles are invalid as well; do not defer them to rendering.
    for (const [id, n] of this.styles)
      this.chain(id, attr(n, "type") ?? "paragraph");
  }
  private chain(id: string, type: string): DocxXml[] {
    const seen = new Set<string>(),
      result: DocxXml[] = [];
    let next: string | undefined = id;
    while (next) {
      if (seen.has(next)) throw new DocxError("invalid");
      if (seen.size >= DOCX_LIMITS.depth) throw new DocxError("limit");
      seen.add(next);
      const n = this.styles.get(next);
      if (!n || attr(n, "type") !== type) {
        this.warn("unsupportedFormatting");
        break;
      }
      result.unshift(n);
      next = val(child(n, "basedOn"));
    }
    return result;
  }
  color(n: DocxXml, valueName = "val"): string | undefined {
    const raw = attr(n, valueName);
    let value =
      raw && /^[\da-f]{6}$/i.test(raw) ? "#" + raw.toUpperCase() : undefined;
    const themeName = attr(n, "themeColor") ?? attr(n, "themeFill");
    if (themeName) {
      const aliases: Record<string, string> = {
        dark1: "dk1",
        light1: "lt1",
        dark2: "dk2",
        light2: "lt2",
        hyperlink: "hlink",
        followedHyperlink: "folHlink",
      };
      value = this.theme.get(aliases[themeName] ?? themeName);
    }
    if (value) {
      const tint = attr(n, "themeTint") ?? attr(n, "themeFillTint"),
        shade = attr(n, "themeShade") ?? attr(n, "themeFillShade");
      if (tint || shade) {
        const variant = tint ?? shade!;
        if (!/^[\da-f]{2}$/i.test(variant) || (tint && shade)) {
          this.warn("unsupportedFormatting");
          return value;
        }
        const amount = parseInt(variant, 16) / 255;
        value =
          "#" +
          [1, 3, 5]
            .map((at) => {
              const c = parseInt(value!.slice(at, at + 2), 16);
              return Math.round(tint ? c + (255 - c) * amount : c * amount)
                .toString(16)
                .padStart(2, "0");
            })
            .join("")
            .toUpperCase();
      }
      return value;
    }
    if (raw !== undefined && raw !== "auto" && raw !== "nil")
      this.warn("unsupportedFormatting");
    if (themeName) this.warn("unsupportedFormatting");
    return undefined;
  }
  runProperties(
    n: DocxXml | undefined,
    base: TextStyle,
    isStyle = false,
  ): TextStyle {
    const result = { ...base };
    for (const p of n?.children ?? []) {
      if (p.uri !== W) {
        this.warn("unsupportedFormatting");
        continue;
      }
      const toggles: Record<string, "bold" | "italic" | "strike" | "hidden"> = {
        b: "bold",
        i: "italic",
        strike: "strike",
        vanish: "hidden",
      };
      if (p.name in toggles) {
        const key = toggles[p.name],
          enabled = onOff(p);
        if (!isStyle) result[key] = enabled;
        else if (enabled) result[key] = !result[key];
        continue;
      }
      switch (p.name) {
        case "sz":
          result.fontSizePt = number(val(p), 1, 800) / 2;
          break;
        case "color":
          result.color = this.color(p);
          break;
        case "highlight": {
          const v = val(p);
          if (v === "none") result.background = undefined;
          else if (v && HIGHLIGHT[v]) result.background = HIGHLIGHT[v];
          else this.warn("unsupportedFormatting");
          break;
        }
        case "shd":
          result.background = this.color(p, "fill");
          if (val(p) && !["clear", "nil", "solid"].includes(val(p)!))
            this.warn("unsupportedFormatting");
          break;
        case "u": {
          const v = val(p) ?? "single";
          if (["single", "double", "none"].includes(v))
            result.underline = v as DocxTextStyle["underline"];
          else this.warn("unsupportedFormatting");
          break;
        }
        case "vertAlign": {
          const v = val(p);
          if (["baseline", "superscript", "subscript"].includes(v ?? ""))
            result.verticalAlign = v as DocxTextStyle["verticalAlign"];
          else this.warn("unsupportedFormatting");
          break;
        }
        case "rFonts":
          this.warn("fontSubstitution");
          break;
        case "webHidden":
          result.webHidden = onOff(p);
          break;
        case "specVanish":
          throw new DocxError("unsupported");
        case "rPrChange":
          throw new DocxError("unsupported");
        case "rStyle":
        case "lang":
        case "noProof":
          break;
        default:
          this.warn("unsupportedFormatting");
      }
    }
    return result;
  }
  private paragraphProperties(
    n: DocxXml | undefined,
    base: ResolvedStyle,
  ): ResolvedStyle {
    const result = { ...base, paragraph: { ...base.paragraph } };
    for (const p of n?.children ?? []) {
      if (p.uri !== W) {
        this.warn("unsupportedFormatting");
        continue;
      }
      switch (p.name) {
        case "jc": {
          const aliases: Record<
            string,
            "left" | "right" | "center" | "justify"
          > = {
            left: "left",
            start: "left",
            right: "right",
            end: "right",
            center: "center",
            both: "justify",
          };
          const v = aliases[val(p) ?? ""];
          if (v) result.paragraph.alignment = v;
          else this.warn("unsupportedFormatting");
          break;
        }
        case "ind": {
          for (const [source, target] of [
            ["left", "leftPt"],
            ["right", "rightPt"],
            ["firstLine", "firstLinePt"],
          ] as const) {
            const v = attr(p, source);
            if (v !== undefined)
              result.paragraph[target] = number(v, -31680, 31680) / 20;
          }
          if (attr(p, "hanging") !== undefined)
            result.paragraph.firstLinePt =
              -number(attr(p, "hanging"), 0, 31680) / 20;
          if (
            [
              "start",
              "end",
              "leftChars",
              "rightChars",
              "firstLineChars",
              "hangingChars",
            ].some((a) => attr(p, a) !== undefined)
          )
            this.warn("unsupportedFormatting");
          break;
        }
        case "spacing": {
          for (const [source, target] of [
            ["before", "spaceBeforePt"],
            ["after", "spaceAfterPt"],
          ] as const) {
            const v = attr(p, source);
            if (v !== undefined)
              result.paragraph[target] = number(v, 0, 31680) / 20;
          }
          if (attr(p, "line") !== undefined) {
            if (!attr(p, "lineRule") || attr(p, "lineRule") === "auto")
              result.paragraph.lineHeight =
                number(attr(p, "line"), 1, 2400) / 240;
            else this.warn("unsupportedFormatting");
          }
          break;
        }
        case "outlineLvl": {
          const level = number(val(p), 0, 9);
          if (!Number.isInteger(level)) throw new DocxError("invalid");
          result.headingLevel = level < 9 ? level + 1 : undefined;
          break;
        }
        case "numPr": {
          const id = val(child(p, "numId")) ?? result.numbering?.id;
          if (id === "0") result.numbering = undefined;
          else if (id) {
            const level = number(
              val(child(p, "ilvl")) ?? String(result.numbering?.level ?? 0),
              0,
              8,
            );
            if (!Number.isInteger(level)) throw new DocxError("invalid");
            result.numbering = { id, level };
          }
          break;
        }
        case "pPrChange":
          throw new DocxError("unsupported");
        case "rPr":
          if (child(p, "specVanish")) throw new DocxError("unsupported");
          break;
        case "pStyle":
        case "sectPr":
        case "keepNext":
        case "keepLines":
        case "widowControl":
        case "pageBreakBefore":
        case "suppressAutoHyphens":
        case "contextualSpacing":
        case "snapToGrid":
          break;
        default:
          this.warn("unsupportedFormatting");
      }
    }
    return result;
  }
  paragraph(properties: DocxXml | undefined): ResolvedStyle {
    let result: ResolvedStyle = {
      text: this.runProperties(
        child(child(this.defaults, "rPrDefault"), "rPr"),
        {},
      ),
      paragraph: {},
    };
    result = this.paragraphProperties(
      child(child(this.defaults, "pPrDefault"), "pPr"),
      result,
    );
    const id = val(child(properties, "pStyle")) ?? this.defaultParagraph;
    if (id)
      for (const n of this.chain(id, "paragraph")) {
        result = this.paragraphProperties(child(n, "pPr"), result);
        result.text = this.runProperties(child(n, "rPr"), result.text, true);
      }
    return this.paragraphProperties(properties, result);
  }
  run(properties: DocxXml | undefined, base: TextStyle): TextStyle {
    let text = { ...base };
    const id = val(child(properties, "rStyle"));
    if (id)
      for (const n of this.chain(id, "character"))
        text = this.runProperties(child(n, "rPr"), text, true);
    return this.runProperties(properties, text);
  }
}
