import { expect, it, vi } from "vitest";
import { parseWorkbook } from "./xlsx_parse";
import { checkedWorkbookDirectory } from "./xlsx_directory";
import { replacePart } from "./xlsx_fixture";
import {
  corruptGlobalStyles,
  firstSheetFailureFixture,
} from "./xlsx_directory.test-support";
import type { WorkbookSheetRestore } from "./xlsx_types";

const restore: WorkbookSheetRestore = {
  id: "sheet2",
  name: "Good second sheet",
};

it("resolves a renamed ID by its original name against the new directory", () => {
  let input = replacePart(
    firstSheetFailureFixture(),
    "xl/workbook.xml",
    (xml) => xml.replace('r:id="sheet2"', 'r:id="new-id"'),
  );
  input = replacePart(input, "xl/_rels/workbook.xml.rels", (xml) =>
    xml.replace('Id="sheet2"', 'Id="new-id"'),
  );
  const directory = vi.fn();
  const preview = parseWorkbook({ ...input, restoreSheet: restore }, directory);
  expect(preview.sheet?.id).toBe("new-id");
  expect(preview.sheet?.cells[0].value).toBe(42);
  expect(
    checkedWorkbookDirectory(directory.mock.calls[0][0], undefined, restore)
      .selectedId,
  ).toBe("new-id");
});

it("does not borrow a recycled ID with a different name", () => {
  const input = {
    ...firstSheetFailureFixture(),
    restoreSheet: { ...restore, name: "Not in this revision" },
  };
  const directory = vi.fn();
  expect(() => parseWorkbook(input, directory)).toThrow("invalid");
  expect(directory.mock.calls[0][0].selectedId).toBe("sheet1");
});

it.each([undefined, false, true])(
  "requires the saved explicit choice to restore a hidden sheet (%s)",
  (hiddenSelected) => {
    const input = replacePart(
      firstSheetFailureFixture(),
      "xl/workbook.xml",
      (xml) => xml.replace('sheetId="2"', 'sheetId="2" state="hidden"'),
    );
    const hint = {
      ...restore,
      ...(hiddenSelected === undefined ? {} : { hiddenSelected }),
    };
    if (hiddenSelected) {
      expect(parseWorkbook({ ...input, restoreSheet: hint }).sheet?.id).toBe(
        "sheet2",
      );
    } else {
      expect(() => parseWorkbook({ ...input, restoreSheet: hint })).toThrow(
        "invalid",
      );
    }
  },
);

it("keeps an explicit selection ahead of a conflicting reading location", () => {
  expect(() =>
    parseWorkbook({
      ...firstSheetFailureFixture(),
      sheetId: "sheet1",
      restoreSheet: restore,
    }),
  ).toThrow("invalid");
  expect(
    parseWorkbook({
      ...firstSheetFailureFixture(),
      sheetId: "sheet2",
      restoreSheet: { id: "sheet1", name: "样本" },
    }).sheet?.id,
  ).toBe("sheet2");
});

it.each([
  null,
  { id: "sheet2" },
  { ...restore, extra: true },
  { ...restore, hiddenSelected: "true" },
  { ...restore, id: 2 },
])(
  "refuses a malformed reading hint before publishing directory: %j",
  (hint) => {
    const directory = vi.fn();
    expect(() =>
      parseWorkbook(
        {
          ...firstSheetFailureFixture(),
          restoreSheet: hint as WorkbookSheetRestore,
        },
        directory,
      ),
    ).toThrow("invalid");
    expect(directory).not.toHaveBeenCalled();
  },
);

it("cannot use a saved sheet to bypass failed global validation", () => {
  const directory = vi.fn();
  expect(() =>
    parseWorkbook(
      {
        ...corruptGlobalStyles(firstSheetFailureFixture()),
        restoreSheet: restore,
      },
      directory,
    ),
  ).toThrow("invalid");
  expect(directory).not.toHaveBeenCalled();
});
