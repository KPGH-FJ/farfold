import { useLayoutEffect, useRef, useState } from "react";
import type { VerifiedFile } from "../runtime/file_delivery";
import type { WorkbookCapture, WorkbookPreview } from "../runtime/xlsx_types";
import {
  analyzeWorkbookFeedbackRange,
  parseWorkbookFeedbackRange,
  workbookFeedbackRangeAddress,
  type WorkbookFeedbackRange,
  type WorkbookFeedbackRangeAnalysis,
} from "../runtime/workbook_feedback_range";
import {
  createWorkbookRangeFeedbackSource,
  workbookFeedbackTarget,
  type WorkbookFeedbackSource,
} from "../runtime/workbook_feedback_target";
import {
  officeFeedbackSourceIsValid,
  retireOfficeFeedbackSource,
  type OfficeTargetAvailability,
  type OfficeTargetConfirmation,
} from "../runtime/office_feedback_target";
import type { OfficeTargetEditing } from "../runtime/office_target_editing";
import { columnLabel } from "../runtime/workbook_view";
import { WORKBOOK_STRINGS as S } from "../runtime/workbook_strings";

type Submitted = {
  range: WorkbookFeedbackRange;
  analysis: WorkbookFeedbackRangeAnalysis;
  selection: WorkbookFeedbackRange & { includeHidden: boolean };
};
type Draft = { text: string; invalid: boolean; submitted: Submitted | null };
type Props = {
  file: VerifiedFile;
  capture: WorkbookCapture;
  preview: WorkbookPreview;
  hiddenSheetSelected: boolean;
  interactionBlocked: boolean;
  window: {
    firstRow: number;
    lastRow: number;
    firstColumn: number;
    lastColumn: number;
  };
  isCurrent: () => boolean;
  retireSelection: { current: (() => void) | null };
  onOfficeTargetAvailability?: (value: OfficeTargetAvailability) => void;
  onOfficeTargetConfirm: (value: OfficeTargetConfirmation) => void;
  onOfficeTargetEditing?: (value: OfficeTargetEditing) => void;
  onRange: (range: WorkbookFeedbackRange | null) => void;
  onClose: () => void;
};

/** Address declaration, not a claim that every cell was displayed or inspected. */
export function WorkbookRangeSelection(props: Props) {
  const { file, capture, preview, hiddenSheetSelected, interactionBlocked } =
    props;
  const [draft, setDraft] = useState<Draft>({
    text: "",
    invalid: false,
    submitted: null,
  });
  const [shown, setShown] = useState<WorkbookFeedbackSource | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const feedback = useRef<WorkbookFeedbackSource | null>(null);
  const mounted = useRef(false);
  const current = useRef({ props, draft });
  current.current = { props, draft };
  const ownsContext = () =>
    mounted.current &&
    current.current.props.file === file &&
    current.current.props.capture === capture &&
    current.current.props.preview === preview &&
    !current.current.props.interactionBlocked &&
    current.current.props.isCurrent();
  const allowed = () => ownsContext() && current.current.draft === draft;
  const retire = () => {
    const previous = feedback.current;
    feedback.current = null;
    if (!previous) return;
    retireOfficeFeedbackSource(previous);
    setShown(null);
    current.current.props.onOfficeTargetAvailability?.({
      source: previous,
      available: false,
    });
  };
  const change = (next: Draft) => {
    // Retire before scheduling a render; queued callbacks cannot reuse old input.
    current.current.draft = next;
    setDraft(next);
    retire();
    if (ownsContext() && current.current.draft === next)
      current.current.props.onRange(next.submitted?.range ?? null);
  };
  useLayoutEffect(() => {
    mounted.current = true;
    const owner = {};
    const callback = current.current.props.onOfficeTargetEditing;
    callback?.({ owner, file, editing: true });
    if (
      mounted.current &&
      current.current.props.file === file &&
      !current.current.props.interactionBlocked &&
      current.current.props.isCurrent()
    )
      input.current?.focus({ preventScroll: true });
    return () => {
      mounted.current = false;
      retire();
      callback?.({ owner, file, editing: false });
    };
  }, [file, capture, preview]);
  useLayoutEffect(() => {
    props.retireSelection.current = retire;
    const submitted = draft.submitted;
    if (submitted && allowed()) {
      const source = createWorkbookRangeFeedbackSource({
        capture,
        preview,
        selection: submitted.selection,
        analysis: submitted.analysis,
        expectedFile: file,
        hiddenSheetSelected,
      });
      if (source) {
        feedback.current = source;
        setShown(source);
        current.current.props.onOfficeTargetAvailability?.({
          source,
          available: true,
        });
      }
    }
    return () => {
      retire();
      if (props.retireSelection.current === retire)
        props.retireSelection.current = null;
    };
  }, [
    file,
    capture,
    preview,
    draft,
    hiddenSheetSelected,
    interactionBlocked,
    props.retireSelection,
  ]);
  const submitted = draft.submitted;
  const range = submitted?.range;
  const outside =
    range &&
    (range.fromRow < props.window.firstRow ||
      range.toRow > props.window.lastRow ||
      range.fromColumn < props.window.firstColumn ||
      range.toColumn > props.window.lastColumn);
  const analysis = submitted?.analysis;
  return (
    <div className="workbook-range-selection">
      <form
        className="workbook-controls"
        aria-label={S.feedbackRangeInput}
        onSubmit={(event) => {
          event.preventDefault();
          if (!allowed()) return;
          const range = parseWorkbookFeedbackRange(draft.text);
          const analysis =
            range && analyzeWorkbookFeedbackRange({ preview, range });
          change(
            range && analysis
              ? {
                  text: workbookFeedbackRangeAddress(range),
                  invalid: false,
                  submitted: {
                    range,
                    analysis,
                    selection: Object.freeze({
                      ...range,
                      includeHidden: false,
                    }),
                  },
                }
              : { ...draft, invalid: true, submitted: null },
          );
        }}
      >
        <label>
          {S.feedbackRangeInput}
          <input
            ref={input}
            aria-label={S.feedbackRangeInput}
            value={draft.text}
            aria-invalid={draft.invalid}
            placeholder="A1:C200"
            maxLength={32}
            onChange={(event) => {
              if (allowed())
                change({
                  text: event.target.value,
                  invalid: false,
                  submitted: null,
                });
            }}
          />
        </label>
        <button className="btn btn-ghost" type="submit">
          {S.feedbackRangeSelect}
        </button>
      </form>
      <p>{S.feedbackRangeScope}</p>
      {draft.invalid && <p role="alert">{S.feedbackRangeInvalid}</p>}
      {range && analysis && (
        <div className="workbook-range-summary" role="status">
          <strong>
            {S.feedbackRangeSummary(
              analysis.sheetName,
              workbookFeedbackRangeAddress(range),
              range.toRow - range.fromRow + 1,
              range.toColumn - range.fromColumn + 1,
            )}
          </strong>
          {outside && <p>{S.feedbackRangeOutside}</p>}
          {analysis.requiresHiddenConfirmation && (
            <>
              <p>
                {S.feedbackRangeHidden(
                  analysis.hiddenRowCount,
                  analysis.hiddenColumnCount,
                )}
              </p>
              <CoordinateList
                key={`${draft.text}:rows`}
                isCurrent={allowed}
                title={S.feedbackRangeHiddenRows}
                items={analysis.hiddenRows}
                label={(v) =>
                  v.from === v.to ? String(v.from) : `${v.from}–${v.to}`
                }
              />
              <CoordinateList
                key={`${draft.text}:columns`}
                isCurrent={allowed}
                title={S.feedbackRangeHiddenColumns}
                items={analysis.hiddenColumns}
                label={(v) =>
                  v.from === v.to
                    ? columnLabel(v.from)
                    : `${columnLabel(v.from)}–${columnLabel(v.to)}`
                }
              />
              <label className="workbook-range-hidden">
                <input
                  type="checkbox"
                  aria-label={S.feedbackRangeIncludeHidden}
                  checked={submitted!.selection.includeHidden}
                  onChange={(event) => {
                    if (
                      !allowed() ||
                      current.current.draft.submitted !== submitted
                    )
                      return;
                    change({
                      ...draft,
                      submitted: {
                        ...submitted!,
                        selection: Object.freeze({
                          ...range,
                          includeHidden: event.target.checked,
                        }),
                      },
                    });
                  }}
                />
                {S.feedbackRangeIncludeHidden}
              </label>
            </>
          )}
          {analysis.partialMerges.length > 0 && (
            <>
              <p>
                {S.feedbackRangePartialMerges(analysis.partialMerges.length)}
              </p>
              <CoordinateList
                key={`${draft.text}:merges`}
                isCurrent={allowed}
                title={S.feedbackRangeMerges}
                items={analysis.partialMerges}
                label={workbookFeedbackRangeAddress}
              />
            </>
          )}
        </div>
      )}
      <div className="workbook-controls">
        {shown && (
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => {
              if (
                !allowed() ||
                feedback.current !== shown ||
                !officeFeedbackSourceIsValid(shown)
              )
                return;
              const anchor = workbookFeedbackTarget(shown);
              if (anchor)
                current.current.props.onOfficeTargetConfirm({
                  source: shown,
                  anchor,
                });
            }}
          >
            {S.feedbackRangeConfirm}
          </button>
        )}
        <button
          className="btn btn-text"
          type="button"
          onClick={() => {
            if (!allowed()) return;
            retire();
            if (allowed()) current.current.props.onClose();
          }}
        >
          {S.feedbackRangeCancel}
        </button>
      </div>
    </div>
  );
}

/** Display only a bounded page of coordinate metadata, never hidden values. */
function CoordinateList<T>({
  title,
  items,
  label,
  isCurrent,
}: {
  title: string;
  items: readonly T[];
  label: (value: T) => string;
  isCurrent: () => boolean;
}) {
  const [page, setPage] = useState(0);
  const current = useRef({ items, page });
  current.current = { items, page };
  const canChange = () =>
    current.current.items === items &&
    current.current.page === page &&
    isCurrent();
  if (!items.length) return null;
  const first = Math.min(page * 20, Math.max(0, items.length - 1)),
    last = Math.min(items.length, first + 20);
  return (
    <details className="workbook-range-coordinates">
      <summary>
        {title} ({items.length})
      </summary>
      <p>{items.slice(first, last).map(label).join("、")}</p>
      {items.length > 20 && (
        <div className="workbook-controls">
          <span>{S.feedbackRangeListPage(first + 1, last, items.length)}</span>
          <button
            className="btn btn-text"
            type="button"
            disabled={first === 0}
            onClick={() => {
              if (canChange()) setPage(Math.max(0, page - 1));
            }}
          >
            {S.feedbackRangeListPrevious}
          </button>
          <button
            className="btn btn-text"
            type="button"
            disabled={last === items.length}
            onClick={() => {
              if (canChange()) setPage(page + 1);
            }}
          >
            {S.feedbackRangeListNext}
          </button>
        </div>
      )}
    </details>
  );
}
