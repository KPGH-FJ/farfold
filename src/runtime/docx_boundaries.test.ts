import { describe, expect, it } from "vitest";
import { parseDocx } from "./docx_parse";
import { docxFixture, replaceDocxPart } from "./docx_fixture";
import { DOCX_LIMITS, DocxError } from "./docx_types";
const body = (xml: string) =>
  replaceDocxPart(docxFixture("01-text-values"), "word/document.xml", (s) =>
    s.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${xml}</w:body>`),
  );
const paragraph = "<w:p><w:r><w:t>retained</w:t></w:r></w:p>";
const table = (content: string) =>
  `<w:tbl><w:tblGrid><w:gridCol w:w="100"/></w:tblGrid><w:tr><w:tc>${content}</w:tc></w:tr></w:tbl>`;
describe("DOCX completeness and allocation boundaries", () => {
  it("keeps webHidden and vanish independent of XML property order", () => {
    for (const properties of [
      '<w:webHidden/><w:vanish w:val="false"/>',
      '<w:vanish w:val="false"/><w:webHidden/>',
    ]) {
      const result = parseDocx(
        body(
          `<w:p><w:r><w:rPr>${properties}</w:rPr><w:t>HIDDEN-COMBINATION</w:t></w:r></w:p>`,
        ),
      );
      expect(JSON.stringify(result)).not.toContain("HIDDEN-COMBINATION");
    }
  });
  it("allows direct webHidden=false to override inherited webHidden=true", () => {
    let input = replaceDocxPart(
      docxFixture("02-style-inheritance"),
      "word/styles.xml",
      (s) => s.replace("<w:b/>", "<w:webHidden/>"),
    );
    input = replaceDocxPart(input, "word/document.xml", (s) =>
      s.replace('<w:b w:val="false"/>', '<w:webHidden w:val="false"/>'),
    );
    const result = parseDocx(input);
    expect(JSON.stringify(result.blocks)).toContain(" direct bold off");
  });
  it("rejects specVanish on the paragraph mark instead of silently changing the break", () => {
    expect(() =>
      parseDocx(
        body(
          "<w:p><w:pPr><w:rPr><w:specVanish/></w:rPr></w:pPr><w:r><w:t>retained</w:t></w:r></w:p>",
        ),
      ),
    ).toThrow(DocxError);
  });
  it("does not mistake paragraph-mark specVanish for hidden body text", () => {
    expect(() =>
      parseDocx(
        body(
          "<w:p><w:r><w:rPr><w:specVanish/></w:rPr><w:t>VISIBLE</w:t></w:r></w:p>",
        ),
      ),
    ).toThrow(DocxError);
  });

  it("refuses unsupported children between table rows instead of dropping their content", () => {
    expect(() =>
      parseDocx(
        body(
          table(paragraph).replace(
            "</w:tbl>",
            "<w:customXml><w:p><w:r><w:t>LOST</w:t></w:r></w:p></w:customXml></w:tbl>",
          ),
        ),
      ),
    ).toThrow(DocxError);
  });
  it("refuses unexpected text in body and run containers", () => {
    expect(() => parseDocx(body("LOST" + paragraph))).toThrow(DocxError);
    expect(() =>
      parseDocx(body("<w:p><w:r>LOST<w:t>retained</w:t></w:r></w:p>")),
    ).toThrow(DocxError);
  });
  it("enforces a logical 512-column profile before creating UI grid coordinates", () => {
    expect(() =>
      parseDocx(
        body(
          `<w:tbl><w:tblGrid>${'<w:gridCol w:w="1"/>'.repeat(513)}</w:tblGrid><w:tr><w:tc><w:tcPr><w:gridSpan w:val="513"/></w:tcPr>${paragraph}</w:tc></w:tr></w:tbl>`,
        ),
      ),
    ).toThrow(DocxError);
  });
  it("enforces eight nested tables independently from XML depth", () => {
    let value = paragraph;
    for (let i = 0; i < 8; i++) value = table(value);
    expect(() => parseDocx(body(value))).not.toThrow();
    expect(() => parseDocx(body(table(value)))).toThrow(DocxError);
  });
  it("does not present web-hidden content as ordinary visible text", () => {
    const result = parseDocx(
      body(
        "<w:p><w:r><w:rPr><w:webHidden/></w:rPr><w:t>HIDDEN</w:t></w:r></w:p>",
      ),
    );
    expect(JSON.stringify(result)).not.toContain("HIDDEN");
    expect(result.warnings.some((w) => w.code === "hiddenContent")).toBe(true);
  });
  it("warns when a referenced paragraph style is absent", () => {
    const result = parseDocx(
      body(
        '<w:p><w:pPr><w:pStyle w:val="not-there"/></w:pPr><w:r><w:t>retained</w:t></w:r></w:p>',
      ),
    );
    expect(
      result.warnings.some((w) => w.code === "unsupportedFormatting"),
    ).toBe(true);
  });
  it("refuses fractional outline and list levels instead of inventing labels", () => {
    expect(() =>
      parseDocx(body('<w:p><w:pPr><w:outlineLvl w:val="1.5"/></w:pPr></w:p>')),
    ).toThrow(DocxError);
  });
  it("refuses ambiguous case-fold package aliases", () => {
    const input = docxFixture("01-text-values");
    input.entries.push("word/DOCUMENT.xml");
    input.parts.push({
      ...input.parts.find((p) => p.name === "word/document.xml")!,
      name: "word/DOCUMENT.xml",
    });
    expect(() => parseDocx(input)).toThrow(DocxError);
  });
  it("acknowledges inline picture effects instead of showing an unchanged image as complete", () => {
    const input = replaceDocxPart(
      docxFixture("05-inline-png-jpeg"),
      "word/document.xml",
      (s) =>
        s.replace(
          "</pic:spPr>",
          '<a:effectLst><a:blur rad="190500"/></a:effectLst></pic:spPr>',
        ),
    );
    const result = parseDocx(input);
    expect(result.partial).toBe(true);
    expect(result.warnings.some((w) => w.code === "unsupportedDrawing")).toBe(
      true,
    );
  });
  it("caps repeated image presentation even though resources are deduplicated", () => {
    const input = replaceDocxPart(
      docxFixture("05-inline-png-jpeg"),
      "word/document.xml",
      (s) => {
        const drawing = s.match(/<w:drawing>[\s\S]*?<\/w:drawing>/)![0];
        return s.replace(
          /<w:body>[\s\S]*<\/w:body>/,
          `<w:body><w:p>${`<w:r>${drawing}</w:r>`.repeat(DOCX_LIMITS.images + 1)}</w:p></w:body>`,
        );
      },
    );
    expect(() => parseDocx(input)).toThrow(DocxError);
  });
});
