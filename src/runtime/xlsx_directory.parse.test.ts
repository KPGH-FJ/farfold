import { expect, it, vi } from "vitest";
import { parseWorkbook } from "./xlsx_parse";
import {
  corruptGlobalStyles,
  firstSheetFailureFixture,
} from "./xlsx_directory.test-support";
import { replacePart } from "./xlsx_fixture";

it("returns the verified directory before the real malformed first-sheet parse fails", () => {
  const input = firstSheetFailureFixture();
  const onDirectory = vi.fn();
  expect(() => parseWorkbook(input, onDirectory)).toThrow("invalid");
  expect(onDirectory).toHaveBeenCalledExactlyOnceWith({
    sheets: [
      { id: "sheet1", name: "样本", state: "visible" },
      { id: "sheet2", name: "Good second sheet", state: "visible" },
    ],
    selectedId: "sheet1",
  });
});

it("the same authored package already contains a fully readable second sheet", () => {
  const result = parseWorkbook({
    ...firstSheetFailureFixture(),
    sheetId: "sheet2",
  });
  expect(result.sheet?.id).toBe("sheet2");
  expect(result.sheet?.cells[0]).toMatchObject({
    reference: "A1",
    value: 42,
    display: "42",
  });
  expect(result.sheets).toHaveLength(2);
});

it.each(["styles", "directory", "relations", "selection"])(
  "does not publish a directory before invalid global %s or selection is rejected",
  (failure) => {
    let input = firstSheetFailureFixture();
    if (failure === "styles") input = corruptGlobalStyles(input);
    if (failure === "directory")
      input = replacePart(input, "xl/workbook.xml", (xml) =>
        xml.replace('r:id="sheet2"', 'r:id="sheet1"'),
      );
    if (failure === "relations")
      input = replacePart(input, "xl/_rels/workbook.xml.rels", (xml) =>
        xml.replace("worksheets/sheet2.xml", "../outside.xml"),
      );
    if (failure === "selection") input = { ...input, sheetId: "absent" };
    const onDirectory = vi.fn();
    expect(() => parseWorkbook(input, onDirectory)).toThrow();
    expect(onDirectory).not.toHaveBeenCalled();
  },
);

it("does not let a directory consumer mutate the actual parsed directory", () => {
  const input = { ...firstSheetFailureFixture(), sheetId: "sheet2" };
  const result = parseWorkbook(input, (directory) => {
    directory.sheets[0].name = "Untrusted callback mutation";
    directory.sheets.length = 0;
  });
  expect(result.sheets).toHaveLength(2);
  expect(result.sheets[0].name).toBe("样本");
});
