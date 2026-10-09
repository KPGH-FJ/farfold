import { DOCX_LIMITS, DocxError } from "./docx_types";
import { DocxPackage } from "./docx_package";
import {
  W,
  attr,
  child,
  children,
  number,
  root,
  val,
  type DocxXml,
} from "./docx_xml";
import type { Warn } from "./docx_styles";

export class DocxNumbering {
  private abstract = new Map<string, DocxXml>();
  private instances = new Map<string, DocxXml>();
  private counters = new Map<string, number[]>();
  constructor(
    pkg: DocxPackage,
    private warn: Warn,
  ) {
    const path = pkg.one(pkg.document, "numbering");
    if (!path) return;
    const tree = pkg.xml(path);
    root(tree, "numbering");
    for (const n of tree.children) {
      if (n.uri !== W) throw new DocxError("unsupported");
      if (n.name === "abstractNum" || n.name === "num") {
        const id = attr(n, n.name === "num" ? "numId" : "abstractNumId"),
          target = n.name === "num" ? this.instances : this.abstract;
        if (!id || target.has(id)) throw new DocxError("invalid");
        if (target.size >= DOCX_LIMITS.styles) throw new DocxError("limit");
        target.set(id, n);
      } else if (n.name !== "numIdMacAtCleanup") this.warn("listFormat");
    }
  }
  next(source: string, id: string, level: number): string {
    const instance = this.instances.get(id),
      abstractId = instance && val(child(instance, "abstractNumId"));
    const definition = abstractId && this.abstract.get(abstractId);
    if (!instance || !definition) throw new DocxError("invalid");
    const levels = new Map<number, DocxXml>();
    for (const n of children(definition, "lvl")) {
      const index = number(attr(n, "ilvl"), 0, 8);
      if (!Number.isInteger(index)) throw new DocxError("invalid");
      if (levels.has(index)) throw new DocxError("invalid");
      levels.set(index, n);
    }
    const overrides = new Map<number, DocxXml>();
    for (const n of children(instance, "lvlOverride")) {
      const index = number(attr(n, "ilvl"), 0, 8);
      if (!Number.isInteger(index)) throw new DocxError("invalid");
      if (overrides.has(index)) throw new DocxError("invalid");
      overrides.set(index, n);
      if (child(n, "lvl")) levels.set(index, child(n, "lvl")!);
    }
    const current = levels.get(level);
    if (!current) throw new DocxError("invalid");
    const key = source + "\0" + id,
      counts = this.counters.get(key) ?? [];
    const initial = (i: number) => {
      const value = number(
        val(child(overrides.get(i), "startOverride")) ??
          val(child(levels.get(i), "start")) ??
          "1",
        0,
        1_000_000,
      );
      if (!Number.isInteger(value)) throw new DocxError("invalid");
      return value;
    };
    for (let i = 0; i < level; i++) counts[i] ??= initial(i);
    counts[level] =
      counts[level] === undefined ? initial(level) : counts[level] + 1;
    if (counts[level] > 1_000_000) throw new DocxError("limit");
    // Defaults restart deeper levels; explicit custom restart is not guessed.
    for (let i = level + 1; i < 9; i++) {
      const restart = val(child(levels.get(i), "lvlRestart"));
      if (restart === "0") continue;
      if (restart !== undefined && Number(restart) !== level + 1) {
        this.warn("listFormat");
        continue;
      }
      delete counts[i];
    }
    this.counters.set(key, counts);
    const format = val(child(current, "numFmt")) ?? "decimal",
      template = val(child(current, "lvlText")) ?? "%1.";
    if (template.length > 256) throw new DocxError("limit");
    if (format === "bullet") {
      const fonts = child(child(current, "rPr"), "rFonts");
      // Adobe Symbol's B7 is Unicode BULLET (Unicode vendor mapping). Word's
      // symbol-font PUA representation is F000 + the original byte.
      const font = fonts
        ? (attr(fonts, "ascii") ?? attr(fonts, "hAnsi"))
        : undefined;
      if (template === "\uF0B7" && font?.toLowerCase() === "symbol") {
        this.warn("fontSubstitution");
        return "\u2022";
      }
      if (/[\uE000-\uF8FF]/.test(template)) {
        this.warn("listFormat", true);
        return Array.from(template, (c) =>
          /[\uE000-\uF8FF]/.test(c)
            ? `[U+${c.codePointAt(0)!.toString(16).toUpperCase()}]`
            : c,
        ).join("");
      }
      if (child(current, "rPr")) this.warn("unsupportedFormatting");
      return template;
    }
    if (format === "none") return "";
    let unsupported = false;
    const result = template.replace(/%([1-9])/g, (_, digit: string) => {
      const i = Number(digit) - 1,
        value = counts[i] ?? initial(i),
        kind = val(child(levels.get(i), "numFmt")) ?? "decimal";
      if (kind === "decimal") return String(value);
      if (kind === "decimalZero") return String(value).padStart(2, "0");
      if (["lowerLetter", "upperLetter"].includes(kind) && value > 0) {
        let n = value,
          text = "";
        while (n) {
          n--;
          text = String.fromCharCode(97 + (n % 26)) + text;
          n = Math.floor(n / 26);
        }
        return kind === "upperLetter" ? text.toUpperCase() : text;
      }
      if (
        ["lowerRoman", "upperRoman"].includes(kind) &&
        value > 0 &&
        value < 4000
      ) {
        let n = value,
          text = "";
        for (const [size, token] of [
          [1000, "M"],
          [900, "CM"],
          [500, "D"],
          [400, "CD"],
          [100, "C"],
          [90, "XC"],
          [50, "L"],
          [40, "XL"],
          [10, "X"],
          [9, "IX"],
          [5, "V"],
          [4, "IV"],
          [1, "I"],
        ] as const)
          while (n >= size) {
            n -= size;
            text += token;
          }
        return kind === "lowerRoman" ? text.toLowerCase() : text;
      }
      unsupported = true;
      return "?";
    });
    if (unsupported) this.warn("listFormat", true);
    return result;
  }
}
