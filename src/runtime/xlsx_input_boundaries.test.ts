import { describe, expect, it } from "vitest";
import { workbookFixture, replacePart } from "./xlsx_fixture";
import { parseWorkbook } from "./xlsx_parse";
import { parseWorkbookInput } from "./xlsx_input_parse";
import { xlsxInputText } from "./xlsx_input_text";
import { checkedXlsxInputResult } from "./xlsx_input_validation";
import { inputZipFixture } from "./xlsx_input_fixture.test-support";
import type { XlsxWorkerInput } from "./xlsx_types";
const request = { mode: "visible-saved-cells" as const };
/** Author two real XML parts; no future parser result is reused as an oracle. */
function twoSheets(
  rows: string,
  options: Parameters<typeof workbookFixture>[1] = {},
): XlsxWorkerInput {
  let input = workbookFixture(rows, options);
  input = replacePart(input, "xl/workbook.xml", (x) =>
    x.replace(
      "</sheets>",
      '<sheet name="第二页" sheetId="2" r:id="sheet2"/></sheets>',
    ),
  );
  input = replacePart(input, "xl/_rels/workbook.xml.rels", (x) =>
    x.replace(
      "</Relationships>",
      '<Relationship Id="sheet2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    ),
  );
  const source = input.parts.find(
    (p) => p.name === "xl/worksheets/sheet1.xml",
  )!;
  return {
    ...input,
    entries: [...input.entries, "xl/worksheets/sheet2.xml"],
    parts: [
      ...input.parts,
      { name: "xl/worksheets/sheet2.xml", data: source.data },
    ],
  };
}
describe("XLSX input aggregate bounds and explicit uncertain features", () => {
  it("counts cells across all selected sheets even when each old preview fits", () => {
    const rows = Array.from(
      { length: 50001 },
      (_, i) => '<row r="' + (i + 1) + '"><c><v>0</v></c></row>',
    ).join("");
    const input = twoSheets(rows);
    expect(parseWorkbook(input).sheet?.cells).toHaveLength(50001);
    expect(() => parseWorkbookInput(input, request)).toThrowError("limit");
  });
  it("counts repeated rich SST expansion across selected sheets, not only stored shared strings", () => {
    const rows = Array.from(
      { length: 25001 },
      (_, i) => '<row r="' + (i + 1) + '"><c t="s"><v>0</v></c></row>',
    ).join("");
    const input = twoSheets(rows, {
      strings: "<si><r><t>one</t></r><r><t>two</t></r></si>",
    });
    expect(parseWorkbook(input).sheet?.cells).toHaveLength(25001);
    expect(() => parseWorkbookInput(input, request)).toThrowError("limit");
  });
  it("counts all parsed XML nodes once for the operation rather than granting each part another 500k", () => {
    const input = twoSheets("<row><c><v>0</v></c></row>", {
      extra: "<extLst>" + "<x/>".repeat(250000) + "</extLst>",
    });
    expect(parseWorkbook(input).sheet?.cells).toHaveLength(1);
    expect(() => parseWorkbookInput(input, request)).toThrowError("limit");
  });
  it("counts merge area across sheets without populating the empty grid", () => {
    const input = twoSheets("<row><c><v>0</v></c></row>", {
      extra: '<mergeCells><mergeCell ref="A1:B37500"/></mergeCells>',
    });
    expect(parseWorkbook(input).sheet?.cells).toHaveLength(1);
    expect(() => parseWorkbookInput(input, request)).toThrowError("limit");
  });
  it("missing application flags retain unknown formula protection, never silently expose hidden expression by default", () => {
    const capture = inputZipFixture("02-protection-format");
    const input = replacePart(capture, "xl/styles.xml", (x) =>
      x.replace('applyProtection="1"', ""),
    );
    const r = checkedXlsxInputResult(
      parseWorkbookInput(input, request),
      input,
      request,
    );
    expect(r.partial).toBe(true);
    expect(r.warnings).toContainEqual({ code: "unknownVisibility", count: 2 });
    const cell = r.selectedSheets[0].cells.find((c) => c.reference === "A1")!;
    expect(cell.formula?.included).toBe(false);
    expect(cell.rawValue).toBe("7");
    expect(cell.included).toBe(true);
    expect(xlsxInputText(r).text).not.toContain('"expression":"6+1"');
  });
  it("huge finite/underflow lexical numbers remain exact raw data, never become rounded/infinite or zero author content", () => {
    const raw = ["1e400", "1e-400", "9007199254740993", "1e" + "9".repeat(70)];
    const input = workbookFixture(
      "<row>" +
        raw
          .map(
            (v, i) =>
              '<c r="' +
              String.fromCharCode(65 + i) +
              '1"><v>' +
              v +
              "</v></c>",
          )
          .join("") +
        "</row>",
    );
    const r = checkedXlsxInputResult(
      parseWorkbookInput(input, request),
      input,
      request,
    );
    expect(r.selectedSheets[0].cells.map((c) => c.rawValue)).toEqual(raw);
    expect(
      r.selectedSheets[0].cells.every(
        (c) => c.display === null && !c.displayKnown && c.included,
      ),
    ).toBe(true);
    for (const v of raw) expect(xlsxInputText(r).text).toContain(v);
  });
  it("blank/missing-cache-only/generated omission text never qualifies as authored content; literal [1], zero and false do", () => {
    for (const xml of [
      "<c/>",
      '<c><f t="shared" si="0"/></c>',
      '<c t="str"><v/></c>',
      '<c t="inlineStr"><is><t>   </t></is></c>',
    ]) {
      const input = workbookFixture("<row>" + xml + "</row>");
      expect(
        xlsxInputText(
          checkedXlsxInputResult(
            parseWorkbookInput(input, request),
            input,
            request,
          ),
        ).actualTextChars,
      ).toBe(0);
    }
    for (const xml of [
      '<c t="inlineStr"><is><t>[1]</t></is></c>',
      "<c><v>0</v></c>",
      '<c t="b"><v>0</v></c>',
    ]) {
      const input = workbookFixture("<row>" + xml + "</row>");
      expect(
        xlsxInputText(
          checkedXlsxInputResult(
            parseWorkbookInput(input, request),
            input,
            request,
          ),
        ).actualTextChars,
      ).toBeGreaterThan(0);
    }
  });
  it("unread binary assets and phonetic features have real distinct units/counts, and none executes", () => {
    const input = workbookFixture('<row><c t="s"><v>0</v></c></row>', {
      strings:
        '<si><t>ABC</t><rPh sb="0" eb="1"><t>unread1</t></rPh><rPh sb="1" eb="2"><t>unread2</t></rPh><phoneticPr fontId="0"/></si>',
    });
    input.entries.push("xl/embeddings/file1.bin", "xl/activeX/active1.bin");
    const r = checkedXlsxInputResult(
      parseWorkbookInput(input, request),
      input,
      request,
    );
    expect(r.warnings).toContainEqual({ code: "unsupportedContent", count: 3 });
    expect(r.warnings).toContainEqual({ code: "unsupportedAssets", count: 2 });
    expect(r.partial).toBe(true);
    const text = xlsxInputText(r).text;
    expect(text).toContain("ABC");
    expect(text).not.toContain("unread1");
    expect(text).not.toContain("unread2");
  });
  it("foreign/malformed rich text and conflicting inline/formula structure are refused instead of empty successful content", () => {
    for (const xml of [
      '<c t="inlineStr"><f>1+1</f><is><t>lost</t></is></c>',
      '<c t="inlineStr"><is><foreign:t xmlns:foreign="urn:future">lost</foreign:t></is></c>',
      '<c t="n"><v>notNumber</v></c>',
      '<c t="b"><v>2</v></c>',
    ])
      expect(() =>
        parseWorkbookInput(workbookFixture("<row>" + xml + "</row>"), request),
      ).toThrowError();
  });
});
