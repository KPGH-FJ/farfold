import { describe, expect, it } from "vitest";
import {
  cellExcerpt,
  documentParagraphStyle,
  documentTableWindow,
  documentTextStyle,
  paragraphParts,
} from "./document_view";
import type { DocxCell, DocxRun, DocxTable } from "./docx_types";
import { documentFailure } from "./document_strings";
import { DocxError } from "./docx_types";

const text = (value: string): DocxRun => ({
  kind: "text",
  text: value,
  style: { bold: true },
});
describe("DOCX bounded presentation", () => {
  it("keeps outdented text reachable while preserving ordinary hanging indents", () => {
    expect(
      documentParagraphStyle({
        leftPt: -120,
        rightPt: -120,
        firstLinePt: -120,
      }),
    ).toMatchObject({
      marginLeft: "0pt",
      marginRight: "0pt",
      textIndent: "0pt",
    });
    expect(
      documentParagraphStyle({ leftPt: 36, firstLinePt: -18 }),
    ).toMatchObject({
      marginLeft: "36pt",
      textIndent: "-18pt",
    });
    expect(
      documentParagraphStyle({ leftPt: 18, firstLinePt: -200 }).textIndent,
    ).toBe("-18pt");
  });
  it("keeps every UTF-16 pair and character over fragment boundaries", () => {
    const value = "中文😀🧪结尾";
    const parts = paragraphParts([text(value)], 10, 3);
    expect(
      parts
        .flat()
        .map((r) => (r.kind === "text" ? r.text : ""))
        .join(""),
    ).toBe(value);
    for (const runs of parts)
      for (const run of runs) {
        if (run.kind !== "text") throw new Error("Unexpected kind");
        expect(run.text.length).toBeLessThanOrEqual(3);
        expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(run.text)).toBe(false);
        expect(run.style.bold).toBe(true);
      }
  });
  it("bounds run-heavy paragraphs including empty text and non-text runs", () => {
    const runs: DocxRun[] = [
      text(""),
      { kind: "tab" },
      text("A"),
      { kind: "break" },
      text("B"),
    ];
    const parts = paragraphParts(runs, 2, 20);
    expect(parts.every((p) => p.length <= 2)).toBe(true);
    expect(parts.flat()).toEqual(runs);
    expect(paragraphParts([])).toEqual([[]]);
  });
  it("does not enter an infinite loop on an invalid surrogate budget", () => {
    expect(() => paragraphParts([text("😀")], 1, 1)).toThrow(RangeError);
    expect(() => paragraphParts([text("a")], 0, 5)).toThrow(RangeError);
  });
  it("does not expose raw CSS colors or non-finite font values", () => {
    expect(
      documentTextStyle({
        color: "url(https://example.test/private)",
        background: "red;position:fixed",
        fontSizePt: NaN,
      }),
    ).toMatchObject({
      color: undefined,
      backgroundColor: undefined,
      fontSize: undefined,
    });
    expect(
      documentTextStyle({
        bold: false,
        italic: false,
        underline: "none",
        strike: false,
      }),
    ).toMatchObject({
      fontWeight: 400,
      fontStyle: "normal",
      textDecorationLine: "none",
    });
  });
  it("clips merged cells but preserves the original cell owner and full content", () => {
    const cell: DocxCell = {
      column: 10,
      columnSpan: 5,
      rowSpan: 25,
      blocks: [
        {
          kind: "paragraph",
          id: "p",
          source: { part: "word/document.xml", elementPath: [0, 0, 1, 0, 0] },
          runs: [text("original merge")],
          style: {},
        },
      ],
    };
    const table: DocxTable = {
      kind: "table",
      id: "t",
      source: { part: "word/document.xml", elementPath: [0, 0] },
      columnsPt: Array(18).fill(50),
      rows: Array.from({ length: 30 }, (_, i) => ({
        cells: i === 0 ? [cell] : [],
      })),
    };
    const view = documentTableWindow(table, 20, 12);
    const position = view.rows[0][0];
    expect(position).toMatchObject({
      row: 20,
      column: 12,
      sourceRow: 0,
      sourceColumn: 10,
      rowSpan: 5,
      columnSpan: 3,
      clipped: true,
    });
    expect(position.cell).toBe(cell);
    expect(view.rows[1].some((c) => c.column === 12)).toBe(false);
    expect(view.rows[5][0].cell).toBeNull();
  });
  it("includes columns present in cells even when no explicit grid width was saved", () => {
    const table: DocxTable = {
      kind: "table",
      id: "t",
      source: { part: "word/document.xml", elementPath: [0, 0] },
      columnsPt: [],
      rows: [
        { cells: [{ blocks: [], column: 14, columnSpan: 1, rowSpan: 1 }] },
      ],
    };
    expect(documentTableWindow(table, 0, 12)).toMatchObject({
      columns: 15,
      endColumn: 15,
    });
  });
  it("does not call a table-cell excerpt complete when blocks were omitted", () => {
    const paragraph = {
      kind: "paragraph" as const,
      id: "p",
      source: { part: "word/document.xml", elementPath: [0, 0] },
      runs: [text("a".repeat(601))],
      style: {},
    };
    expect(cellExcerpt([paragraph]).complete).toBe(false);
    expect(cellExcerpt([paragraph]).runs[0]).toMatchObject({
      text: "a".repeat(600),
    });
    expect(
      cellExcerpt([{ ...paragraph, runs: [text("short")] }]).complete,
    ).toBe(true);
    expect(cellExcerpt([paragraph, { ...paragraph, id: "other" }])).toEqual({
      runs: [],
      complete: false,
    });
  });
  it("does not surface arbitrary parser/backend error text", () => {
    expect(documentFailure(new Error("secret /private/path"))).not.toContain(
      "secret",
    );
    expect(documentFailure(new DocxError("changed"))).toContain("文件已变化");
  });
});
