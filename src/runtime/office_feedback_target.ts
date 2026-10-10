import {
  validDocxBlock,
  validXlsxRange,
  type DocxBlockAnchor,
  type XlsxRangeAnchor,
} from "./file_feedback_anchor";
import {
  workbookFeedbackTarget,
  workbookFeedbackSourceIsValid,
  retireWorkbookFeedbackSource,
  type WorkbookFeedbackSource,
} from "./workbook_feedback_target";
import {
  documentFeedbackTarget,
  documentFeedbackSourceIsValid,
  retireDocumentFeedbackSource,
  type DocumentFeedbackSource,
} from "./docx_feedback_target";

// Extend this union only when another format has actual source coordinates.
export type OfficeFeedbackSource =
  WorkbookFeedbackSource | DocumentFeedbackSource;
export interface OfficeTargetAvailability {
  source: OfficeFeedbackSource;
  available: boolean;
}
export type OfficeTargetConfirmation =
  | { source: WorkbookFeedbackSource; anchor: XlsxRangeAnchor }
  | { source: DocumentFeedbackSource; anchor: DocxBlockAnchor };

export function officeFeedbackSourceIsValid(
  source: OfficeFeedbackSource,
): boolean {
  if (source?.kind === "xlsx") return workbookFeedbackSourceIsValid(source);
  if (source?.kind === "docx") return documentFeedbackSourceIsValid(source);
  return false;
}
export function retireOfficeFeedbackSource(source: OfficeFeedbackSource): void {
  if (source?.kind === "xlsx") retireWorkbookFeedbackSource(source);
  else if (source?.kind === "docx") retireDocumentFeedbackSource(source);
}

/** Coordinate/retirement check only. Current view and file ownership are separate. */
export function officeFeedbackTargetMatches(
  value: OfficeTargetConfirmation,
): boolean {
  if (!value) return false;
  const anchor = value.anchor;
  if (value.source?.kind === "docx") {
    if (!validDocxBlock(anchor)) return false;
    const actual = documentFeedbackTarget(value.source);
    return (
      !!actual &&
      actual.blockKind === anchor.blockKind &&
      actual.part === anchor.part &&
      actual.elementPath.length === anchor.elementPath.length &&
      actual.elementPath.every((v, i) => v === anchor.elementPath[i])
    );
  }
  if (value.source?.kind !== "xlsx" || !validXlsxRange(anchor)) return false;
  const actual = workbookFeedbackTarget(value.source);
  return (
    !!actual &&
    (Object.keys(actual) as (keyof XlsxRangeAnchor)[]).every(
      (key) => actual[key] === anchor[key],
    )
  );
}
