import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { expect, it } from "vitest";
import { parseWorkbook } from "./xlsx_parse";
import { replacePart, workbookFixture } from "./xlsx_fixture";
import { XlsxError, type XlsxWorkerInput } from "./xlsx_types";

const MAIN =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const defaultType = (type = MAIN, extension = "xml") =>
  `<Default Extension="${extension}" ContentType="${type}"/>`;
const override = (type = MAIN) =>
  `<Override PartName="/xl/workbook.xml" ContentType="${type}"/>`;
function input(types: string) {
  return replacePart(
    workbookFixture('<row><c r="A1"><v>0</v></c></row>'),
    "[Content_Types].xml",
    () => `<Types xmlns="${NS}">${types}</Types>`,
  );
}
function rejects(types: string, code: "invalid" | "unsupported") {
  expect(() => parseWorkbook(input(types))).toThrowError(XlsxError);
  try {
    parseWorkbook(input(types));
  } catch (e) {
    expect((e as XlsxError).code).toBe(code);
  }
}
it.each(["xml", "XML", "xMl"])(
  "resolves an ordinary workbook from extension Default %s",
  (extension) => {
    expect(
      parseWorkbook(input(defaultType(MAIN, extension))).sheet!.cells[0].value,
    ).toBe(0);
  },
);
it.each([true, false])(
  "per-part Override precedes Default independent of order (%s)",
  (first) => {
    const declarations = [defaultType("application/xml"), override()];
    if (first) declarations.reverse();
    expect(
      parseWorkbook(input(declarations.join(""))).sheet!.cells[0].value,
    ).toBe(0);
  },
);
it("matches Override part names using ASCII case-insensitive comparison", () => {
  const types =
    defaultType("application/xml") +
    override().replace("/xl/workbook.xml", "/XL/WORKBOOK.XML");
  expect(parseWorkbook(input(types)).sheet!.cells[0].value).toBe(0);
});
it("rejects case-equivalent duplicate Override part names", () => {
  rejects(
    override() + override().replace("/xl/workbook.xml", "/XL/workbook.xml"),
    "invalid",
  );
});
it.each([
  "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml",
  "application/x-controlled-unknown",
])(
  "never uses a supported Default to bypass unsupported main Override %s",
  (type) => {
    rejects(defaultType() + override(type), "unsupported");
    rejects(defaultType(type), "unsupported");
  },
);
it("does not infer a main content type from the filename or XML alone", () => {
  rejects(defaultType(MAIN, "rels"), "unsupported");
  rejects("", "unsupported");
});
it.each([
  defaultType() + defaultType(MAIN, "XML"),
  defaultType() + defaultType("application/xml"),
  defaultType() + '<Default ContentType="application/xml"/>',
  defaultType() + '<Default Extension="png"/>',
  defaultType() + '<Default Extension="png" ContentType=""/>',
  defaultType() + defaultType(MAIN, ".xml"),
  defaultType() + defaultType(MAIN, "a/xml"),
  defaultType() + defaultType(MAIN, "xml%00"),
  defaultType() + defaultType(MAIN, " xml"),
  defaultType() + defaultType(MAIN, ""),
  override() + override(),
  defaultType() +
    '<Default Extension="png" ContentType="image/png"><Future/></Default>',
])(
  "rejects ambiguous or malformed mappings instead of selecting one (%#)",
  (types) => rejects(types, "invalid"),
);
it("does not accept a foreign declaration as a matching Default", () => {
  rejects(
    `<Default xmlns="urn:foreign" Extension="xml" ContentType="${MAIN}"/>`,
    "unsupported",
  );
});

// Bounded extraction for these exact authored fixture ZIPs only; not a product reader.
const directory = new URL(
  "../../docs/evidence/2026-10-09-capability-hardening/workbook-range/fixtures/",
  import.meta.url,
);
const originals = {
  "range-layout.xlsx":
    "c442df36a56e0ceaf07bbdee9a67b7c0b00238fe1b4cd9144e7e42189e47114d",
  "range-nonordinal-hidden.xlsx":
    "27743826c6c713ffb57aef4727bf0456cf2c88a23524c1ad5ec14c502b6dfdde",
};
function original(name: keyof typeof originals): XlsxWorkerInput {
  const zip = readFileSync(new URL(name, directory));
  expect(createHash("sha256").update(zip).digest("hex")).toBe(originals[name]);
  const entries: string[] = [],
    parts: XlsxWorkerInput["parts"] = [];
  let at = zip.indexOf(Buffer.from("PK\x01\x02", "binary"));
  while (at >= 0 && zip.readUInt32LE(at) === 0x02014b50) {
    const length = zip.readUInt16LE(at + 28),
      name = zip.subarray(at + 46, at + 46 + length).toString();
    const local = zip.readUInt32LE(at + 42),
      packed = zip.readUInt32LE(at + 20);
    const start =
        local +
        30 +
        zip.readUInt16LE(local + 26) +
        zip.readUInt16LE(local + 28),
      method = zip.readUInt16LE(at + 10);
    expect([0, 8]).toContain(method);
    const bytes =
      method === 0
        ? zip.subarray(start, start + packed)
        : inflateRawSync(zip.subarray(start, start + packed), {
            maxOutputLength: 4 * 1024 * 1024,
          });
    expect(bytes.length).toBe(zip.readUInt32LE(at + 24));
    entries.push(name);
    if (/\.(xml|rels)$/.test(name))
      parts.push({ name, data: bytes.toString("base64") });
    at += 46 + length + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  expect(entries).toHaveLength(10);
  return { entries, parts };
}
for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
  it(`reads every original sheet without rewriting ${name}`, () => {
    const source = original(name),
      first = parseWorkbook(source);
    expect(first.sheets).toHaveLength(2);
    if (name === "range-nonordinal-hidden.xlsx")
      expect(first.sheets.map((s) => s.id)).toEqual([
        "sheet-main-A9",
        "sheet-other-17",
      ]);
    for (const sheet of first.sheets) {
      const preview = parseWorkbook({ ...source, sheetId: sheet.id });
      expect(preview.sheet!.id).toBe(sheet.id);
      expect(
        preview.sheet!.cells.find((c) => c.reference === "A2")?.value,
      ).toBe(0);
      expect(
        preview.sheet!.cells.find((c) => c.reference === "B2")?.value,
      ).toBe(false);
      expect(
        preview.sheet!.cells.find((c) => c.reference === "F2")?.value,
      ).toBe(2);
    }
  });
}
