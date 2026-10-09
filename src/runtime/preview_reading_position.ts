import type { DocxPreview, DocxStory } from "./docx_types";
import type { VerifiedFile } from "./file_delivery";
import type { WorkbookPreview } from "./xlsx_types";
import { sheetExtent } from "./workbook_view";
import { DOCUMENT_WINDOW } from "./document_view";
import { MAX_PDF_PAGES } from "./visual_preview";

interface FilePosition {
  root: string;
  resolvedPath: string;
}
export type PreviewReadingPosition = FilePosition &
  (
    | { kind: "pdf"; page: number }
    | {
        kind: "workbook";
        sheet: { id: string; name: string; hiddenSelected?: boolean };
        row: number;
        column: number;
        showHidden: boolean;
      }
    | {
        kind: "document";
        story: Pick<DocxStory, "id" | "kind" | "noteId"> | null;
        segment: number;
      }
  );
/** Current content-bar reading location only. No content, selection, or feedback. */
export interface PreviewReadingPositionRef {
  current: PreviewReadingPosition | null;
}
export function sameReadingFile(
  position: PreviewReadingPosition | null | undefined,
  file: VerifiedFile,
): boolean {
  return (
    position?.root === file.root && position.resolvedPath === file.resolvedPath
  );
}
const clamp = (value: number, first: number, last: number) =>
  Number.isSafeInteger(value) ? Math.max(first, Math.min(value, last)) : first;
export function restoredPdfPage(
  file: VerifiedFile,
  ref?: PreviewReadingPositionRef,
): number {
  const p = ref?.current;
  return p?.kind === "pdf" && sameReadingFile(p, file)
    ? clamp(p.page, 1, MAX_PDF_PAGES)
    : 1;
}
export function savedWorkbookPosition(
  file: VerifiedFile,
  ref?: PreviewReadingPositionRef,
) {
  const p = ref?.current;
  return p?.kind === "workbook" && sameReadingFile(p, file) ? p : null;
}
export function restoredWorkbookSheet(
  file: VerifiedFile,
  workbook: WorkbookPreview,
  ref?: PreviewReadingPositionRef,
): string | undefined {
  const p = savedWorkbookPosition(file, ref);
  if (!p) return undefined;
  // A recycled ID with another name must not borrow the old sheet's location.
  const sheet =
    workbook.sheets.find(
      (s) => s.id === p.sheet.id && s.name === p.sheet.name,
    ) ?? workbook.sheets.find((s) => s.name === p.sheet.name);
  return sheet && (sheet.state === "visible" || p.sheet.hiddenSelected === true)
    ? sheet.id
    : undefined;
}
export function restoredWorkbookWindow(
  file: VerifiedFile,
  workbook: WorkbookPreview,
  ref?: PreviewReadingPositionRef,
) {
  const p = savedWorkbookPosition(file, ref),
    sheet = workbook.sheet;
  const matches =
    sheet && p && restoredWorkbookSheet(file, workbook, ref) === sheet.id;
  const extent = sheet ? sheetExtent(sheet) : { rows: 1, columns: 1 };
  return {
    row: matches ? clamp(p.row, 1, extent.rows) : 1,
    column: matches ? clamp(p.column, 1, extent.columns) : 1,
    showHidden: Boolean(matches && p.showHidden === true),
  };
}
export function restoredDocumentPosition(
  document: DocxPreview,
  ref?: PreviewReadingPositionRef,
) {
  const p = ref?.current;
  if (p?.kind !== "document" || !sameReadingFile(p, document.file))
    return { story: null, segment: 0 };
  const story = p.story
    ? (document.stories.find(
        (s) =>
          s.id === p.story!.id &&
          s.kind === p.story!.kind &&
          s.noteId === p.story!.noteId,
      ) ?? null)
    : null;
  if (p.story && !story) return { story: null, segment: 0 };
  const count = (story?.blocks ?? document.blocks).length;
  return {
    story,
    segment: clamp(
      p.segment,
      0,
      Math.max(0, Math.ceil(count / DOCUMENT_WINDOW.blocks) - 1),
    ),
  };
}
export function saveReadingPosition(
  ref: PreviewReadingPositionRef | undefined,
  file: VerifiedFile,
  position:
    | Omit<Extract<PreviewReadingPosition, { kind: "pdf" }>, keyof FilePosition>
    | Omit<
        Extract<PreviewReadingPosition, { kind: "workbook" }>,
        keyof FilePosition
      >
    | Omit<
        Extract<PreviewReadingPosition, { kind: "document" }>,
        keyof FilePosition
      >,
): void {
  if (ref)
    ref.current = {
      root: file.root,
      resolvedPath: file.resolvedPath,
      ...position,
    };
}
