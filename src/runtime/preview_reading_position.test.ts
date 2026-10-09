import { expect, it } from "vitest";
import type { VerifiedFile } from "./file_delivery";
import type { WorkbookPreview } from "./xlsx_types";
import type { DocxPreview } from "./docx_types";
import {
  restoredPdfPage,
  restoredWorkbookSheet,
  restoredWorkbookWindow,
  restoredDocumentPosition,
  type PreviewReadingPositionRef,
} from "./preview_reading_position";
const file: VerifiedFile = {
  root: "/work",
  path: "/work/a",
  resolvedPath: "/work/a",
  name: "a",
  size: 1,
  version: "1",
  sha256: "h",
};
it("never carries a location across roots, resolved paths, or preview formats", () => {
  const position: PreviewReadingPositionRef = {
    current: { root: "/work", resolvedPath: "/work/a", kind: "pdf", page: 9 },
  };
  expect(restoredPdfPage(file, position)).toBe(9);
  expect(restoredPdfPage({ ...file, root: "/other" }, position)).toBe(1);
  expect(restoredPdfPage({ ...file, resolvedPath: "/work/b" }, position)).toBe(
    1,
  );
  expect(
    restoredDocumentPosition(
      { file, blocks: [], stories: [] } as unknown as DocxPreview,
      position,
    ),
  ).toEqual({ story: null, segment: 0 });
  position.current = { ...position.current!, kind: "pdf", page: NaN };
  expect(restoredPdfPage(file, position)).toBe(1);
});
it("matches an unchanged sheet name after ID renumbering but never a reused ID with different content identity", () => {
  const workbook = {
    sheets: [
      { id: "2", name: "Other", state: "visible" },
      { id: "7", name: "Saved", state: "visible" },
    ],
    sheet: { id: "7", cells: [], rows: [], columns: [], merges: [] },
  } as unknown as WorkbookPreview;
  const position: PreviewReadingPositionRef = {
    current: {
      root: file.root,
      resolvedPath: file.resolvedPath,
      kind: "workbook",
      sheet: { id: "2", name: "Saved" },
      row: 500,
      column: 88,
      showHidden: true,
    },
  };
  expect(restoredWorkbookSheet(file, workbook, position)).toBe("7");
  expect(restoredWorkbookWindow(file, workbook, position)).toEqual({
    row: 1,
    column: 1,
    showHidden: true,
  });
  workbook.sheets.pop();
  expect(restoredWorkbookSheet(file, workbook, position)).toBeUndefined();
  expect(restoredWorkbookWindow(file, workbook, position)).toEqual({
    row: 1,
    column: 1,
    showHidden: false,
  });
});
it("never treats a reused story ID of another kind or note ID as the old location", () => {
  const position: PreviewReadingPositionRef = {
    current: {
      root: file.root,
      resolvedPath: file.resolvedPath,
      kind: "document",
      story: { id: "n", kind: "footnote", noteId: "3" },
      segment: 2,
    },
  };
  const document = {
    file,
    blocks: [],
    stories: [{ id: "n", kind: "endnote", noteId: "3", blocks: [] }],
  } as unknown as DocxPreview;
  expect(restoredDocumentPosition(document, position)).toEqual({
    story: null,
    segment: 0,
  });
  document.stories[0] = { id: "n", kind: "footnote", noteId: "4", blocks: [] };
  expect(restoredDocumentPosition(document, position)).toEqual({
    story: null,
    segment: 0,
  });
});

it("does not auto-open a sheet newly hidden by a revision without explicit hidden selection", () => {
  const workbook = {
    sheets: [{ id: "2", name: "Saved", state: "hidden" }],
    sheet: { id: "2", cells: [], rows: [], columns: [], merges: [] },
  } as unknown as WorkbookPreview;
  const position: PreviewReadingPositionRef = {
    current: {
      root: file.root,
      resolvedPath: file.resolvedPath,
      kind: "workbook",
      sheet: { id: "2", name: "Saved" },
      row: 9,
      column: 4,
      showHidden: true,
    },
  };
  expect(restoredWorkbookSheet(file, workbook, position)).toBeUndefined();
  if (position.current?.kind === "workbook")
    position.current.sheet = {
      ...position.current.sheet,
      hiddenSelected: true,
    };
  expect(restoredWorkbookSheet(file, workbook, position)).toBe("2");
  workbook.sheets[0].name = "Reused";
  expect(restoredWorkbookSheet(file, workbook, position)).toBeUndefined();
});
