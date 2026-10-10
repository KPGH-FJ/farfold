import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { docxFixture, replaceDocxPart } from "./docx_fixture";
import { parseDocx } from "./docx_parse";
import { checkedDocxDocument } from "./docx_validation";
import { DocxError, type DocxBlock, type DocxDocument } from "./docx_types";

type Source = { part: string; elementPath: number[] };
const source = (block: DocxBlock) =>
  (block as DocxBlock & { source?: Source }).source;
const checked = checkedDocxDocument as (
  value: unknown,
  capturedParts: ReadonlySet<string>,
) => DocxDocument;
const input = docxFixture("01-text-values");
const allowed = new Set(input.parts.map((part) => part.name));
function flatten(blocks: DocxBlock[]): DocxBlock[] {
  return blocks.flatMap((block) => [
    block,
    ...(block.kind === "table"
      ? block.rows.flatMap((row) =>
          row.cells.flatMap((cell) => flatten(cell.blocks)),
        )
      : []),
  ]);
}
const oracle = JSON.parse(
  readFileSync(
    new URL(
      "../../docs/evidence/2026-10-09-capability-hardening/docx-feedback/fixtures/oracle.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  fixtures: {
    file: string;
    targets: { part: string; elementPath: number[]; blockKind: string }[];
  }[];
};

describe("DOCX original XML coordinates, independent ZIP oracle", () => {
  for (const sample of oracle.fixtures) {
    it(sample.file, () => {
      const path = sample.file.split("capability-hardening/")[1];
      const slash = path.lastIndexOf("/");
      const capture = docxFixture(
        path.slice(slash + 1, -5),
        path.slice(0, slash),
      );
      const document = parseDocx(capture);
      const blocks = flatten(document.blocks).concat(
        document.stories.flatMap((story) => flatten(story.blocks)),
      );
      const supported = blocks.filter((block) => block.kind !== "notice");
      expect(supported.length).toBeGreaterThan(0);
      for (const block of supported) {
        expect(source(block)).toBeDefined();
        expect(sample.targets).toContainEqual(
          expect.objectContaining({ ...source(block), blockKind: block.kind }),
        );
      }
      expect(
        checked(document, new Set(capture.parts.map((part) => part.name))),
      ).toBe(document);
    });
  }
  it("identical text in six places keeps six independent original coordinates", () => {
    const document = parseDocx(
      docxFixture("repeated-locations", "docx-feedback/fixtures"),
    );
    const blocks = flatten(document.blocks).concat(
      document.stories.flatMap((s) => flatten(s.blocks)),
    );
    const duplicates = blocks.filter(
      (block) =>
        block.kind === "paragraph" &&
        block.runs
          .map((run) => (run.kind === "text" ? run.text : ""))
          .join("") === "DUPLICATE 0 false cafe",
    );
    expect(duplicates.map(source)).toEqual([
      { part: "word/document.xml", elementPath: [0, 1] },
      { part: "word/document.xml", elementPath: [0, 3] },
      { part: "word/document.xml", elementPath: [0, 5, 2, 0, 1] },
      { part: "word/document.xml", elementPath: [0, 5, 2, 1, 1] },
      { part: "word/header1.xml", elementPath: [0] },
      { part: "word/footer1.xml", elementPath: [0] },
    ]);
  });
  it("keeps chosen fallback wrappers and note separator positions", () => {
    expect(
      parseDocx(docxFixture("16-alternate-content")).blocks.map(source),
    ).toEqual([{ part: "word/document.xml", elementPath: [0, 0, 1, 0] }]);
    const note = parseDocx(
      docxFixture("07-header-footer-footnote"),
    ).stories.find((story) => story.kind === "footnote")!;
    expect(note.blocks.map(source)).toEqual([
      { part: "word/footnotes.xml", elementPath: [2, 0] },
    ]);
  });
  it("does not renumber after original property and inert marker elements", () => {
    const changed = replaceDocxPart(input, "word/document.xml", (xml) =>
      xml.replace(
        /<w:body>[\s\S]*<\/w:body>/,
        '<w:body><w:bookmarkStart w:id="2" w:name="marker"/><w:p><w:pPr/><w:r><w:t>same</w:t></w:r></w:p><w:proofErr w:type="spellStart"/><w:p><w:r><w:t>same</w:t></w:r></w:p></w:body>',
      ),
    );
    expect(parseDocx(changed).blocks.map(source)).toEqual([
      { part: "word/document.xml", elementPath: [0, 1] },
      { part: "word/document.xml", elementPath: [0, 3] },
    ]);
  });
  it("unsupported block notices have no invented source field", () => {
    const changed = replaceDocxPart(input, "word/document.xml", (xml) =>
      xml.replace(
        /<w:body>[\s\S]*<\/w:body>/,
        "<w:body><w:sdt><w:sdtContent><w:p/></w:sdtContent></w:sdt></w:body>",
      ),
    );
    const document = parseDocx(changed);
    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0].kind).toBe("notice");
    expect(document.blocks[0]).not.toHaveProperty("source");
    expect(checked(document, allowed)).toBe(document);
  });
});

const valid = () => ({
  blocks: [
    {
      kind: "paragraph",
      id: "block-1",
      source: { part: "word/document.xml", elementPath: [0, 0] },
      runs: [],
      style: {},
    },
  ],
  stories: [],
  images: [],
  warnings: [{ code: "continuousLayout", count: 1 }],
  partial: false,
});
describe("closed DOCX coordinate Worker boundary", () => {
  it("accepts a supported original coordinate only within the current captured parts", () => {
    const document = valid();
    expect(checked(document, allowed)).toBe(document);
    expect(() => checked(document, new Set())).toThrow(DocxError);
  });
  it("rejects a missing coordinate instead of accepting a display id", () => {
    const document = valid();
    const { source: _source, ...paragraph } = document.blocks[0];
    expect(() =>
      checked({ ...document, blocks: [paragraph] }, allowed),
    ).toThrow(DocxError);
  });
  it.each([
    null,
    { part: "word/document.xml", elementPath: [] },
    { part: "word/document.xml", elementPath: [-1] },
    { part: "word/document.xml", elementPath: [0.5] },
    { part: "word/document.xml", elementPath: [500000] },
    { part: "word/document.xml", elementPath: Array(64).fill(0) },
    {
      part: "word/document.xml",
      elementPath: [0],
      quote: "not an anchor field",
    },
    { part: "word/not-captured.xml", elementPath: [0] },
    { part: "../word/document.xml", elementPath: [0] },
    { part: "/word/document.xml", elementPath: [0] },
  ])("rejects invalid or foreign coordinate %j", (position) => {
    const document = valid();
    expect(() =>
      checked(
        { ...document, blocks: [{ ...document.blocks[0], source: position }] },
        allowed,
      ),
    ).toThrow(DocxError);
  });
  it("rejects source metadata attached to a notice", () => {
    expect(() =>
      checked(
        {
          ...valid(),
          partial: true,
          blocks: [
            {
              kind: "notice",
              id: "n",
              code: "unsupportedContent",
              source: valid().blocks[0].source,
            },
          ],
        },
        allowed,
      ),
    ).toThrow(DocxError);
  });
  it("bounds the sum of repeated coordinate labels before exposing a Worker document", () => {
    const part = "a".repeat(1024),
      captured = new Set([part]);
    const blocks = Array.from({ length: 4096 }, (_, index) => ({
      ...valid().blocks[0],
      id: `p-${index}`,
      source: { part, elementPath: [0, index] },
    }));
    expect(checked({ ...valid(), blocks }, captured).blocks).toHaveLength(4096);
    expect(() =>
      checked(
        { ...valid(), blocks: [...blocks, { ...blocks[0], id: "over" }] },
        captured,
      ),
    ).toThrowError(expect.objectContaining({ code: "limit" }));
  });
});
