import { describe, expect, it } from "vitest";
import { parseWorkbook } from "./xlsx_parse";
import { workbookFixture, replacePart, xmlBase64 } from "./xlsx_fixture";
import { XLSX_LIMITS, XLSX_WARNING_CODES, XlsxError } from "./xlsx_types";

function rejected(run: () => unknown, code?: string) {
  try {
    run();
    throw new Error("unexpected success");
  } catch (e) {
    expect(e).toBeInstanceOf(XlsxError);
    if (code) expect((e as XlsxError).code).toBe(code);
  }
}
describe("OOXML typed cells and formatting", () => {
  it("preserves zero, false, empty, absent and error formula caches independently", () => {
    const result = parseWorkbook(
      workbookFixture(
        `<row r="1"><c r="A1"><f>1-1</f><v>0</v></c><c r="B1" t="b" s="3"><f>FALSE()</f><v>0</v></c><c r="C1" t="str"><f>IF(1,\"\",\"x\")</f><v/></c><c r="D1"><f>1+1</f></c><c r="E1" t="e" s="3"><f>1/0</f><v>#DIV/0!</v></c></row>`,
      ),
    );
    expect(
      result.sheet!.cells.map((c) => [
        c.value,
        c.cacheState,
        c.display,
        c.type,
      ]),
    ).toEqual([
      [0, "present", "0", "number"],
      [false, "present", "FALSE", "boolean"],
      ["", "present", "", "text"],
      [null, "missing", null, "blank"],
      ["#DIV/0!", "present", "#DIV/0!", "error"],
    ]);
    expect(result.sheet!.cells[3].formatIssue).toBe("missingCache");
  });
  it("renders precision, dates, elapsed hours and basic styles from original values", () => {
    const result = parseWorkbook(
      workbookFixture(
        `<row r="1" ht="22"><c r="A1" s="1"><v>0.12</v></c><c r="B1" s="2"><v>1234.5</v></c><c r="C1" s="3"><v>60</v></c><c r="D1" s="4"><v>1.5</v></c></row>`,
        {
          before: '<cols><col min="1" max="2" width="20"/></cols>',
          extra: '<mergeCells><mergeCell ref="A2:B2"/></mergeCells>',
        },
      ),
    );
    expect(result.sheet!.cells.map((c) => c.display)).toEqual([
      "12.00%",
      "1,234.50",
      "1900-02-29",
      "36:00",
    ]);
    expect(result.styles[0]).toMatchObject({
      font: { name: "Arial", size: 11, bold: true, color: "#112233" },
      fill: "#EEDDCC",
      borders: { bottom: { style: "thin", color: "#000000" } },
    });
    expect(result.sheet!.rows[0].height).toBe(22);
    expect(result.sheet!.columns[0].width).toBe(20);
    expect(result.sheet!.merges).toEqual([
      { fromRow: 2, toRow: 2, fromColumn: 1, toColumn: 2 },
    ]);
    expect(
      parseWorkbook(
        workbookFixture('<row><c s="3"><v>0</v></c></row>', { date1904: true }),
      ).sheet!.cells[0].display,
    ).toBe("1904-01-01");
  });
  it("keeps rich/shared text inert and resolves package-relative sheet paths", () => {
    const input = workbookFixture(
      '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>&lt;script&gt;你好&lt;/script&gt;</t></is></c></row>',
      {
        strings: "<si><r><rPr><b/></rPr><t>中文</t></r><r><t>文字</t></r></si>",
      },
    );
    const result = parseWorkbook(
      replacePart(input, "xl/_rels/workbook.xml.rels", (xml) =>
        xml.replace(
          'Target="worksheets/sheet1.xml"',
          'Target="../xl/worksheets/sheet1.xml"',
        ),
      ),
    );
    expect(result.sheet!.cells.map((c) => c.display)).toEqual([
      "中文文字",
      "<script>你好</script>",
    ]);
    expect(result.sheet!.cells[0].runs).toHaveLength(2);
  });
  it("decodes ST_Xstring once per text run and preserves escaped marker text", () => {
    const input = workbookFixture(
      '<row><c r="A1" t="inlineStr"><is><t>Line1_x000D_Line2</t></is></c><c r="B1" t="str"><f>"x"</f><v>_x005F_x0041_</v></c><c r="C1" t="s"><v>0</v></c></row>',
      {
        strings:
          "<si><r><t>_x005F_x0041_</t></r><r><t>_x00</t></r><r><t>41_</t></r></si>",
      },
    );
    const result = parseWorkbook(
      replacePart(input, "xl/workbook.xml", (x) =>
        x.replace('name="样本"', 'name="Sheet_x005F_x0041_"'),
      ),
    );
    expect(result.sheet!.cells.map((c) => c.value)).toEqual([
      "Line1\rLine2",
      "_x0041_",
      "_x0041__x0041_",
    ]);
    expect(result.sheet!.cells[1].raw).toBe("_x005F_x0041_");
    expect(result.sheets[0].name).toBe("Sheet_x0041_");
  });
  it.each([
    '<is><foreign:text xmlns:foreign="urn:controlled-future">lost</foreign:text></is>',
    "<is><r><future>lost</future></r></is>",
    "<is><t><future>lost</future></t></is>",
  ])(
    "rejects unrecognized rich text instead of returning a false empty string %s",
    (is) => {
      rejected(
        () =>
          parseWorkbook(
            workbookFixture(`<row><c t="inlineStr">${is}</c></row>`),
          ),
        "unsupported",
      );
    },
  );
  it("retains defaults for empty cells in styled rows and columns", () => {
    const result = parseWorkbook(
      workbookFixture('<row r="2" customFormat="1" s="2"/>', {
        before: '<cols><col min="1" max="2" style="1"/></cols>',
      }),
    );
    expect(result.sheet!.rows[0]).toMatchObject({ index: 2, styleId: 2 });
    expect(result.sheet!.columns[0]).toMatchObject({
      min: 1,
      max: 2,
      styleId: 1,
    });
  });
  it("decodes number-format ST_Xstring without a second pass", () => {
    let input = workbookFixture('<row><c s="3"><v>2</v></c></row>');
    input = replacePart(input, "xl/styles.xml", (x) =>
      x.replace(
        'formatCode="yyyy-mm-dd"',
        'formatCode="&quot;_x005F_x0041_&quot;0"',
      ),
    );
    const result = parseWorkbook(input);
    expect(result.styles[3].numFmt).toBe('"_x0041_"0');
    // Fixed SSF rejects underscores in quoted literals. Preserve the exact
    // decoded format and expose unsupported instead of inventing a display.
    expect(result.sheet!.cells[0]).toMatchObject({
      display: null,
      formatIssue: "unsupportedFormat",
    });
    const supported = parseWorkbook(
      replacePart(input, "xl/styles.xml", (x) =>
        x.replace("_x005F_x0041_", "_x0041_"),
      ),
    );
    expect(supported.sheet!.cells[0].display).toBe("A2");
  });
  it("keeps shared formula presence when its dependent cell omits full formula text", () => {
    const result = parseWorkbook(
      workbookFixture(
        '<row><c r="A1"><f t="shared" si="0" ref="A1:A2">B1+1</f><v>2</v></c></row><row r="2"><c r="A2"><f t="shared" si="0"/><v>3</v></c><c r="B2"><f/><v>0</v></c></row>',
      ),
    );
    expect(
      result.sheet!.cells.map((c) => [
        c.formulaPresent,
        c.formula,
        c.cacheState,
        c.value,
      ]),
    ).toEqual([
      [true, "B1+1", "present", 2],
      [true, null, "present", 3],
      [true, null, "present", 0],
    ]);
  });
  it("decodes font names and suppresses unsupported custom indexed palette colors", () => {
    let input = workbookFixture(
      '<row><c><v>2</v></c><c t="inlineStr"><is><r><rPr><rFont val="Font_x005F_x0041_"/></rPr><t>x</t></r></is></c></row>',
    );
    input = replacePart(input, "xl/styles.xml", (x) =>
      x
        .replace('val="Arial"', 'val="Font_x005F_x0041_"')
        .replace('rgb="FF112233"', 'indexed="2"')
        .replace(
          "</styleSheet>",
          '<colors><indexedColors><rgbColor rgb="FF101010"/><rgbColor rgb="FF202020"/><rgbColor rgb="FF303030"/></indexedColors></colors></styleSheet>',
        ),
    );
    const result = parseWorkbook(input);
    expect(result.styles[0].font.name).toBe("Font_x0041_");
    expect(result.sheet!.cells[1].runs?.[0].font?.name).toBe("Font_x0041_");
    expect(result.styles[0].font.color).toBeUndefined();
    expect(result.warnings).toEqual(
      expect.arrayContaining(["customIndexedColors", "unsupportedColor"]),
    );
  });
  it("uses sparse coordinates without allocating dimensions", () => {
    const result = parseWorkbook(
      workbookFixture('<row r="1048576"><c r="XFD1048576"><v>7</v></c></row>', {
        before: '<dimension ref="A1:XFD1048576"/>',
      }),
    );
    expect(result.sheet!.cells).toHaveLength(1);
    expect(result.sheet!.rows).toHaveLength(1);
    expect(result.sheet!.cells[0].column).toBe(16384);
  });
  it("does not fetch external relations and discloses unsupported features by stable code", () => {
    let input = workbookFixture("<row><c><v>1</v></c></row>", {
      extra: "<conditionalFormatting/><extLst/>",
    });
    input = replacePart(input, "xl/_rels/workbook.xml.rels", (xml) =>
      xml.replace(
        "</Relationships>",
        '<Relationship Id="external" Type="other" TargetMode="External" Target="https://example.invalid/secret"/></Relationships>',
      ),
    );
    const result = parseWorkbook(input);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "externalRelationships",
        "conditionalFormatting",
        "unsupportedSheetContent",
      ]),
    );
    expect(
      result.warnings.every((w) =>
        (XLSX_WARNING_CODES as readonly string[]).includes(w),
      ),
    ).toBe(true);
  });
});
describe("OOXML bounded invalid inputs", () => {
  it.each([
    ['<!DOCTYPE worksheet SYSTEM "https://example.invalid/a">', "unsupported"],
    ['<!DOCTYPE worksheet [<!ENTITY x "test">]>', "unsupported"],
  ])("rejects DTD before any external access %s", (prefix, code) => {
    const input = replacePart(
      workbookFixture(""),
      "xl/worksheets/sheet1.xml",
      (x) => prefix + x,
    );
    rejected(() => parseWorkbook(input), code);
  });
  it("rejects excessive nesting, malformed XML and duplicate parts/relations", () => {
    for (const xml of ["<x>".repeat(65) + "</x>".repeat(65), "<x><y></x>"]) {
      const input = replacePart(
        workbookFixture(""),
        "xl/worksheets/sheet1.xml",
        () => xml,
      );
      rejected(() => parseWorkbook(input));
    }
    const input = workbookFixture("");
    rejected(
      () =>
        parseWorkbook({ ...input, parts: [...input.parts, input.parts[0]] }),
      "invalid",
    );
    rejected(
      () =>
        parseWorkbook(
          replacePart(input, "xl/_rels/workbook.xml.rels", (x) =>
            x.replace('Id="styles"', 'Id="sheet1"'),
          ),
        ),
      "invalid",
    );
    rejected(
      () =>
        parseWorkbook(
          replacePart(input, "xl/_rels/workbook.xml.rels", (x) =>
            x.replace(
              'Target="worksheets/sheet1.xml"',
              'Target="../../outside.xml"',
            ),
          ),
        ),
      "invalid",
    );
  });
  it.each([
    '<row><c r="A1"/><c r="A1"/></row>',
    '<row><c r="XFE1"/></row>',
    '<row><c s="99"/></row>',
    '<row><c t="s"><v>3</v></c></row>',
    "<row><c><v>NaN</v></c></row>",
    "<row><c><v>1e999</v></c></row>",
  ])("rejects invalid cell structure %s", (rows) =>
    rejected(() => parseWorkbook(workbookFixture(rows)), "invalid"),
  );
  it("rejects overlapping and huge merges rather than expanding or hiding them", () => {
    for (const extra of [
      '<mergeCells><mergeCell ref="A1:B2"/><mergeCell ref="B2:C3"/></mergeCells>',
      '<mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells>',
    ])
      rejected(() => parseWorkbook(workbookFixture("", { extra })));
  });
  it("bounds repeated shared-string expansion, not only compressed/source text", () => {
    const value = "x".repeat(100000),
      cells = Array.from(
        { length: 100 },
        (_, i) => `<row r="${i + 1}"><c t="s"><v>0</v></c></row>`,
      ).join("");
    rejected(
      () =>
        parseWorkbook(
          workbookFixture(cells, { strings: `<si><t>${value}</t></si>` }),
        ),
      "limit",
    );
  });
  it("bounds logically repeated runs including empty text", () => {
    const strings = `<si>${"<r><t/></r>".repeat(1001)}</si>`;
    const rows = Array.from(
      { length: 100 },
      (_, i) => `<row r="${i + 1}"><c t="s"><v>0</v></c></row>`,
    ).join("");
    rejected(() => parseWorkbook(workbookFixture(rows, { strings })), "limit");
  });
  it("accepts large valid base64 without a recursive regexp failure", () => {
    const input = workbookFixture("");
    input.entries.push("unread.xml");
    input.parts.push({
      name: "unread.xml",
      data: xmlBase64(" ".repeat(1024 * 1024)),
    });
    expect(parseWorkbook(input).sheets).toHaveLength(1);
    expect(XLSX_LIMITS.outputText).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});
