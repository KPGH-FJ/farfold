import {
  DOCX_LIMITS,
  DocxError,
  type DocxBlock,
  type DocxBorder,
  type DocxCell,
  type DocxTable,
  type DocxSourcePosition,
} from "./docx_types";
import {
  W,
  attr,
  child,
  children,
  number,
  val,
  type DocxXml,
} from "./docx_xml";
import type { DocxStyles, Warn } from "./docx_styles";

export function parseDocxTable(
  node: DocxXml,
  id: string,
  source: DocxSourcePosition,
  styles: DocxStyles,
  warn: Warn,
  blocks: (nodes: DocxXml[]) => DocxBlock[],
  countCell: () => void,
): DocxTable {
  if (
    node.text.trim() ||
    node.children.some(
      (n) => n.uri !== W || !["tblPr", "tblGrid", "tr"].includes(n.name),
    )
  )
    throw new DocxError("unsupported");
  const properties = child(node, "tblPr");
  const columnsPt = children(
    child(node, "tblGrid") ?? ({ children: [] } as unknown as DocxXml),
    "gridCol",
  ).map((n) => number(attr(n, "w"), 0, 31680) / 20);
  if (columnsPt.length > DOCX_LIMITS.tableColumns) throw new DocxError("limit");
  if (child(properties, "tblStyle")) warn("unsupportedFormatting");
  const edges = (
    parent: DocxXml | undefined,
  ): Partial<
    Record<
      "top" | "right" | "bottom" | "left" | "insideH" | "insideV",
      DocxBorder
    >
  > => {
    const result: Partial<
      Record<
        "top" | "right" | "bottom" | "left" | "insideH" | "insideV",
        DocxBorder
      >
    > = {};
    for (const n of parent?.children ?? []) {
      const aliases: Record<
        string,
        "top" | "right" | "bottom" | "left" | "insideH" | "insideV"
      > = {
        top: "top",
        right: "right",
        bottom: "bottom",
        left: "left",
        start: "left",
        end: "right",
        insideH: "insideH",
        insideV: "insideV",
      };
      const edge = aliases[n.name];
      if (n.uri !== W || !edge) {
        warn("unsupportedFormatting");
        continue;
      }
      const value = val(n);
      if (value === "nil" || value === "none") {
        result[edge] = { color: "#000000", widthPt: 0, style: "solid" };
        continue;
      }
      const kind: Record<string, DocxBorder["style"]> = {
        single: "solid",
        double: "double",
        dashed: "dashed",
        dotted: "dotted",
      };
      if (!value || !kind[value]) {
        warn("unsupportedFormatting");
        continue;
      }
      result[edge] = {
        color: styles.color(n, "color") ?? "#000000",
        widthPt: number(attr(n, "sz") ?? "4", 0, 96) / 8,
        style: kind[value],
      };
    }
    return result;
  };
  const tableEdges = edges(child(properties, "tblBorders"));
  for (const n of properties?.children ?? [])
    if (
      n.uri !== W ||
      ![
        "tblBorders",
        "tblStyle",
        "tblW",
        "tblLayout",
        "tblLook",
        "tblCellMar",
        "jc",
        "tblInd",
      ].includes(n.name)
    )
      warn("unsupportedFormatting");
  const sourceRows = children(node, "tr");
  if (!sourceRows.length) throw new DocxError("invalid");
  const result: DocxTable = { kind: "table", id, source, columnsPt, rows: [] };
  let active = new Map<number, { cell: DocxCell; end: number }>();
  let widest = columnsPt.length;
  for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex++) {
    const source = sourceRows[rowIndex],
      row = { cells: [] as DocxCell[] },
      next = new Map<number, { cell: DocxCell; end: number }>();
    if (
      source.children.some(
        (n) => n.uri !== W || !["tc", "trPr", "tblPrEx"].includes(n.name),
      )
    )
      throw new DocxError("unsupported");
    if (source.text.trim()) throw new DocxError("invalid");
    const trPr = child(source, "trPr");
    if (child(trPr, "gridBefore") || child(trPr, "gridAfter"))
      throw new DocxError("unsupported");
    if (
      trPr?.children.some((n) => !["tblHeader", "cantSplit"].includes(n.name))
    )
      warn("unsupportedFormatting");
    let column = 0;
    for (const sourceCell of children(source, "tc")) {
      if (sourceCell.text.trim()) throw new DocxError("invalid");
      countCell();
      const properties = child(sourceCell, "tcPr");
      const span = number(
        val(child(properties, "gridSpan")) ?? "1",
        1,
        DOCX_LIMITS.tableColumns,
      );
      if (!Number.isInteger(span) || column + span > DOCX_LIMITS.tableColumns)
        throw new DocxError("limit");
      if (columnsPt.length && column + span > columnsPt.length)
        throw new DocxError("invalid");
      const content = blocks(
        sourceCell.children.filter((n) => !(n.uri === W && n.name === "tcPr")),
      );
      const merge = child(properties, "vMerge"),
        mergeKind = merge && (val(merge) ?? "continue");
      if (mergeKind && !["restart", "continue"].includes(mergeKind))
        throw new DocxError("invalid");
      if (mergeKind === "continue") {
        const anchor = active.get(column);
        if (
          !anchor ||
          anchor.end !== column + span ||
          content.some(
            (b) =>
              b.kind !== "paragraph" ||
              b.runs.some((r) => r.kind !== "text" || r.text !== ""),
          )
        )
          throw new DocxError("invalid");
        anchor.cell.rowSpan++;
        next.set(column, anchor);
      } else {
        const own = edges(child(properties, "tcBorders"));
        const cell: DocxCell = {
          blocks: content,
          column,
          columnSpan: span,
          rowSpan: 1,
          borders: {
            top: own.top ?? (rowIndex ? tableEdges.insideH : tableEdges.top),
            bottom:
              own.bottom ??
              (rowIndex + 1 < sourceRows.length
                ? tableEdges.insideH
                : tableEdges.bottom),
            left: own.left ?? (column ? tableEdges.insideV : tableEdges.left),
            right:
              own.right ??
              (columnsPt.length && column + span === columnsPt.length
                ? tableEdges.right
                : tableEdges.insideV),
          },
        };
        const width = child(properties, "tcW");
        if (width && attr(width, "type") === "dxa")
          cell.widthPt = number(attr(width, "w"), 0, 31680) / 20;
        else if (width && !["auto", "nil"].includes(attr(width, "type") ?? ""))
          warn("unsupportedFormatting");
        const shading = child(properties, "shd");
        if (shading) cell.background = styles.color(shading, "fill");
        const vertical = val(child(properties, "vAlign"));
        if (vertical && ["top", "center", "bottom"].includes(vertical))
          cell.verticalAlign = vertical as DocxCell["verticalAlign"];
        else if (vertical) warn("unsupportedFormatting");
        for (const n of properties?.children ?? [])
          if (
            n.uri !== W ||
            ![
              "tcW",
              "gridSpan",
              "vMerge",
              "shd",
              "vAlign",
              "tcBorders",
              "tcMar",
            ].includes(n.name)
          )
            warn("unsupportedFormatting");
        row.cells.push(cell);
        if (mergeKind === "restart")
          next.set(column, { cell, end: column + span });
      }
      column += span;
    }
    if (!column || (columnsPt.length && column !== columnsPt.length))
      throw new DocxError("invalid");
    widest = Math.max(widest, column);
    active = next;
    result.rows.push(row);
  }
  if (!columnsPt.length) {
    warn("unsupportedFormatting");
    result.columnsPt = Array.from({ length: widest }, () => 80);
  }
  return result;
}
