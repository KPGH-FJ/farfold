import type { CSSProperties } from "react";
import type {
  DocxBlock,
  DocxCell,
  DocxParagraphStyle,
  DocxRun,
  DocxTable,
  DocxTextStyle,
} from "./docx_types";

export const DOCUMENT_WINDOW = {
  blocks: 20,
  rows: 20,
  columns: 12,
  runs: 1000,
  chars: 40_000,
} as const;
const bound = (value: number | undefined, min: number, max: number) =>
  value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.min(max, Math.max(min, value));
const color = (value: string | undefined) =>
  value && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;

export function documentTextStyle(style: DocxTextStyle): CSSProperties {
  const size = bound(style.fontSizePt, 1, 200);
  return {
    fontWeight: style.bold === undefined ? undefined : style.bold ? 700 : 400,
    fontStyle:
      style.italic === undefined
        ? undefined
        : style.italic
          ? "italic"
          : "normal",
    textDecorationLine:
      [
        style.underline && style.underline !== "none" ? "underline" : "",
        style.strike ? "line-through" : "",
      ]
        .filter(Boolean)
        .join(" ") || "none",
    textDecorationStyle: style.underline === "double" ? "double" : "solid",
    color: color(style.color),
    backgroundColor: color(style.background),
    fontSize: size === undefined ? undefined : `${size}pt`,
    verticalAlign:
      style.verticalAlign === "superscript"
        ? "super"
        : style.verticalAlign === "subscript"
          ? "sub"
          : "baseline",
  };
}

export function documentParagraphStyle(
  style: DocxParagraphStyle,
): CSSProperties {
  // Negative overflow at a scroll container's start is unreachable. Preserve
  // ordinary hanging indents, but adapt outdents beyond the preview boundary.
  const left = bound(style.leftPt, 0, 600) ?? 0;
  const firstLine = Math.max(-left, bound(style.firstLinePt, -200, 600) ?? 0);
  return {
    textAlign: style.alignment,
    marginLeft: `${left}pt`,
    marginRight: `${bound(style.rightPt, 0, 600) ?? 0}pt`,
    textIndent: `${firstLine}pt`,
    marginTop: `${bound(style.spaceBeforePt, 0, 600) ?? 0}pt`,
    marginBottom: `${bound(style.spaceAfterPt, 0, 600) ?? 0}pt`,
    lineHeight: bound(style.lineHeight, 0.5, 10),
  };
}

/** Split presentation only; retain every character and style without splitting surrogate pairs. */
export function paragraphParts(
  runs: DocxRun[],
  maxRuns: number = DOCUMENT_WINDOW.runs,
  maxChars: number = DOCUMENT_WINDOW.chars,
): DocxRun[][] {
  if (
    !Number.isInteger(maxRuns) ||
    maxRuns < 1 ||
    !Number.isInteger(maxChars) ||
    maxChars < 2
  )
    throw new RangeError("Invalid document presentation limits");
  const result: DocxRun[][] = [[]];
  let chars = 0;
  const next = () => {
    result.push([]);
    chars = 0;
  };
  for (const run of runs) {
    if (run.kind !== "text" || !run.text.length) {
      if (result[result.length - 1].length >= maxRuns) next();
      result[result.length - 1].push(run);
      continue;
    }
    let from = 0;
    while (from < run.text.length) {
      if (result[result.length - 1].length >= maxRuns || chars >= maxChars)
        next();
      let end = Math.min(run.text.length, from + maxChars - chars);
      if (end < run.text.length && /[\uD800-\uDBFF]/.test(run.text[end - 1]))
        end -= 1;
      if (end === from) {
        next();
        continue;
      }
      const text = run.text.slice(from, end);
      result[result.length - 1].push({ ...run, text });
      chars += text.length;
      from = end;
    }
  }
  return result;
}

export interface DocumentCellPosition {
  cell: DocxCell | null;
  row: number;
  column: number;
  sourceRow: number;
  sourceColumn: number;
  rowSpan: number;
  columnSpan: number;
  clipped: boolean;
}
export function documentTableWindow(
  table: DocxTable,
  rowStart: number,
  columnStart: number,
) {
  const columns = table.rows.reduce(
    (max, row) =>
      row.cells.reduce((n, c) => Math.max(n, c.column + c.columnSpan), max),
    table.columnsPt.length,
  );
  const endRow = Math.min(table.rows.length, rowStart + DOCUMENT_WINDOW.rows);
  const endColumn = Math.min(columns, columnStart + DOCUMENT_WINDOW.columns);
  const entries = new Map<string, DocumentCellPosition>();
  const covered = new Set<string>();
  table.rows.slice(0, endRow).forEach((row, sourceRow) =>
    row.cells.forEach((cell) => {
      const r = Math.max(rowStart, sourceRow),
        c = Math.max(columnStart, cell.column);
      const bottom = Math.min(endRow, sourceRow + cell.rowSpan),
        right = Math.min(endColumn, cell.column + cell.columnSpan);
      if (r >= bottom || c >= right) return;
      entries.set(`${r}:${c}`, {
        cell,
        row: r,
        column: c,
        sourceRow,
        sourceColumn: cell.column,
        rowSpan: bottom - r,
        columnSpan: right - c,
        clipped:
          r !== sourceRow ||
          c !== cell.column ||
          bottom !== sourceRow + cell.rowSpan ||
          right !== cell.column + cell.columnSpan,
      });
      for (let y = r; y < bottom; y++)
        for (let x = c; x < right; x++)
          if (y !== r || x !== c) covered.add(`${y}:${x}`);
    }),
  );
  const rows: DocumentCellPosition[][] = [];
  for (let r = rowStart; r < endRow; r++) {
    const cells = [];
    for (let c = columnStart; c < endColumn; c++) {
      if (covered.has(`${r}:${c}`)) continue;
      cells.push(
        entries.get(`${r}:${c}`) ?? {
          cell: null,
          row: r,
          column: c,
          sourceRow: r,
          sourceColumn: c,
          rowSpan: 1,
          columnSpan: 1,
          clipped: false,
        },
      );
    }
    rows.push(cells);
  }
  return { rows, columns, endRow, endColumn };
}

export function documentCellStyle(cell: DocxCell): CSSProperties {
  const result: CSSProperties = {
    backgroundColor: color(cell.background),
    verticalAlign:
      cell.verticalAlign === "center" ? "middle" : cell.verticalAlign,
  };
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const border = cell.borders?.[side];
    if (border) {
      const key =
        `border${side[0].toUpperCase()}${side.slice(1)}` as "borderTop";
      result[key] =
        `${bound(border.widthPt, 0, 12) ?? 0}pt ${border.style} ${color(border.color) ?? "#000000"}`;
    }
  }
  return result;
}

/** Keep an explicit bounded excerpt in table cells; the complete cell remains available separately. */
export function cellExcerpt(blocks: DocxBlock[]): {
  runs: DocxRun[];
  complete: boolean;
} {
  if (blocks.length !== 1 || blocks[0].kind !== "paragraph")
    return { runs: [], complete: false };
  const parts = paragraphParts(blocks[0].runs, 24, 600);
  return { runs: parts[0], complete: parts.length === 1 };
}
