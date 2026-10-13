import { formatXlsxValue } from "./xlsx_format";
import {
  attr,
  boolean,
  child,
  children,
  integer,
  type XmlNode,
} from "./xlsx_xml";
import { XlsxError, type XlsxStyle } from "./xlsx_types";

export type FormulaProtection = "hidden" | "visible" | "unknown";
/** Only an explicit application of a known local protection is authoritative.
 * Ambiguous inheritance is retained as unknown, never guessed visible. */
export function inputFormulaProtection(
  root: XmlNode | undefined,
  count: number,
): FormulaProtection[] {
  if (!root) return Array.from({ length: count }, () => "visible");
  const bases = children(
    child(root, "cellStyleXfs") ?? { ...root, children: [] },
    "xf",
  );
  const cells = children(
    child(root, "cellXfs") ?? { ...root, children: [] },
    "xf",
  );
  if (!cells.length) return Array.from({ length: count }, () => "visible");
  return cells.map((xf) => {
    const baseId = attr(xf, "xfId"),
      base =
        baseId === undefined
          ? undefined
          : bases[integer(baseId, 0, bases.length - 1)];
    const local = child(xf, "protection"),
      inherited = base && child(base, "protection");
    const localHidden = local ? boolean(attr(local, "hidden")) : false;
    const baseHidden = inherited ? boolean(attr(inherited, "hidden")) : false;
    if (local) {
      if (local.children.length || local.text.trim())
        throw new XlsxError("invalid");
      if (attr(local, "locked") !== undefined) boolean(attr(local, "locked"));
    }
    const apply = attr(xf, "applyProtection");
    if (apply !== undefined) {
      const applies = boolean(apply);
      if (applies && local) return localHidden ? "hidden" : "visible";
      if (applies && !local && !baseHidden) return "visible";
      if (!applies && !baseHidden) return "visible";
    }
    return localHidden || baseHidden ? "unknown" : "visible";
  });
}
function normalizedDecimal(raw: string): string | null {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[Ee]([+-]?\d+))?$/.exec(raw);
  if (!m || !(m[2] || m[3])) throw new XlsxError("invalid");
  // A huge lexical exponent remains saved data, never unbounded BigInt work.
  if ((m[4]?.length ?? 0) > 64) return null;
  let digits = (m[2] + (m[3] ?? "")).replace(/^0+/, ""),
    exp = BigInt(m[4] ?? "0") - BigInt((m[3] ?? "").length);
  if (!digits) return "0";
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
  digits = digits.slice(0, digits.length - trailing);
  exp += BigInt(trailing);
  return (m[1] === "-" ? "-" : "") + digits + "e" + exp.toString();
}
export function inputCellDisplay(
  type: string,
  raw: string | null,
  text: string | null,
  style: XlsxStyle,
  date1904: boolean,
  missingCache = false,
): {
  display: string | null;
  known: boolean;
  visibility: "visible" | "hidden" | "unknown";
} {
  const format = style.numFmt;
  if (format === ";;;" && ["n", "s", "str", "inlineStr"].includes(type))
    return {
      display: missingCache ? null : "",
      known: !missingCache,
      visibility: "hidden",
    };
  if (format === ";;;" || format === ";;;;")
    return { display: null, known: false, visibility: "unknown" };
  // Visibility is still governed by the saved style when a formula result is
  // absent. No value may be invented to evaluate a value-dependent format.
  if (missingCache)
    return {
      display: null,
      known: false,
      visibility: format === "General" ? "visible" : "unknown",
    };
  if (raw === null && text === null)
    return { display: "", known: true, visibility: "visible" };
  if (["b", "e", "d"].includes(type))
    return format === "General"
      ? {
          display:
            type === "b"
              ? raw === "1" || raw === "true"
                ? "TRUE"
                : "FALSE"
              : raw,
          known: true,
          visibility: "visible",
        }
      : { display: null, known: false, visibility: "unknown" };
  const value = type === "n" ? Number(raw) : (text ?? "");
  if (type === "n") {
    const original = normalizedDecimal(raw ?? "");
    if (
      !Number.isFinite(value) ||
      original === null ||
      original !== normalizedDecimal(String(value))
    )
      return {
        display: null,
        known: false,
        visibility: format === "General" ? "visible" : "unknown",
      };
  }
  const rendered = formatXlsxValue(value, format, date1904);
  if (rendered.issue || rendered.display === null)
    return {
      display: null,
      known: false,
      visibility:
        rendered.issue === "unsupportedFormat" ? "unknown" : "visible",
    };
  return {
    display: rendered.display,
    known: true,
    visibility:
      rendered.display === "" && (type === "n" ? !!raw : !!text)
        ? "hidden"
        : "visible",
  };
}
