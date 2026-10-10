import type {
  DocxBlock,
  DocxParagraph,
  DocxPreview,
  DocxStory,
  DocxTable,
} from "./docx_types";
import type { VerifiedFile } from "./file_delivery";
import type { WorkbookPreview } from "./xlsx_types";
import { sheetExtent } from "./workbook_view";
import { DOCUMENT_WINDOW, paragraphParts } from "./document_view";
import { MAX_PDF_PAGES } from "./visual_preview";

interface FilePosition {
  root: string;
  resolvedPath: string;
}
export type PreviewReadingPosition = FilePosition &
  (
    | { kind: "pdf"; page: number }
    | { kind: "text"; blockIndex: number }
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
  documentWindows?: FilePosition & {
    positions: Map<string, DocumentBlockPosition>;
  };
}

type DocumentBlockPosition =
  | { kind: "paragraph"; part: number }
  | { kind: "table"; row: number; column: number };
export const DOCUMENT_READING_WINDOW_LIMIT = 128;
const documentReadingOwners = new WeakMap<PreviewReadingPositionRef, object>();
const blockPositionKey = (block: DocxParagraph | DocxTable) =>
  JSON.stringify([block.source.part, block.source.elementPath]);
const windowStart = (value: number, count: number, size: number) =>
  Math.floor(clamp(value, 0, Math.max(0, count - 1)) / size) * size;

/** Bounded, transient viewport coordinates only. A source path is a reading
 * location, never proof that a new revision contains the same semantic block.
 * New previews reconcile actual paths/types and clamp against their own bounds. */
export class DocumentReadingWindows {
  private readonly positions = new Map<string, DocumentBlockPosition>();
  private readonly blocks = new WeakSet<DocxParagraph | DocxTable>();
  private readonly owner = {};
  private active = false;

  constructor(
    private readonly document: DocxPreview,
    private readonly ref?: PreviewReadingPositionRef,
  ) {
    const previous = ref?.documentWindows;
    const saved =
      previous && sameReadingFile(previous, document.file)
        ? new Map([...previous.positions].slice(-DOCUMENT_READING_WINDOW_LIMIT))
        : new Map<string, DocumentBlockPosition>();
    const visit = (blocks: DocxBlock[]) => {
      for (const block of blocks) {
        if (block.kind === "notice") continue;
        this.blocks.add(block);
        const old = saved.get(blockPositionKey(block));
        if (old?.kind === block.kind)
          this.positions.set(blockPositionKey(block), this.clamped(block, old));
        if (block.kind === "table")
          for (const row of block.rows)
            for (const cell of row.cells) visit(cell.blocks);
      }
    };
    visit(document.blocks);
    for (const story of document.stories) visit(story.blocks);
  }

  activate(): () => void {
    this.active = true;
    if (this.ref) {
      documentReadingOwners.set(this.ref, this.owner);
      this.ref.documentWindows = {
        root: this.document.file.root,
        resolvedPath: this.document.file.resolvedPath,
        positions: this.positions,
      };
    }
    return () => {
      this.active = false;
      if (this.ref && documentReadingOwners.get(this.ref) === this.owner)
        documentReadingOwners.delete(this.ref);
    };
  }

  paragraph(block: DocxParagraph): number {
    const p = this.positions.get(blockPositionKey(block));
    return p?.kind === "paragraph" ? p.part : 0;
  }

  table(block: DocxTable): { row: number; column: number } {
    const p = this.positions.get(blockPositionKey(block));
    return p?.kind === "table" ? p : { row: 0, column: 0 };
  }

  save(
    block: DocxParagraph | DocxTable,
    position: DocumentBlockPosition,
  ): void {
    if (
      !this.active ||
      !this.blocks.has(block) ||
      position.kind !== block.kind ||
      (this.ref && documentReadingOwners.get(this.ref) !== this.owner)
    )
      return;
    const key = blockPositionKey(block);
    this.positions.delete(key);
    this.positions.set(key, this.clamped(block, position));
    if (this.positions.size > DOCUMENT_READING_WINDOW_LIMIT)
      this.positions.delete(this.positions.keys().next().value!);
  }

  private clamped(
    block: DocxParagraph | DocxTable,
    position: DocumentBlockPosition,
  ): DocumentBlockPosition {
    if (block.kind === "paragraph" && position.kind === "paragraph")
      return {
        kind: "paragraph",
        part: clamp(position.part, 0, paragraphParts(block.runs).length - 1),
      };
    if (block.kind === "table" && position.kind === "table") {
      const columns = block.rows.reduce(
        (n, row) =>
          row.cells.reduce(
            (m, cell) => Math.max(m, cell.column + cell.columnSpan),
            n,
          ),
        block.columnsPt.length,
      );
      return {
        kind: "table",
        row: windowStart(position.row, block.rows.length, DOCUMENT_WINDOW.rows),
        column: windowStart(position.column, columns, DOCUMENT_WINDOW.columns),
      };
    }
    return block.kind === "paragraph"
      ? { kind: "paragraph", part: 0 }
      : { kind: "table", row: 0, column: 0 };
  }
}
export function sameReadingFile(
  position: FilePosition | null | undefined,
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
export function restoredTextBlock(
  file: VerifiedFile,
  ref?: PreviewReadingPositionRef,
): number {
  const p = ref?.current;
  return p?.kind === "text" &&
    sameReadingFile(p, file) &&
    Number.isSafeInteger(p.blockIndex) &&
    p.blockIndex >= 0
    ? p.blockIndex
    : 0;
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
        Extract<PreviewReadingPosition, { kind: "text" }>,
        keyof FilePosition
      >
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
