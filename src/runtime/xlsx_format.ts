import * as SSF from "ssf";
import { XLSX_LIMITS } from "./xlsx_types";

const COLORS: Record<string, string> = {
  black: "#000000",
  blue: "#0000FF",
  cyan: "#00FFFF",
  green: "#00FF00",
  magenta: "#FF00FF",
  red: "#FF0000",
  white: "#FFFFFF",
  yellow: "#FFFF00",
};
function sections(code: string): string[] {
  const result = [""];
  let quote = false;
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    if (char === "\\") {
      result[result.length - 1] += char + (code[++i] ?? "");
      continue;
    }
    if (char === '"') quote = !quote;
    if (char === ";" && !quote) result.push("");
    else result[result.length - 1] += char;
  }
  if (quote || result.length > 4) throw new Error();
  return result;
}
function chosenSection(
  parts: string[],
  value: number | string | boolean,
): string {
  if (typeof value === "string") return parts[3] ?? "";
  if (typeof value !== "number") return "";
  const test = (operator: string, target: number) =>
    ({
      "<": value < target,
      "<=": value <= target,
      ">": value > target,
      ">=": value >= target,
      "=": value === target,
      "<>": value !== target,
    })[operator];
  if (parts.some((s) => /\[(?:[<>]=?|=|<>)-?\d/.test(s))) {
    for (const part of parts.slice(0, 3)) {
      const condition = part.match(
        /\[(<=|>=|<>|<|>|=)(-?(?:\d+(?:\.\d*)?|\.\d+))\]/,
      );
      if (!condition || test(condition[1], Number(condition[2]))) return part;
    }
    return "";
  }
  return parts[
    value < 0 && parts.length > 1 ? 1 : value === 0 && parts.length > 2 ? 2 : 0
  ];
}
/** Formats the original typed cache, never a Date or a truthiness fallback. */
export function formatXlsxValue(
  value: number | string | boolean,
  code: string,
  date1904: boolean,
): { display: string | null; issue?: string; color?: string } {
  const unsupported = { display: null, issue: "unsupportedFormat" };
  if (
    code.length > XLSX_LIMITS.format ||
    (typeof value === "number" && !Number.isFinite(value))
  )
    return unsupported;
  try {
    const parts = sections(code);
    // Brackets inside quoted/escaped literals do not carry format directives.
    const syntax = code.replace(/"[^"]*"|\\./g, "");
    for (const match of syntax.matchAll(/\[([^\]]*)\]/g)) {
      if (
        !/^(?:h{1,2}|m{1,2}|s{1,2}|black|blue|cyan|green|magenta|red|white|yellow|(?:<=|>=|<>|<|>|=)-?(?:\d+(?:\.\d*)?|\.\d+))$/i.test(
          match[1],
        )
      )
        return unsupported;
    }
    if (
      typeof value === "number" &&
      SSF.is_date(code) &&
      !SSF.parse_date_code(value, { date1904 })
    )
      return { display: null, issue: "dateRange" };
    const display = SSF.format(code, value, { date1904 });
    const selected = chosenSection(parts, value).replace(/"[^"]*"|\\./g, "");
    const colorName = selected
      .match(/\[(black|blue|cyan|green|magenta|red|white|yellow)\]/i)?.[1]
      .toLowerCase();
    const color = colorName ? COLORS[colorName] : undefined;
    return {
      display,
      ...(color ? { color } : {}),
      ...(/[_*]/.test(syntax) ? { issue: "widthDependentFormat" } : {}),
    };
  } catch {
    return unsupported;
  }
}
