import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { workbookFixture } from "./xlsx_fixture";
import { parseWorkbook } from "./xlsx_parse";
import { XlsxError, type XlsxWorkerInput } from "./xlsx_types";

const directory = new URL(
  "../../docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/",
  import.meta.url,
);
const originals = {
  "positions-v1.xlsx":
    "6c026d2d3180a52e06b0a250e6594f5c26594447b3cea49e42e2c03852f6e349",
  "positions-v2.xlsx":
    "1afd11016000d807761dc93d874b9044a3267d7cd2a43d3ea9145bb999d969d6",
  "positions-v1-nonordinal-ids.xlsx":
    "4cee8ba3fcb587adbaa2ce3d1fdcfdde439e8e0bb1e59162db929255e1af5dae",
};
const oracle = JSON.parse(
  readFileSync(new URL("oracle.json", directory), "utf8"),
);

/** Only these three hash-checked fixture ZIPs; not a product archive reader. */
function original(name: keyof typeof originals): XlsxWorkerInput {
  const zip = readFileSync(new URL(name, directory));
  expect(createHash("sha256").update(zip).digest("hex")).toBe(originals[name]);
  const entries: string[] = [];
  const parts: XlsxWorkerInput["parts"] = [];
  let at = zip.indexOf(Buffer.from("PK\x01\x02", "binary"));
  while (at >= 0 && zip.readUInt32LE(at) === 0x02014b50) {
    const length = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 46, at + 46 + length).toString();
    const local = zip.readUInt32LE(at + 42);
    const packed = zip.readUInt32LE(at + 20);
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const method = zip.readUInt16LE(at + 10);
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
  expect(entries).toHaveLength(oracle[name].entryCount);
  return { entries, parts };
}
function cell(xml: string) {
  return parseWorkbook(workbookFixture(`<row>${xml}</row>`)).sheet!.cells[0];
}
function rejected(xml: string, code: "invalid" | "unsupported") {
  expect(() => cell(xml)).toThrowError(XlsxError);
  try {
    cell(xml);
  } catch (error) {
    expect((error as XlsxError).code).toBe(code);
  }
}

describe("exact ordinary-writer workbook compatibility", () => {
  for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
    it(`reads all original sheets without modifying ${name}`, () => {
      const input = original(name);
      const workbook = parseWorkbook(input);
      expect(workbook.sheets).toEqual(
        oracle[name].sheets.map(
          (s: { relationshipId: string; name: string; state: string }) => ({
            id: s.relationshipId,
            name: s.name,
            state: s.state,
          }),
        ),
      );
      for (const sheet of oracle[name].sheets) {
        const parsed = parseWorkbook({
          ...input,
          sheetId: sheet.relationshipId,
        }).sheet!;
        expect(parsed.id).toBe(sheet.relationshipId);
        expect(parsed.cells.map((c) => c.reference).sort()).toEqual(
          Object.keys(sheet.cells).sort(),
        );
        const cells = Object.fromEntries(
          parsed.cells.map((c) => [c.reference, c]),
        );
        expect(cells.A2.value).toBe(Number(sheet.cells.A2.rawValue));
        expect(cells.B2.value).toBe(sheet.cells.B2.rawValue === "1");
        expect(cells.C2).toMatchObject({
          type: "blank",
          raw: null,
          value: null,
          display: "",
          formulaPresent: false,
          cacheState: "notFormula",
        });
        expect(cells.D2).toBeUndefined();
        expect(cells.E2).toMatchObject({
          type: "blank",
          value: null,
          styleId: sheet.cells.E2.styleId,
        });
        expect(cells.F2).toMatchObject({
          type: "blank",
          raw: "",
          value: null,
          display: null,
          formula: sheet.cells.F2.formula,
          formulaPresent: true,
          cacheState: "missing",
          formatIssue: "missingCache",
        });
      }
    });
  }
});

describe("empty records preserve encoded meaning", () => {
  it("accepts absent inline payload as an existing styled blank without inventing text", () => {
    expect(cell('<c r="C1" s="1" t="inlineStr"/>')).toMatchObject({
      reference: "C1",
      styleId: 1,
      type: "blank",
      raw: null,
      value: null,
      display: "",
      cacheState: "notFormula",
    });
  });
  it.each(["<is/>", "<is><t/></is>"])(
    "retains explicitly encoded empty text %s",
    (payload) => {
      expect(cell(`<c t="inlineStr">${payload}</c>`)).toMatchObject({
        type: "text",
        raw: "",
        value: "",
        display: "",
        cacheState: "notFormula",
      });
    },
  );
  it.each(["<f>1+1</f>", "<f>1+1</f><v/>"])(
    "keeps missing numeric formula results uncomputed %s",
    (payload) => {
      expect(cell(`<c>${payload}</c>`)).toMatchObject({
        formulaPresent: true,
        formula: "1+1",
        cacheState: "missing",
        value: null,
        display: null,
        formatIssue: "missingCache",
      });
    },
  );
  it("does not collapse numeric zero, boolean false or cached empty text", () => {
    expect(cell("<c><f>1-1</f><v>0</v></c>")).toMatchObject({
      type: "number",
      value: 0,
      raw: "0",
      display: "0",
      cacheState: "present",
    });
    expect(cell('<c t="b"><f>FALSE()</f><v>0</v></c>')).toMatchObject({
      type: "boolean",
      value: false,
      raw: "0",
      display: "FALSE",
      cacheState: "present",
    });
    expect(cell('<c t="str"><f>EMPTY()</f><v/></c>')).toMatchObject({
      type: "text",
      value: "",
      raw: "",
      display: "",
      cacheState: "present",
    });
  });
  it.each([
    "<c><v/></c>",
    '<c t="b"><f>FALSE()</f><v/></c>',
    '<c t="e"><f>BAD()</f><v/></c>',
    '<c t="s"><v/></c>',
    "<c><f>1+1</f><v> </v></c>",
  ])("does not broadly coerce other empty or invalid values %s", (xml) =>
    rejected(xml, "invalid"),
  );
});

describe("empty compatibility must not hide malformed cell structure", () => {
  it.each([
    '<c t="inlineStr"><f>1+1</f></c>',
    '<c t="inlineStr"><f>1+1</f><is><t>x</t></is></c>',
    '<c t="inlineStr"><v/></c>',
    '<c t="inlineStr"><is/><v/></c>',
    "<c><f>1+1</f><is><t>x</t></is></c>",
    '<c t="s"><f>1+1</f></c>',
    '<c t="inlineStr"><is/><is/></c>',
    "<c><f>1+1</f><f>2+2</f></c>",
    "<c><v/><v/></c>",
    '<c t="inlineStr">lost text</c>',
    '<c t="inlineStr"><is>lost text</is></c>',
  ])("rejects conflicting or unrepresented content %s", (xml) =>
    rejected(xml, "invalid"),
  );
  it.each([
    '<c t="inlineStr"><future>lost</future></c>',
    '<c t="inlineStr"><is><future>lost</future></is></c>',
    "<c><f>1+1</f><v><future>lost</future></v></c>",
    "<c><f><future>lost</future></f></c>",
    '<c t="future"><f>1+1</f></c>',
  ])("rejects unknown leaf/type structure %s", (xml) =>
    rejected(xml, "unsupported"),
  );
});
