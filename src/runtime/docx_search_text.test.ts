import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { docxFixture, docxFixtureBytes, replaceDocxPart } from "./docx_fixture";
import { parseDocx } from "./docx_parse";
import { docxSearchText } from "./docx_search_text";
import { docxSearchLocationLabel } from "./attachment_search_strings";
import type { DocxDocument } from "./docx_types";
import author from "./fixtures/docx-search/author-oracle.json";
import supplement from "./fixtures/docx-search/supplement-oracle.json";
const input = (name: string) =>
  docxFixtureBytes(
    readFileSync(
      new URL(`./fixtures/docx-search/${name}.docx`, import.meta.url),
    ),
  );
const project = (name: string) => docxSearchText(parseDocx(input(name)));
const count = (texts: readonly { text: string }[], term: string) =>
  texts.reduce((n, s) => n + s.text.split(term).length - 1, 0);

describe("DOCX author text for explicit temporary search", () => {
  it("matches independently authored body, styled runs, nested table and four story regions", () => {
    const result = project("author");
    expect(count(result.segments, "needle")).toBe(author.authorNeedleCount);
    expect(result.bytes).toBe(
      result.segments.reduce((n, s) => n + Buffer.byteLength(s.text), 0),
    );
    const hits = result.segments.filter((s) => s.text.includes("needle"));
    expect(hits.map((s) => s.location.region)).toEqual([
      "body",
      "body",
      "body",
      "body",
      "footnote",
      "endnote",
      "header",
      "footer",
    ]);
    expect(hits[2].location.cells).toEqual([{ table: 1, row: 1, column: 1 }]);
    expect(hits[3].location.cells).toEqual([
      { table: 1, row: 1, column: 1 },
      { table: 1, row: 1, column: 1 },
    ]);
    expect(hits[4].location.noteId).toBeDefined();
    expect(hits[4].location.source.part).toBe("word/footnotes.xml");
    expect(docxSearchLocationLabel(hits[3].location)).toContain(
      "第 1 行、第 1 列",
    );
    expect(docxSearchLocationLabel(hits[4].location)).toContain("脚注");
  });
  it.each(author.negativeTerms)(
    "never searches generated or omitted term %s",
    (term) => {
      expect(count(project("author").segments, term)).toBe(0);
    },
  );
  it("keeps the independent second document counts distinct", () => {
    const result = project("second");
    expect(count(result.segments, "needle")).toBe(author.secondNeedleCount);
    expect(count(result.segments, "second")).toBe(author.secondTermCount);
  });
  it("preserves the independently specified image, omission, cell and whitespace barriers", () => {
    const result = project("image-and-cell-barriers");
    expect(result.segments.map((s) => s.text)).toEqual(
      supplement.expectedSegments,
    );
    expect(result.bytes).toBe(supplement.expectedSearchableUtf8Bytes);
    expect(result.document.partial).toBe(true);
    expect(result.document.imageReferences).toBe(1);
    for (const term of supplement.zeroCountTerms)
      expect(count(result.segments, term), term).toBe(0);
    for (const [term, expected] of Object.entries(supplement.positiveCounts))
      expect(count(result.segments, term), term).toBe(expected);
  });
  it("marks image-only omission partial even when the validated preview is otherwise complete", () => {
    const result = docxSearchText({
      blocks: [
        {
          kind: "paragraph",
          id: "p",
          source: { part: "word/document.xml", elementPath: [0, 0] },
          style: {},
          runs: [
            {
              kind: "image",
              imageId: "i",
              widthPt: 1,
              heightPt: 1,
              alt: "needle",
            },
          ],
        },
      ],
      stories: [],
      images: [],
      warnings: [],
      partial: false,
    } as DocxDocument);
    expect(result).toMatchObject({
      bytes: 0,
      segments: [],
      document: { partial: true, imageReferences: 1 },
    });
  });
  it("uses actual tab and break characters, not display placeholders or list labels", () => {
    const result = docxSearchText(parseDocx(docxFixture("03-list-restart")));
    expect(result.segments.some((s) => /^\d+\./.test(s.text))).toBe(false);
    expect(result.segments.some((s) => s.text.includes("【"))).toBe(false);
  });
  it("does not mutate the parser's saved structure or expose mutable location paths", () => {
    const doc = parseDocx(input("author"));
    const before = JSON.stringify(doc);
    const result = docxSearchText(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(
      Object.isFrozen(result.segments[0].location.source.elementPath),
    ).toBe(true);
    expect(Object.isFrozen(result.document.warnings)).toBe(true);
  });
  it("preserves existing rejection of tracked changes instead of searching deleted text", () => {
    expect(() =>
      docxSearchText(parseDocx(docxFixture("13-revisions"))),
    ).toThrow();
  });
  it("rejects invalid OOXML even when the selected filename says DOCX", () => {
    const broken = replaceDocxPart(
      input("author"),
      "[Content_Types].xml",
      () => "<not-a-docx/>",
    );
    expect(() => docxSearchText(parseDocx(broken))).toThrow();
  });
});
