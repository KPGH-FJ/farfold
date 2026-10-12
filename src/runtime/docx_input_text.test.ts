import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { docxFixtureBytes, replaceDocxPart } from "./docx_fixture";
import { parseDocx } from "./docx_parse";
import { checkedDocxDocument } from "./docx_validation";
import { docxInputText } from "./docx_input_text";
import type { DocxParagraph } from "./docx_types";
import { DOCUMENT_INPUT_MAX_BYTES } from "./document_input_types";

const root = new URL(
  "../../docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/",
  import.meta.url,
);
const oracle = JSON.parse(
  readFileSync(new URL("oracle.json", root), "utf8"),
) as {
  files: {
    name: string;
    sha256: string;
    markers?: string[];
    longParagraph?: string;
    cellValues?: string[];
    nested?: string;
    rows?: number;
    columns?: number;
    merges?: number[][];
    storyText?: string[];
    savedField?: string;
  }[];
};
function fixture(name: string) {
  const bytes = readFileSync(new URL(`${name}.docx`, root));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    oracle.files.find((file) => file.name === name)?.sha256,
  );
  return docxFixtureBytes(bytes);
}
function document(name: string) {
  const input = fixture(name);
  return checkedDocxDocument(
    parseDocx(input),
    new Set(input.parts.map((part) => part.name)),
  );
}

describe("DOCX full chosen text from independently written OOXML ZIP", () => {
  it("keeps long paragraph tail, all 70 rows, merged anchors, nested cell text and saved fields", () => {
    const expected = oracle.files.find((file) => file.name === "complete")!;
    const converted = docxInputText(document("complete"));
    expect(converted.actualTextChars).toBeGreaterThan(10000);
    for (const marker of expected.markers!)
      expect(converted.text).toContain(marker);
    expect(converted.text).toContain(expected.longParagraph);
    expect(converted.text).toContain(expected.savedField);
    for (const text of expected.storyText!)
      expect(converted.text).toContain(text);
    expect(converted.text).toContain("[1] 是作者原样文字；0 false 😀");
    const table = JSON.parse(
      converted.text
        .split("\n")
        .find((line) => line.startsWith('{"kind":"table"'))!,
    );
    expect(table.columns).toBe(expected.columns);
    expect(table.rows).toHaveLength(expected.rows!);
    const cellValues: string[] = [];
    const merges: number[][] = [];
    table.rows.forEach(
      (
        row: {
          cells: {
            column: number;
            rowSpan: number;
            columnSpan: number;
            blocks: { kind: string; text?: string; rows?: unknown[] }[];
          }[];
        },
        index: number,
      ) =>
        row.cells.forEach((cell) => {
          if (cell.rowSpan > 1 || cell.columnSpan > 1)
            merges.push([
              index + 1,
              cell.column,
              cell.rowSpan,
              cell.columnSpan,
            ]);
          for (const block of cell.blocks)
            if (block.kind === "paragraph") cellValues.push(block.text!);
        }),
    );
    expect(cellValues).toEqual(expected.cellValues);
    expect(merges).toEqual(expected.merges);
    const nested = table.rows[42].cells[2].blocks[1];
    expect(nested.kind).toBe("table");
    expect(nested.rows[0].cells[0].blocks[0].text).toBe(expected.nested);
    expect(converted.text).toContain("字段仅显示保存的结果");
    expect(converted.text).not.toContain("引用");
    expect(converted.imageReferences).toBe(0);
  });
  it("separates a real footnote position from literal [1], and markers cannot qualify as author text", () => {
    const empty = document("image-empty-note"),
      literal = document("literal-marker");
    const footnote = (empty.blocks[1] as DocxParagraph).runs[0];
    expect(footnote).toMatchObject({
      kind: "noteReference",
      noteKind: "footnote",
      noteId: "1",
    });
    expect(docxInputText(empty)).toMatchObject({
      actualTextChars: 0,
      imageReferences: 1,
    });
    const converted = docxInputText(literal);
    expect(converted.actualTextChars).toBe(3);
    expect(converted.text).toContain("[1]");
    expect(converted.text).toContain("作者替代文字");
    expect(converted.text).toContain("[脚注位置 1]");
  });
  it("does not invent an existing story for forged or missing note positions", () => {
    const input = fixture("literal-marker"),
      parsed = parseDocx(input);
    const parts = new Set(input.parts.map((part) => part.name));
    const missing = structuredClone(parsed);
    missing.stories = [];
    expect(() => checkedDocxDocument(missing, parts)).toThrow();
    const wrong = structuredClone(parsed);
    (wrong.blocks[1] as DocxParagraph).runs[0] = {
      kind: "noteReference",
      noteKind: "endnote",
      noteId: "1",
      style: {},
    };
    expect(() => checkedDocxDocument(wrong, parts)).toThrow();
    const injected = structuredClone(parsed);
    Object.assign((injected.blocks[1] as DocxParagraph).runs[0], {
      text: "pretend author",
    });
    expect(() => checkedDocxDocument(injected, parts)).toThrow();
  });
  it("keeps reported partial scope while excluding hidden text", () => {
    const parsed = document("partial-hidden"),
      converted = docxInputText(parsed);
    expect(parsed.partial).toBe(true);
    expect(converted.text).toContain("VISIBLE_428a");
    expect(converted.text).not.toContain("HIDDEN_d4a5_MUST_NOT_APPEAR");
    expect(converted.text).toContain("部分内容未读取");
    expect(converted.text).toContain("隐藏文字未显示");
  });
  it("rejects an active object in actual ZIP content instead of producing a text attachment", () => {
    expect(() => parseDocx(fixture("active-object"))).toThrowError(
      expect.objectContaining({ code: "unsupported" }),
    );
  });
  it("rejects an over-budget Unicode result as a whole, with no prefix returned", () => {
    const input = replaceDocxPart(
      fixture("partial-hidden"),
      "word/document.xml",
      () =>
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${"界".repeat(DOCUMENT_INPUT_MAX_BYTES / 2)}</w:t></w:r></w:p></w:body></w:document>`,
    );
    const parsed = checkedDocxDocument(
      parseDocx(input),
      new Set(input.parts.map((part) => part.name)),
    );
    expect(() => docxInputText(parsed)).toThrowError(
      expect.objectContaining({ code: "textLimit" }),
    );
  });
});
