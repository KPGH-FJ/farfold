import type { RefObject } from "react";
import type { FileFeedback } from "../runtime/drafts";
import { FEEDBACK_STRINGS } from "../runtime/feedback_strings";
import { VISUAL_FEEDBACK_STRINGS as F } from "../runtime/visual_feedback_strings";
import { FILE_OPEN_STRINGS as S } from "../runtime/file_open_strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { WORKBOOK_STRINGS as B } from "../runtime/workbook_strings";
import { DOCUMENT_STRINGS as DOC } from "../runtime/document_strings";
import { PPTX_STRINGS as PPT } from "../runtime/pptx_strings";
import { TEXT_BLOCK_STRINGS as T } from "../runtime/text_block_strings";

/** Shared presentation only. The parent retains current-owner and draft guards. */
export function FileFeedbackEditor({
  feedback,
  disabled,
  canEdit,
  inputRef,
  pdfPage,
  isPdf,
  hasBlock,
  onWholeFile,
  onPdfPage,
  onTextChange,
  onSubmit,
}: {
  feedback: FileFeedback;
  disabled: boolean;
  canEdit: () => boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  pdfPage?: { page: number; pageCount: number };
  isPdf: boolean;
  hasBlock: boolean;
  onWholeFile: () => void;
  onPdfPage: () => void;
  onTextChange: (text: string) => void;
  onSubmit: () => void;
}) {
  const anchor = feedback.anchor;
  const editable = () => !disabled && canEdit();
  const target =
    anchor?.kind === "xlsx-range"
      ? B.feedbackTarget(anchor)
      : anchor?.kind === "docx-block"
        ? DOC.feedbackTarget(anchor)
        : anchor?.kind === "pptx-slide"
          ? FEEDBACK_STRINGS.presentationSlide(anchor)
          : anchor?.kind === "text-range"
            ? S.textTarget(anchor.startLine, anchor.endLine)
            : anchor?.kind === "image-area" || anchor?.kind === "pdf-area"
              ? FEEDBACK_STRINGS.visualArea(anchor)
              : anchor?.kind === "pdf-page"
                ? F.pageTarget(anchor.page, anchor.pageCount)
                : F.fileTarget;
  const retained =
    anchor?.kind === "xlsx-range"
      ? B.feedbackRetained
      : anchor?.kind === "docx-block"
        ? DOC.feedbackRetained
        : anchor?.kind === "pptx-slide"
          ? PPT.feedbackRetained
          : anchor?.kind === "text-range"
            ? S.textTargetRetained
            : F.retained;
  return (
    <form
      className="artifact-feedback"
      onSubmit={(event) => {
        event.preventDefault();
        if (editable()) onSubmit();
      }}
    >
      <div>
        <p role="status">{target}</p>
        {anchor && <p>{retained}</p>}
        {(anchor || isPdf) && (
          <div className="ac-actions" style={{ flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-text"
              disabled={!editable()}
              aria-pressed={!anchor}
              onClick={() => {
                if (editable()) onWholeFile();
              }}
            >
              {F.wholeFile}
            </button>
            {isPdf && pdfPage && (
              <button
                type="button"
                className="btn btn-text"
                disabled={!editable()}
                aria-pressed={
                  anchor?.kind === "pdf-page" &&
                  anchor.page === pdfPage.page &&
                  anchor.pageCount === pdfPage.pageCount
                }
                onClick={() => {
                  if (editable()) onPdfPage();
                }}
              >
                {F.currentPage(pdfPage.page)}
              </button>
            )}
          </div>
        )}
        {hasBlock && !anchor && <p>{T.feedback}</p>}
      </div>
      <textarea
        ref={inputRef}
        aria-label={W.feedbackLabel}
        placeholder={W.feedbackPlaceholder}
        rows={2}
        disabled={!editable()}
        value={feedback.text}
        onChange={(event) => {
          if (editable()) onTextChange(event.target.value);
        }}
      />
      <div>
        <span>{S.feedbackHint}</span>
        <button type="submit" disabled={!editable() || !feedback.text.trim()}>
          {W.feedbackAdd}
        </button>
      </div>
    </form>
  );
}
