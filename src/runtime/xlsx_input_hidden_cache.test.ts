import { describe, expect, it } from "vitest";
import { inputZipFixture } from "./xlsx_input_fixture.test-support";
import { replacePart } from "./xlsx_fixture";
import { parseWorkbookInput } from "./xlsx_input_parse";
import { checkedXlsxInputResult } from "./xlsx_input_validation";
import { xlsxInputText } from "./xlsx_input_text";
import type { XlsxInputScopeMode } from "./xlsx_input_types";
import type { XlsxWorkerInput } from "./xlsx_types";

const marker = "INDEPENDENT_HIDDEN_FORMULA_MARKER";
const inputs = [
  ["06-hidden-formula-missing", null, "missing"],
  ["07-hidden-formula-empty", "", "missing"],
  ["08-hidden-formula-cached", "1", "present"],
] as const;
function read(
  capture: XlsxWorkerInput,
  mode: XlsxInputScopeMode = "visible-saved-cells",
) {
  const request = { mode };
  const result = checkedXlsxInputResult(
    parseWorkbookInput(capture, request),
    capture,
    request,
  );
  return {
    result,
    cell: result.selectedSheets[0].cells[0],
    converted: xlsxInputText(result),
  };
}
function changedFormat(id: string, format: string) {
  return replacePart(inputZipFixture(id), "xl/styles.xml", (xml) =>
    xml.replace('formatCode=";;;"', `formatCode="${format}"`),
  );
}
describe("independent actual ZIP hidden-format formula without saved result", () => {
  it.each(inputs)(
    "default never serializes hidden formula from %s",
    (id, rawValue, cacheState) => {
      const { result, cell, converted } = read(inputZipFixture(id));
      expect(cell).toMatchObject({
        rawValue,
        cacheState,
        visibility: "hidden",
        included: false,
        formula: { included: false },
      });
      expect(converted.text).not.toContain(marker);
      expect(result.warnings).toContainEqual({
        code: "hiddenCellsOmitted",
        count: 1,
      });
    },
  );
  it.each(inputs)(
    "explicit all scope keeps exact saved formula/cache from %s",
    (id, rawValue, cacheState) => {
      const { cell, converted } = read(inputZipFixture(id), "all-saved-cells");
      expect(cell).toMatchObject({
        rawValue,
        cacheState,
        visibility: "hidden",
        included: true,
        formula: { text: marker + "+1", included: true },
      });
      expect(converted.text).toContain(marker);
      if (cacheState === "missing") {
        expect(cell.display).toBeNull();
        expect(cell.displayKnown).toBe(false);
      }
    },
  );
  it.each(inputs.slice(0, 2))(
    "General does not invent a cache or hide unprotected formula from %s",
    (id, rawValue) => {
      const capture = replacePart(inputZipFixture(id), "xl/styles.xml", (xml) =>
        xml.replace('<xf numFmtId="164"/>', '<xf numFmtId="0"/>'),
      );
      const { result, cell, converted } = read(capture);
      expect(cell).toMatchObject({
        rawValue,
        cacheState: "missing",
        visibility: "visible",
        included: true,
        display: null,
        displayKnown: false,
        formula: { included: true },
      });
      expect(converted.text).toContain(marker);
      expect(result.warnings).toContainEqual({
        code: "missingFormulaCaches",
        count: 1,
      });
    },
  );
  it.each([";;;;", "0", "[Red]0;0"])(
    "missing result leaves value-dependent or unsupported %s visibility unknown",
    (format) => {
      const capture = changedFormat(inputs[0][0], format),
        visible = read(capture),
        all = read(capture, "all-saved-cells");
      expect(visible.cell).toMatchObject({
        cacheState: "missing",
        rawValue: null,
        visibility: "unknown",
        included: false,
        display: null,
        displayKnown: false,
        formula: { included: false },
      });
      expect(visible.converted.text).not.toContain(marker);
      expect(visible.result.warnings).toContainEqual({
        code: "unknownVisibility",
        count: 1,
      });
      expect(all.converted.text).toContain(marker);
      expect(all.cell.rawValue).toBeNull();
    },
  );
  it.each(inputs.slice(0, 2))(
    "protected General formula with %s still withholds only formula text",
    (id, rawValue) => {
      let capture = replacePart(inputZipFixture(id), "xl/styles.xml", (xml) =>
        xml.replace(
          '<xf numFmtId="164"/>',
          '<xf numFmtId="0" applyProtection="1"><protection hidden="1"/></xf>',
        ),
      );
      capture = replacePart(capture, "xl/worksheets/sheet1.xml", (xml) =>
        xml.replace("<sheetData>", '<sheetProtection sheet="1"/><sheetData>'),
      );
      const visible = read(capture),
        all = read(capture, "all-saved-cells");
      expect(visible.cell).toMatchObject({
        rawValue,
        included: true,
        cacheState: "missing",
        formula: { included: false },
      });
      expect(visible.converted.text).not.toContain(marker);
      expect(visible.result.warnings).toContainEqual({
        code: "hiddenFormulasOmitted",
        count: 1,
      });
      expect(all.converted.text).toContain(marker);
    },
  );
  it("cached zero remains hidden and never becomes missing", () => {
    const capture = replacePart(
      inputZipFixture(inputs[2][0]),
      "xl/worksheets/sheet1.xml",
      (xml) => xml.replace("<v>1</v>", "<v>0</v>"),
    );
    const visible = read(capture),
      all = read(capture, "all-saved-cells");
    expect(visible.cell).toMatchObject({
      rawValue: "0",
      cacheState: "present",
      visibility: "hidden",
      included: false,
    });
    expect(visible.converted.text).not.toContain(marker);
    expect(all.cell.rawValue).toBe("0");
  });
  it.each(inputs.slice(0, 2))(
    "ambiguous protection with %s remains unknown and does not expose formula",
    (id) => {
      let capture = replacePart(inputZipFixture(id), "xl/styles.xml", (xml) =>
        xml.replace(
          '<xf numFmtId="164"/>',
          '<xf numFmtId="0"><protection hidden="1"/></xf>',
        ),
      );
      capture = replacePart(capture, "xl/worksheets/sheet1.xml", (xml) =>
        xml.replace("<sheetData>", '<sheetProtection sheet="1"/><sheetData>'),
      );
      const visible = read(capture),
        all = read(capture, "all-saved-cells");
      expect(visible.cell.included).toBe(true);
      expect(visible.cell.formula?.included).toBe(false);
      expect(visible.result.warnings).toContainEqual({
        code: "unknownVisibility",
        count: 1,
      });
      expect(visible.converted.text).not.toContain(marker);
      expect(all.converted.text).toContain(marker);
    },
  );
});
