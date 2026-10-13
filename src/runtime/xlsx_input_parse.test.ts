import { describe, expect, it } from "vitest";
import {
  inputZipFixture,
  inputOracle,
} from "./xlsx_input_fixture.test-support";
import { parseWorkbookInput } from "./xlsx_input_parse";
import { checkedXlsxInputResult } from "./xlsx_input_validation";
import { xlsxInputText } from "./xlsx_input_text";
import { parseWorkbook } from "./xlsx_parse";
import { workbookFixture, replacePart } from "./xlsx_fixture";
import type { XlsxInputScopeMode, XlsxInputResult } from "./xlsx_input_types";

const parsed = (
  id: string,
  mode: XlsxInputScopeMode = "visible-saved-cells",
) => {
  const capture = inputZipFixture(id),
    request = { mode };
  return checkedXlsxInputResult(
    parseWorkbookInput(capture, request),
    capture,
    request,
  );
};
const cell = (r: XlsxInputResult, sheet: number, address: string) =>
  r.selectedSheets[sheet].cells.find((c) => c.reference === address)!;
describe("XLSX actual ZIP, independently authored content and whole scope", () => {
  it("preserves every original raw value, actual formula attributes and authored rich text in all 25 records", () => {
    const r = parsed("01-values-scope", "all-saved-cells"),
      oracle = inputOracle.fixtures[0];
    expect(r.sheets).toEqual(
      oracle.sheetOrder.map(
        (s: { id: string; name: string; state: string }) => ({
          id: s.id,
          name: s.name,
          state: s.state,
        }),
      ),
    );
    expect(r.selectedSheets.flatMap((s) => s.cells)).toHaveLength(
      oracle.allSavedRecordCount,
    );
    for (const expected of oracle.cells) {
      const index = r.sheets.findIndex((s) => s.name === expected.sheet),
        c = cell(r, index, expected.address);
      expect(c.type).toBe(expected.t ?? "n");
      expect(c.rawValue).toBe(expected.vPresent ? expected.vText : null);
      expect(c.text).toBe(
        expected.authorText ??
          expected.isText ??
          (expected.t === "str" ? expected.vText : null),
      );
      expect(c.formula).toEqual(
        expected.fPresent
          ? {
              text: expected.fText,
              attributes: expected.fAttrs,
              included: true,
            }
          : null,
      );
      if (expected.isRuns) expect(c.runs).toEqual(expected.isRuns);
      expect(c.included).toBe(true);
    }
    expect(cell(r, 0, "G1")).toMatchObject({
      rawValue: "9007199254740993",
      display: null,
      displayKnown: false,
    });
    const text = xlsxInputText(r).text;
    expect(text).toContain("9007199254740993");
    expect(text).not.toContain("9007199254740992");
    expect(text).toContain("END_TAIL");
    expect(text).toContain("FAR_CORNER");
    expect(text).not.toContain('"address":"B8"');
    expect(text).not.toContain("B2+1");
    expect(cell(r, 0, "D1")).toMatchObject({ type: "b", rawValue: "0" });
    expect(cell(r, 0, "E1")).toMatchObject({ rawValue: "", text: "" });
    expect(cell(r, 0, "F1")).toMatchObject({ rawValue: null, text: null });
    expect(cell(r, 0, "B4").cacheState).toBe("missing");
    expect(cell(r, 0, "C4").cacheState).toBe("present");
  });
  it("default includes both visible sheets; hidden C4 also remains omitted by the original hidden-column rule", () => {
    const r = parsed("01-values-scope"),
      text = xlsxInputText(r).text;
    expect(r.scope.sheetIds).toEqual(["rId1", "rId2"]);
    expect(
      r.selectedSheets.flatMap((s) => s.cells).filter((c) => c.included),
    ).toHaveLength(20);
    // Original oracle's 21 omitted C4 despite column C being hidden. This test
    // derives the correction from authored XML/policy, never changes the oracle.
    expect(cell(r, 0, "C4")).toMatchObject({
      visibility: "hidden",
      included: false,
      cacheState: "present",
    });
    expect(r.warnings).toContainEqual({ code: "hiddenCellsOmitted", count: 5 });
    for (const hidden of [
      "HIDDEN_COLUMN",
      "HIDDEN_ROW",
      "HIDDEN_SHEET",
      "VERY_HIDDEN_SHEET",
      '"name":"Hidden"',
      '"name":"VeryHidden"',
    ])
      expect(text).not.toContain(hidden);
    expect(text).toContain("END_TAIL");
    expect(text).toContain("FAR_CORNER");
    expect(cell(r, 0, "E1").included).toBe(true);
  });
  it("withholds protected formula text only, retains visible caches/grid text, and all-saved exposes exactly the explicit hidden choice", () => {
    const visible = parsed("02-protection-format"),
      all = parsed("02-protection-format", "all-saved-cells");
    expect(
      visible.selectedSheets.flatMap((s) => s.cells).filter((c) => c.included),
    ).toHaveLength(inputOracle.fixtures[1].defaultExpectedRecordCount);
    expect(cell(visible, 0, "A1")).toMatchObject({
      included: true,
      rawValue: "7",
      formula: { text: "3+4", included: false },
    });
    expect(cell(visible, 0, "A2")).toMatchObject({
      rawValue: null,
      cacheState: "missing",
      formula: { included: false },
    });
    expect(cell(visible, 0, "D1").included).toBe(true);
    expect(cell(visible, 1, "A1").formula?.included).toBe(true);
    expect(visible.warnings).toContainEqual({
      code: "hiddenFormulasOmitted",
      count: 2,
    });
    expect(xlsxInputText(visible).text).toContain("VISIBLE_GRID_SECRET");
    expect(xlsxInputText(visible).text).not.toContain("HIDDEN_BY_FORMAT");
    expect(
      all.selectedSheets.flatMap((s) => s.cells).filter((c) => c.included),
    ).toHaveLength(7);
    expect(xlsxInputText(all).text).toContain("HIDDEN_BY_FORMAT");
    expect(cell(all, 0, "A1").formula?.included).toBe(true);
  });
  it("keeps useful local cells with explicit unknown/unread states; never claims shapes, names, remote content or conditional results read", () => {
    const visible = parsed("03-unread-surfaces"),
      all = parsed("03-unread-surfaces", "all-saved-cells");
    expect(visible.partial).toBe(true);
    expect(all.partial).toBe(true);
    expect(cell(visible, 0, "A2")).toMatchObject({
      visibility: "unknown",
      included: false,
      rawValue: "10",
    });
    expect(cell(visible, 0, "B6")).toMatchObject({
      covered: true,
      included: false,
    });
    expect(cell(all, 0, "B6")).toMatchObject({
      covered: true,
      included: true,
      text: "COVERED_SAVED_VALUE",
    });
    expect(visible.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining([
        "unknownVisibility",
        "coveredMergeData",
        "conditionalFormatting",
        "definedNames",
        "drawings",
        "images",
        "externalContent",
      ]),
    );
    expect(visible.warnings).toContainEqual({ code: "definedNames", count: 2 });
    const text = xlsxInputText(visible).text;
    expect(text).toContain("LOCAL_CELL_WORDS");
    for (const absent of [
      "DRAWING_ONLY_WORDS",
      "REMOTE_CACHED_ONLY",
      "https://example.invalid",
      "VisibleName",
      "HiddenName",
      "COVERED_SAVED_VALUE",
    ])
      expect(text).not.toContain(absent);
  });
  it("fails atomically on invalid second sheet, although old single-sheet preview legitimately still reads the first", () => {
    const input = inputZipFixture("04-invalid-late-sheet");
    expect(parseWorkbook(input).sheet?.cells[0].value).toBe("FIRST_SHEET_OK");
    expect(() =>
      parseWorkbookInput(input, { mode: "visible-saved-cells" }),
    ).toThrowError("invalid");
    expect(() =>
      parseWorkbookInput(input, { mode: "all-saved-cells" }),
    ).toThrowError("invalid");
  });
  it("rejects total final UTF8 overflow instead of accepting a first-sheet prefix", () => {
    const r = parsed("05-text-budget");
    expect(r.selectedSheets.flatMap((s) => s.cells)).toHaveLength(10);
    expect(
      r.selectedSheets
        .flatMap((s) => s.cells)
        .reduce((n, c) => n + new TextEncoder().encode(c.text!).length, 0),
    ).toBe(inputOracle.fixtures[4].budgetPattern.allAuthorTextUtf8Bytes);
    try {
      xlsxInputText(r);
      throw new Error("unexpected success");
    } catch (error) {
      expect(error).toMatchObject({ code: "textLimit" });
    }
  });
  it("does not fallback to the first hidden sheet when default scope is empty", () => {
    const input = replacePart(
      workbookFixture('<row><c t="inlineStr"><is><t>SECRET</t></is></c></row>'),
      "xl/workbook.xml",
      (x) => x.replace('r:id="sheet1"', 'r:id="sheet1" state="hidden"'),
    );
    expect(parseWorkbook(input).sheet).not.toBeNull();
    expect(() =>
      parseWorkbookInput(input, { mode: "visible-saved-cells" }),
    ).toThrowError("scopeEmpty");
    expect(
      xlsxInputText(parseWorkbookInput(input, { mode: "all-saved-cells" }))
        .text,
    ).toContain("SECRET");
  });
});
