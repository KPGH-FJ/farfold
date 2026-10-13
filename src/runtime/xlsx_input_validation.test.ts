import { describe, expect, it } from "vitest";
import { inputZipFixture } from "./xlsx_input_fixture.test-support";
import { parseWorkbookInput } from "./xlsx_input_parse";
import {
  checkedXlsxInputResult,
  checkedXlsxInputScope,
  checkedXlsxInputWarnings,
} from "./xlsx_input_validation";
import type { XlsxInputResult } from "./xlsx_input_types";
describe("XLSX complete-input closed Worker results and preserved source scope", () => {
  const capture = inputZipFixture("01-values-scope"),
    request = { mode: "all-saved-cells" as const };
  const original = () => structuredClone(parseWorkbookInput(capture, request));
  it.each([
    [
      "missing selected sheet",
      (r: XlsxInputResult) => {
        r.selectedSheets.pop();
      },
    ],
    [
      "wrong scope order",
      (r: XlsxInputResult) => {
        r.scope.sheetIds.reverse();
      },
    ],
    [
      "duplicate selected sheet",
      (r: XlsxInputResult) => {
        r.selectedSheets[1] = r.selectedSheets[0];
      },
    ],
    [
      "catalog omitted hidden sheet",
      (r: XlsxInputResult) => {
        r.sheets.pop();
        r.scope.sheetIds.pop();
        r.selectedSheets.pop();
      },
    ],
    [
      "made hidden sheet visible",
      (r: XlsxInputResult) => {
        r.sheets[2].state = "visible";
      },
    ],
    [
      "unknown deep key",
      (r: XlsxInputResult) => {
        Object.assign(r.selectedSheets[0].cells[0], { guessedText: "fake" });
      },
    ],
    [
      "wrong address",
      (r: XlsxInputResult) => {
        r.selectedSheets[0].cells[0].row = 2;
      },
    ],
    [
      "duplicate address",
      (r: XlsxInputResult) => {
        r.selectedSheets[0].cells.push(r.selectedSheets[0].cells[0]);
      },
    ],
    [
      "wrong cache state",
      (r: XlsxInputResult) => {
        r.selectedSheets[0].cells.find(
          (c) => c.reference === "B4",
        )!.cacheState = "present";
      },
    ],
    [
      "string SST index used as text runs",
      (r: XlsxInputResult) => {
        r.selectedSheets[1].cells[0].runs = ["1"];
      },
    ],
    [
      "false blank represented as missing",
      (r: XlsxInputResult) => {
        r.selectedSheets[0].cells.find((c) => c.reference === "E1")!.text =
          null;
      },
    ],
    [
      "invalid Boolean source",
      (r: XlsxInputResult) => {
        r.selectedSheets[0].cells.find((c) => c.reference === "D1")!.rawValue =
          "2";
      },
    ],
    [
      "invented covered merge",
      (r: XlsxInputResult) => {
        r.selectedSheets[0].cells[0].covered = true;
      },
    ],
    [
      "unpaired surrogate",
      (r: XlsxInputResult) => {
        r.selectedSheets[0].cells[0].text = "\ud800";
      },
    ],
    [
      "unknown warning",
      (r: XlsxInputResult) => {
        Object.assign(r.warnings[0], { code: "allFine" });
      },
    ],
    [
      "zero warning",
      (r: XlsxInputResult) => {
        r.warnings[0].count = 0;
      },
    ],
    [
      "partial discarded",
      (r: XlsxInputResult) => {
        r.partial = false;
      },
    ],
    [
      "known cache warnings removed",
      (r: XlsxInputResult) => {
        r.warnings = r.warnings.filter(
          (w) => w.code !== "missingFormulaCaches",
        );
      },
    ],
    [
      "all-saved formula silently omitted",
      (r: XlsxInputResult) => {
        r.selectedSheets[0].cells.find(
          (c) => c.reference === "A4",
        )!.formula!.included = false;
      },
    ],
  ] as const)("rejects %s", (_label, change) => {
    const r = original();
    change(r);
    expect(() => checkedXlsxInputResult(r, capture, request)).toThrowError(
      "invalid",
    );
  });
  it("rejects an otherwise valid result for a different explicit range request", () => {
    expect(() =>
      checkedXlsxInputResult(original(), capture, {
        mode: "visible-saved-cells",
      }),
    ).toThrowError("invalid");
  });
  it.each([
    { mode: "all-saved-cells", sheetIds: [] },
    { mode: "all-saved-cells", sheetIds: ["rId1", "rId1"] },
    { mode: "all-saved-cells", sheetIds: ["rId1"], truncation: true },
    { mode: "preview-sheet", sheetIds: ["rId1"] },
  ])(
    "strict metadata scope rejects malformed shape without inventing source authority",
    (value) => {
      expect(() => checkedXlsxInputScope(value)).toThrowError("invalid");
    },
  );
  it("metadata warnings have closed order, positive counts and declared unit bounds", () => {
    expect(() =>
      checkedXlsxInputWarnings([{ code: "externalContent", count: 2 }]),
    ).toThrowError("invalid");
    expect(() =>
      checkedXlsxInputWarnings([{ code: "drawings", count: 2049 }]),
    ).toThrowError("invalid");
    expect(() =>
      checkedXlsxInputWarnings([
        { code: "images", count: 1 },
        { code: "drawings", count: 1 },
      ]),
    ).toThrowError("invalid");
    expect(() =>
      checkedXlsxInputWarnings([
        { code: "images", count: 1 },
        { code: "images", count: 1 },
      ]),
    ).toThrowError("invalid");
    expect(
      checkedXlsxInputWarnings([
        { code: "externalContent", count: 1 },
        { code: "unsupportedAssets", count: 2 },
      ]),
    ).toHaveLength(2);
  });
});
