import { validXlsxRange, type XlsxRangeAnchor } from "./file_feedback_anchor";
import {
  workbookFeedbackTarget,
  type WorkbookFeedbackSource,
} from "./workbook_feedback_target";

// Extend this union only when another format has actual source coordinates.
export type OfficeFeedbackSource = WorkbookFeedbackSource;
export interface OfficeTargetAvailability {
  source: OfficeFeedbackSource;
  available: boolean;
}
export interface OfficeTargetConfirmation {
  source: OfficeFeedbackSource;
  anchor: XlsxRangeAnchor;
}
export {
  workbookFeedbackSourceIsValid as officeFeedbackSourceIsValid,
  retireWorkbookFeedbackSource as retireOfficeFeedbackSource,
} from "./workbook_feedback_target";

/** Coordinate/retirement check only. Current view and file ownership are separate. */
export function officeFeedbackTargetMatches(
  value: OfficeTargetConfirmation,
): boolean {
  if (!value || !validXlsxRange(value.anchor)) return false;
  const actual = workbookFeedbackTarget(value.source);
  return (
    !!actual &&
    (Object.keys(actual) as (keyof XlsxRangeAnchor)[]).every(
      (key) => actual[key] === value.anchor[key],
    )
  );
}
