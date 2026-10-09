import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { docxFixture, replaceDocxPart } from "./docx_fixture";
import { parseDocx } from "./docx_parse";
import { DocxError } from "./docx_types";
function largePng() {
  const chunk = (type: string, data: Buffer) => {
    const value = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of value) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    const head = Buffer.alloc(4),
      tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, value, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4096, 0);
  header.writeUInt32BE(4096, 4);
  header[8] = 1;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(513 * 4096))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
describe("DOCX aggregate image presentation budget", () => {
  it("renders ordinary Unicode bullets without an rFonts node", () => {
    const input = replaceDocxPart(
      docxFixture("03-list-restart"),
      "word/numbering.xml",
      (xml) =>
        xml
          .replaceAll('w:val="decimal"', 'w:val="bullet"')
          .replaceAll('w:val="%1."', 'w:val="•"'),
    );
    const result = parseDocx(input);
    expect(
      result.blocks
        .filter((b) => b.kind === "paragraph")
        .map((p) => p.list?.label),
    ).toEqual(["•", "•", "•", "•"]);
  });

  it("allows exactly 33M referenced pixels, rejects three copies even when one resource is shared", () => {
    const png = largePng();
    let base = docxFixture("05-inline-png-jpeg");
    const pngPart = base.parts.find((p) => p.name.endsWith(".png"))!;
    pngPart.data = png.toString("base64");
    const repeated = (count: number) =>
      replaceDocxPart(base, "word/document.xml", (xml) => {
        const drawing = xml.match(/<w:drawing>[\s\S]*?<\/w:drawing>/)![0];
        return xml.replace(
          /<w:body>[\s\S]*<\/w:body>/,
          `<w:body><w:p>${`<w:r>${drawing}</w:r>`.repeat(count)}</w:p></w:body>`,
        );
      });
    const accepted = parseDocx(repeated(2));
    expect(accepted.images).toHaveLength(1);
    expect(accepted.images[0].width * accepted.images[0].height).toBe(16777216);
    expect(() => parseDocx(repeated(3))).toThrow(DocxError);
  });
  it("does not guess an arbitrary private-use bullet from another font", () => {
    const input = replaceDocxPart(
      docxFixture("01-unicode-lists", "docx-compatibility"),
      "word/numbering.xml",
      (xml) => xml.replaceAll("Symbol", "UnknownPublicFixtureFont"),
    );
    const result = parseDocx(input);
    expect(result.partial).toBe(true);
    expect(result.warnings.some((w) => w.code === "listFormat")).toBe(true);
    expect(
      result.blocks.some(
        (b) => b.kind === "paragraph" && b.list?.label === "[U+F0B7]",
      ),
    ).toBe(true);
  });
});
