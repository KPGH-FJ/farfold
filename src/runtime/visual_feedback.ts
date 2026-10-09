import type { VisualPreview } from "./file_delivery";
import { validPdfPage } from "./file_feedback_anchor";

export type VisualFeedbackLocation =
  { kind: "image" } | { kind: "pdf"; page: number; pageCount: number };
/** Transient ownership uses the exact read result; it is never serialized. */
export type VisualPreviewReadiness = {
  source: VisualPreview;
  location: VisualFeedbackLocation | null;
};

export function validVisualFeedbackLocation(
  source: VisualPreview,
  location: VisualFeedbackLocation,
): boolean {
  return location.kind === "pdf"
    ? source.mimeType === "application/pdf" &&
        validPdfPage(location.page, location.pageCount)
    : location.kind === "image" && source.mimeType.startsWith("image/");
}
