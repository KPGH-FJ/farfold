import type { VerifiedFile } from "./file_delivery";
import type { DocxPreview } from "./docx_types";
import {
  XlsxError,
  type WorkbookCapture,
  type WorkbookDirectory,
  type WorkbookPreview,
} from "./xlsx_types";
import { samePreviewFile } from "./preview_capture";
import { readDocxCapture, readDocxPreview } from "./docx_preview";
import { readWorkbookCapture, readWorkbookPreview } from "./xlsx_preview";
import { readPptxCapture, readPptxPreview } from "./pptx_preview";
import type { PptxPreview } from "./pptx_types";
import {
  savedWorkbookPosition,
  type PreviewReadingPositionRef,
} from "./preview_reading_position";

export type PreparedDocxPreview = {
  kind: "docx";
  file: VerifiedFile;
  value: DocxPreview;
};
export type PreparedWorkbookPreview = {
  kind: "workbook";
  file: VerifiedFile;
  capture: WorkbookCapture;
  value: WorkbookPreview;
  selectedSheetId?: string;
};
export type WorkbookRefreshRecovery = {
  capture: WorkbookCapture;
  directory: WorkbookDirectory;
};
export type WorkbookRefreshSelection = {
  capture: WorkbookCapture;
  sheetId: string;
};
export type PreparedOfficePreview =
  PreparedDocxPreview | PreparedWorkbookPreview | PreparedPptxPreview;
export type PreparedPptxPreview = {
  kind: "pptx";
  file: VerifiedFile;
  value: PptxPreview;
};

/** Prepare a replacement snapshot before retiring the visible document. */
export async function prepareOfficePreview(
  file: VerifiedFile,
  readingPosition: PreviewReadingPositionRef,
  parserSignal: AbortSignal,
  valid: () => boolean,
  workbook?: {
    selection?: WorkbookRefreshSelection;
    onRecovery?: (recovery: WorkbookRefreshRecovery) => void;
  },
): Promise<PreparedOfficePreview> {
  const check = () => {
    if (!valid() || parserSignal.aborted) throw { code: "cancelled" };
  };
  check();
  // Hiding cancels presentation/parsing, not the real OS operation. Keep awaiting
  // its bounded reply so readPending cannot be silently discarded and retried.
  const captureSignal = new AbortController().signal;
  if (/\.pptx$/i.test(file.name)) {
    const capture = await readPptxCapture(file, captureSignal);
    check();
    const value = await readPptxPreview(capture, parserSignal);
    check();
    return { kind: "pptx", file, value };
  }
  if (/\.docx$/i.test(file.name)) {
    const capture = await readDocxCapture(file, captureSignal);
    check();
    const value = await readDocxPreview(capture, parserSignal);
    check();
    return { kind: "docx", file, value };
  }
  if (!/\.xlsx$/i.test(file.name)) throw { code: "unsupported" };
  const capture =
    workbook?.selection?.capture ??
    (await readWorkbookCapture(file, captureSignal));
  check();
  if (!samePreviewFile(capture.file, file)) throw new XlsxError("changed");
  const selectedSheetId = workbook?.selection?.sheetId;
  const saved = savedWorkbookPosition(file, readingPosition);
  const restoreSheet =
    !selectedSheetId && saved ? { ...saved.sheet } : undefined;
  let directory: WorkbookDirectory | undefined;
  try {
    const value = await readWorkbookPreview(
      capture,
      selectedSheetId,
      parserSignal,
      workbook?.onRecovery
        ? (result) => {
            directory = result;
          }
        : undefined,
      restoreSheet,
    );
    check();
    return {
      kind: "workbook",
      file,
      capture,
      value,
      ...(selectedSheetId ? { selectedSheetId } : {}),
    };
  } catch (error) {
    check();
    if (directory && directory.sheets.length > 1)
      workbook?.onRecovery?.({ capture, directory });
    throw error;
  }
}
