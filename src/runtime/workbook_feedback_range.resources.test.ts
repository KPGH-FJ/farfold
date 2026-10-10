import { expect, it } from "vitest";
import {
  analyzeWorkbookFeedbackRange,
  parseWorkbookFeedbackRange,
  workbookFeedbackRangeAnalysisIsCurrent,
} from "./workbook_feedback_range";
import type { WorkbookPreview } from "./xlsx_types";

it("bounds snapshot work by actual metadata, not a full-sheet rectangle's area", () => {
  const preview: WorkbookPreview = {
    date1904: false,
    sheets: [{ id: "actual-relation", name: "bounded", state: "visible" }],
    styles: [],
    warnings: [],
    sheet: {
      id: "actual-relation",
      cells: [],
      rows: Array.from({ length: 100000 }, (_, index) => ({
        index: index + 1,
        hidden: true,
      })),
      columns: Array.from({ length: 16384 }, (_, index) => ({
        min: index + 1,
        max: index + 1,
        hidden: true,
      })),
      merges: Array.from({ length: 4096 }, (_, index) => ({
        fromRow: 1,
        toRow: 2,
        fromColumn: index * 2 + 1,
        toColumn: index * 2 + 2,
      })),
    },
  };
  const range = parseWorkbookFeedbackRange("A1:XFD1048576")!;
  const analysis = analyzeWorkbookFeedbackRange({ preview, range })!;
  expect(workbookFeedbackRangeAnalysisIsCurrent(analysis, preview, range)).toBe(
    true,
  );
  expect(analysis).toMatchObject({
    hiddenRowCount: 100000,
    hiddenColumnCount: 16384,
    partialMerges: [],
  });
  expect(analysis.hiddenRows).toEqual([{ from: 1, to: 100000 }]);
  expect(analysis.hiddenColumns).toEqual([{ from: 1, to: 16384 }]);
  expect(JSON.stringify(analysis).length).toBeLessThan(1000);
});
