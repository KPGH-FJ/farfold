import { describe, expect, it } from "vitest";
import { formatXlsxValue as show } from "./xlsx_format";

describe("typed spreadsheet display", () => {
  it("applies numeric precision, percent, grouping, fractions and scientific formats", () => {
    expect(show(0.12, "0.00%", false).display).toBe("12.00%");
    expect(show(1234.5, "#,##0.00", false).display).toBe("1,234.50");
    expect(show(1.5, "# ?/?", false).display).toBe("1 1/2");
    expect(show(1234.5, "0.00E+00", false).display).toBe("1.23E+03");
  });
  it("preserves Excel's calendar and elapsed duration without local Date conversion", () => {
    expect(
      [59, 60, 61].map((n) => show(n, "yyyy-mm-dd", false).display),
    ).toEqual(["1900-02-28", "1900-02-29", "1900-03-01"]);
    expect(show(0, "yyyy-mm-dd", true).display).toBe("1904-01-01");
    expect(show(1.5, "[h]:mm", false).display).toBe("36:00");
  });
  it("does not conflate zero, false, empty cache and number-looking text", () => {
    expect(show(0, "0.00", false).display).toBe("0.00");
    expect(show(false, "yyyy-mm-dd", false).display).toBe("FALSE");
    expect(show("", "0.00", false).display).toBe("");
    expect(show("0012", "0.00", false).display).toBe("0012");
  });
  it("reports unsupported locale codes and unknown bracket directives instead of General", () => {
    expect(show(60, "[$-804]yyyy年m月d日", false)).toEqual({
      display: null,
      issue: "unsupportedFormat",
    });
    expect(show(2, "[unrecognized]0.00", false)).toEqual({
      display: null,
      issue: "unsupportedFormat",
    });
    expect(show(-1, "yyyy-mm-dd", false)).toEqual({
      display: null,
      issue: "dateRange",
    });
  });
  it("carries supported color sections and flags width-dependent spacing", () => {
    expect(show(-10, "0.00;[Red](0.00)", false)).toEqual({
      display: "(10.00)",
      color: "#FF0000",
    });
    expect(show(10, "_($* #,##0.00_)", false).issue).toBe(
      "widthDependentFormat",
    );
  });
  it("uses spreadsheet bright green rather than the CSS green keyword", () => {
    expect(show(2, "[Green]0", false)).toEqual({
      display: "2",
      color: "#00FF00",
    });
  });
});
