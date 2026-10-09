import { describe, expect, it } from "vitest";
import { parseDocx } from "./docx_parse";
import { docxFixture, replaceDocxPart } from "./docx_fixture";
import { DocxError, type DocxParagraph } from "./docx_types";

const paragraphs = (id: string) =>
  parseDocx(docxFixture(id)).blocks as DocxParagraph[];
const texts = (id: string) =>
  paragraphs(id).map((p) =>
    p.runs
      .filter((r) => r.kind === "text")
      .map((r) => r.text)
      .join(""),
  );

describe("DOCX bounded readable content", () => {
  it("preserves literal zero, false, empty and source spaces", () => {
    expect(texts("01-text-values")).toEqual([
      "0",
      "false",
      "",
      "  kept  spaces  ",
      "中文 A & B < C",
      "after empty",
    ]);
  });
  it("applies inherited paragraph styles and direct false without dropping text", () => {
    const [p] = paragraphs("02-style-inheritance");
    expect(p.style.alignment).toBe("center");
    expect(p.runs).toMatchObject([
      {
        kind: "text",
        style: { bold: true, italic: true, color: "#123456", fontSizePt: 11 },
      },
      {
        kind: "text",
        style: { bold: false, italic: true, color: "#123456", fontSizePt: 11 },
      },
    ]);
  });
  it("honors restart per numbering instance", () => {
    expect(paragraphs("03-list-restart").map((p) => p.list?.label)).toEqual([
      "1.",
      "2.",
      "1.",
      "2.",
    ]);
  });
  it("retains a table's cells and horizontal/vertical merge anchors", () => {
    const table = parseDocx(docxFixture("04-table-merges")).blocks[0];
    expect(table.kind).toBe("table");
    if (table.kind !== "table") throw new Error("table missing");
    expect(table.columnsPt).toEqual([100, 100, 100]);
    expect(
      table.rows.map((r) =>
        r.cells.map((c) => [c.column, c.rowSpan, c.columnSpan]),
      ),
    ).toEqual([
      [
        [0, 1, 2],
        [2, 1, 1],
      ],
      [
        [0, 2, 1],
        [1, 1, 1],
        [2, 1, 1],
      ],
      [
        [1, 1, 1],
        [2, 1, 1],
      ],
    ]);
  });
  it("keeps internal PNG/JPEG as inert bounded resources", () => {
    const result = parseDocx(docxFixture("05-inline-png-jpeg"));
    expect(result.images.map((i) => [i.mimeType, i.width, i.height])).toEqual([
      ["image/png", 8, 8],
      ["image/jpeg", 8, 8],
    ]);
    expect(
      result.blocks
        .filter((b) => b.kind === "paragraph")
        .flatMap((p) => p.runs)
        .filter((r) => r.kind === "image"),
    ).toHaveLength(2);
  });
  it("retains referenced header/footer/footnote stories without inventing pages", () => {
    const result = parseDocx(docxFixture("07-header-footer-footnote"));
    expect(result.stories.map((s) => s.kind).sort()).toEqual([
      "footer",
      "footnote",
      "header",
    ]);
    expect(result.stories.find((s) => s.kind === "footnote")?.noteId).toBe("1");
    expect(result.warnings).toContainEqual({
      code: "continuousLayout",
      count: 1,
    });
  });
  it("distinguishes empty cached fields from missing results without executing instructions", () => {
    const result = parseDocx(docxFixture("08-field-caches"));
    expect(
      (result.blocks as DocxParagraph[]).slice(0, 3).map((p) =>
        p.runs
          .filter((r) => r.kind === "text")
          .map((r) => r.text)
          .join(""),
      ),
    ).toEqual(["0", "false", ""]);
    expect(
      result.warnings.find((w) => w.code === "missingFieldResult")?.count,
    ).toBe(1);
    expect(JSON.stringify(result)).not.toContain("INCLUDETEXT");
  });
  it("preserves external hyperlink labels but never returns active URLs", () => {
    const result = parseDocx(docxFixture("09-external-relationships"));
    expect(result.partial).toBe(true);
    expect(JSON.stringify(result)).toContain("public link label");
    expect(JSON.stringify(result)).not.toContain("docx-fixture.invalid");
    expect(JSON.stringify(result)).not.toContain("javascript:");
    expect(result.images).toEqual([]);
  });
  it("keeps hidden text out of default output and acknowledges it", () => {
    const result = parseDocx(docxFixture("14-hidden-run"));
    expect(JSON.stringify(result)).not.toContain("HIDDEN public marker");
    expect(result.warnings.some((w) => w.code === "hiddenContent")).toBe(true);
  });
  it("selects one supported compatibility branch", () => {
    expect(texts("16-alternate-content")).toEqual(["SUPPORTED FALLBACK"]);
  });
  it("makes a missing image explicit instead of a complete empty preview", () => {
    const result = parseDocx(docxFixture("19-missing-image-part"));
    expect(result.partial).toBe(true);
    expect(result.warnings.some((w) => w.code === "missingImage")).toBe(true);
  });
  it.each([
    "10-altchunk-html",
    "11-macro-content-type",
    "12-vba-marker-entry",
    "13-revisions",
    "15-unknown-body-element",
    "17-doctype",
    "18-style-cycle",
  ])("rejects %s with no silent content loss", (name) => {
    expect(() => parseDocx(docxFixture(name))).toThrow(DocxError);
  });
  it("rejects malformed and escaped internal part relationships", () => {
    const input = replaceDocxPart(
      docxFixture("01-text-values"),
      "_rels/.rels",
      (s) => s.replace("word/document.xml", "../outside.xml"),
    );
    expect(() => parseDocx(input)).toThrow(DocxError);
  });
});
