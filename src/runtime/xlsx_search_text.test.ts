import { describe, expect, it } from "vitest";
import { xlsxSearchText } from "./xlsx_search_text";
import { inputZipFixture } from "./xlsx_input_fixture.test-support";
import { parseWorkbookInput } from "./xlsx_input_parse";
import { checkedXlsxInputResult } from "./xlsx_input_validation";
import {
  searchCell,
  searchWorkbook,
} from "./attachment_search.xlsx.test-support";
import { XLSX_LIMITS } from "./xlsx_types";

function fixture(id: string) {
  const capture = inputZipFixture(id),
    request = { mode: "visible-saved-cells" as const };
  return checkedXlsxInputResult(
    parseWorkbookInput(capture, request),
    capture,
    request,
  );
}
const at = (id: string, reference: string, field = "value") =>
  xlsxSearchText(fixture(id)).segments.filter(
    (s) => s.location.reference === reference && s.location.field === field,
  );

describe("XLSX saved author fields for temporary search", () => {
  it("projects both actual visible sheets including sparse far cells, not wrapper labels", () => {
    const result = xlsxSearchText(fixture("01-values-scope"));
    expect([
      ...new Set(result.segments.map((s) => s.location.sheetId)),
    ]).toEqual(["rId1", "rId2"]);
    expect(result.segments).toContainEqual({
      text: "FAR_CORNER",
      location: {
        kind: "xlsx",
        sheetId: "rId2",
        sheetName: "Tail",
        reference: "XFD1048576",
        row: 1048576,
        column: 16384,
        field: "value",
      },
    });
    const body = result.segments.map((s) => s.text).join("\n");
    for (const absent of [
      "HIDDEN_COLUMN",
      "HIDDEN_ROW",
      "HIDDEN_SHEET",
      "VERY_HIDDEN_SHEET",
      "storedValueElementPresent",
      "rId1",
      "XFD1048576",
      "工作簿单元格内容",
    ])
      expect(body).not.toContain(absent);
  });
  it("keeps precise original numeric, boolean, date and error lexemes", () => {
    expect(at("01-values-scope", "G1")[0].text).toBe("9007199254740993");
    expect(at("01-values-scope", "D1")[0].text).toBe("0");
    expect(at("01-values-scope", "K1")[0].text).toBe("0");
    expect(at("01-values-scope", "L1")[0].text).toBe("2026-10-13T00:00:00Z");
    expect(at("01-values-scope", "H1")[0].text).toBe("#DIV/0!");
  });
  it("uses decoded shared/inline rich text once, retaining author spaces", () => {
    expect(at("01-values-scope", "A1").map((s) => s.text)).toEqual([
      "Shared 零",
      "Shared rich",
    ]);
    expect(at("01-values-scope", "J1")[0].text).toBe(" prefix & suffix ");
    expect(at("01-values-scope", "A3")[0].text).toBe("Inline rich");
  });
  it("separates stored formula/cache, never prepends equals or expands shared followers", () => {
    expect(at("01-values-scope", "A4", "savedCache")[0].text).toBe("0");
    expect(at("01-values-scope", "A4", "formula")[0].text).toBe("1-1");
    expect(at("01-values-scope", "A5", "formula")[0].text).toBe("B1+1");
    expect(at("01-values-scope", "A6", "formula")).toEqual([]);
    expect(at("01-values-scope", "A6", "savedCache")[0].text).toBe("2");
    expect(at("01-values-scope", "B4", "savedCache")).toEqual([]);
    expect(at("01-values-scope", "B4", "formula")[0].text).toBe("1+2");
  });
  it("withholds a protected formula but keeps its legal visible cache", () => {
    const result = xlsxSearchText(fixture("02-protection-format"));
    const protectedA1 = result.segments.filter(
      (s) =>
        s.location.sheetName === "Protected" && s.location.reference === "A1",
    );
    expect(protectedA1.map((s) => [s.text, s.location.field])).toEqual([
      ["7", "savedCache"],
    ]);
    expect(
      result.segments.some(
        (s) => s.location.sheetName === "Unprotected" && s.text === "3+4",
      ),
    ).toBe(true);
    expect(
      result.segments.some((s) =>
        ["HIDDEN_BY_FORMAT", "123.45", "6+1"].includes(s.text),
      ),
    ).toBe(false);
  });
  it("omits unknown visibility and covered merge values, retaining caveats", () => {
    const result = xlsxSearchText(fixture("03-unread-surfaces"));
    expect(result.workbook.partial).toBe(true);
    expect(result.workbook.warnings).toContainEqual({
      code: "coveredMergeData",
      count: 1,
    });
    expect(result.segments.some((s) => s.text === "VISIBLE_MERGE_ANCHOR")).toBe(
      true,
    );
    for (const missing of [
      "COVERED_SAVED_VALUE",
      "10",
      "DRAWING_ONLY_WORDS",
      "REMOTE_CACHED_ONLY",
      "VisibleName",
    ])
      expect(result.segments.some((s) => s.text === missing)).toBe(false);
  });
  it.each([
    "06-hidden-formula-missing",
    "07-hidden-formula-empty",
    "08-hidden-formula-cached",
  ])("never exposes hidden expression/cache from %s", (id) => {
    expect(xlsxSearchText(fixture(id)).segments).toEqual([]);
  });
  it("retains missing, empty and zero distinctions without creating characters", () => {
    const input = searchWorkbook([
      searchCell("", {
        reference: "A1",
        type: "n",
        rawValue: null,
        text: null,
        cacheState: "missing",
        formula: { text: "SUM(A2)", included: true, attributes: {} },
      }),
      searchCell("", {
        reference: "A2",
        type: "str",
        rawValue: "",
        cacheState: "present",
        formula: {
          text: "",
          included: true,
          attributes: { t: "shared", si: "7" },
        },
      }),
      searchCell("", {
        reference: "A3",
        type: "n",
        rawValue: "0",
        text: null,
        cacheState: "present",
        formula: { text: "1-1", included: true, attributes: {} },
      }),
    ]);
    expect(
      xlsxSearchText(input).segments.map((s) => [s.text, s.location.field]),
    ).toEqual([
      ["SUM(A2)", "formula"],
      ["0", "savedCache"],
      ["1-1", "formula"],
    ]);
    expect(input.selectedSheets[0].cells.map((c) => c.rawValue)).toEqual([
      null,
      "",
      "0",
    ]);
  });
  it("counts real UTF-8 and keeps formula, cache, cells and sheets as barriers", () => {
    const input = searchWorkbook([
      searchCell("汉😀e\u0301", {
        type: "str",
        rawValue: "汉😀e\u0301",
        cacheState: "present",
        formula: { text: "SUM(A1)", included: true, attributes: {} },
      }),
      searchCell("separate", { reference: "B1", column: 2 }),
    ]);
    const result = xlsxSearchText(input);
    expect(result.bytes).toBe(10 + 7 + 8);
    expect(result.segments.map((s) => s.text)).toEqual([
      "汉😀e\u0301",
      "SUM(A1)",
      "separate",
    ]);
    expect(
      result.segments.some((s) => s.text.includes("SUM(A1)separate")),
    ).toBe(false);
  });
  it("does not search number-format literals, identifiers, attributes or warning labels", () => {
    const input = searchWorkbook([
      searchCell("", {
        type: "n",
        rawValue: "001.20E+2",
        text: null,
        display: "needle currency",
        formula: {
          text: "SUM(A1)",
          included: true,
          attributes: { ref: "needle", t: "shared" },
        },
        cacheState: "present",
      }),
    ]);
    input.sheets[0].name = "needle sheet";
    const result = xlsxSearchText(input);
    expect(result.segments.map((s) => s.text)).toEqual([
      "001.20E+2",
      "SUM(A1)",
    ]);
  });
  it("copies location and warning ownership without mutating the checked workbook", () => {
    const input = fixture("03-unread-surfaces"),
      before = structuredClone(input);
    const result = xlsxSearchText(input);
    expect(input).toEqual(before);
    const name = result.segments[0].location.sheetName;
    input.sheets[0].name = "changed";
    input.warnings[0].count++;
    expect(result.segments[0].location.sheetName).toBe(name);
    expect(result.workbook.warnings).toEqual(before.warnings);
    expect(Object.isFrozen(result.segments[0].location)).toBe(true);
  });
  it("refuses an all-saved projection rather than silently broadening search scope", () => {
    const input = searchWorkbook();
    input.scope.mode = "all-saved-cells";
    expect(() => xlsxSearchText(input)).toThrow("invalid");
  });
  it.each(["\0", "\ud800"])(
    "rejects text that cannot be represented by the search contract: %j",
    (bad) => {
      expect(() => xlsxSearchText(searchWorkbook([searchCell(bad)]))).toThrow(
        "invalid",
      );
    },
  );
  it("bounds output independently of a malformed oversized model", () => {
    expect(() =>
      xlsxSearchText(
        searchWorkbook([searchCell("a".repeat(XLSX_LIMITS.text + 1))]),
      ),
    ).toThrow("limit");
  });
  it("does not salvage a valid first sheet when a later captured sheet is invalid", () => {
    expect(() => fixture("04-invalid-late-sheet")).toThrow();
  });
});

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { WorkbookCapture } from "./xlsx_types";
const independent = new URL("./fixtures/xlsx-search/", import.meta.url);
const independentCaptures = JSON.parse(
  readFileSync(new URL("captures.json", independent), "utf8"),
) as WorkbookCapture[];
const independentOracle = JSON.parse(
  readFileSync(new URL("oracle.json", independent), "utf8"),
) as {
  cases: {
    file: string;
    expectedError?: string;
    segments: {
      sheetId: string;
      reference: string;
      field: string;
      text: string;
    }[];
    searchableUtf8Bytes: number;
    expectedPartial?: boolean;
    queries?: { query: string; expectedOccurrences: number }[];
  }[];
};
for (const expected of independentOracle.cases) {
  it(`matches independently authored ${expected.file} fields and bytes without decoding twice`, () => {
    const capture = independentCaptures.find(
      (c) => c.file.name === expected.file,
    )!;
    const bytes = readFileSync(new URL(expected.file, independent));
    expect(bytes.length).toBe(capture.file.size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      capture.file.sha256,
    );
    const request = { mode: "visible-saved-cells" as const };
    const parse = () =>
      checkedXlsxInputResult(
        parseWorkbookInput(capture, request),
        capture,
        request,
      );
    if (expected.expectedError) {
      expect(parse).toThrow(expected.expectedError);
      return;
    }
    const result = xlsxSearchText(parse());
    const key = (s: {
      sheetId: string;
      reference: string;
      field: string;
      text: string;
    }) => JSON.stringify(s);
    const actual = result.segments.map(
      ({ text, location: { sheetId, reference, field } }) => ({
        sheetId,
        reference,
        field,
        text,
      }),
    );
    expect(actual.map(key).sort()).toEqual(expected.segments.map(key).sort());
    expect(result.bytes).toBe(expected.searchableUtf8Bytes);
    expect(result.workbook.partial).toBe(expected.expectedPartial);
    for (const query of expected.queries ?? []) {
      const regex = new RegExp(
        query.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "giu",
      );
      expect(
        result.segments.reduce(
          (n, s) => n + [...s.text.matchAll(regex)].length,
          0,
        ),
        query.query,
      ).toBe(query.expectedOccurrences);
    }
  });
}
it.each(["different", "duplicate", "absent"])(
  "refuses selected-sheet membership drift: %s",
  (kind) => {
    const result = searchWorkbook();
    if (kind === "different") result.scope.sheetIds[0] = "other";
    else if (kind === "duplicate") {
      result.scope.sheetIds.push("sheet1");
      result.selectedSheets.push(result.selectedSheets[0]);
    } else result.scope.sheetIds = [];
    expect(() => xlsxSearchText(result)).toThrow("invalid");
  },
);
