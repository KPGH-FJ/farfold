import { XlsxError } from "../runtime/xlsx_types";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { VerifiedFile } from "../runtime/file_delivery";
import {
  readWorkbookCapture,
  readWorkbookPreview,
} from "../runtime/xlsx_preview";
import type {
  WorkbookCapture,
  WorkbookPreview,
  XlsxCell,
} from "../runtime/xlsx_types";
import {
  WORKBOOK_STRINGS as S,
  WORKBOOK_WARNINGS,
  workbookFailure,
  workbookFormatIssue,
} from "../runtime/workbook_strings";
import {
  cellAddress,
  columnLabel,
  parseCellAddress,
  workbookCellStyle,
  workbookFont,
  workbookWindow,
  WORKBOOK_WINDOW,
  type WorkbookPosition,
} from "../runtime/workbook_view";
import {
  restoredWorkbookSheet,
  restoredWorkbookWindow,
  saveReadingPosition,
  type PreviewReadingPositionRef,
} from "../runtime/preview_reading_position";
import {
  PreviewCapture,
  samePreviewFile,
  type PreviewContentStatus,
} from "../runtime/preview_capture";
import type { PreparedWorkbookPreview } from "../runtime/office_preview_prepare";
import {
  createWorkbookFeedbackSource,
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
import type { WorkbookFeedbackRange } from "../runtime/workbook_feedback_range";
import { WorkbookRangeSelection } from "./WorkbookRangeSelection";
import "./WorkbookFilePreview.css";

function cellValue(cell: XlsxCell | undefined): string {
  if (!cell) return "";
  if (cell.cacheState === "missing") return S.missingCache;
  if (cell.formatIssue) return savedValue(cell);
  return (
    cell.display ?? cell.raw ?? (cell.value === null ? "" : String(cell.value))
  );
}
function savedValue(cell: XlsxCell | undefined): string {
  if (cell?.cacheState === "missing") return S.missingCache;
  if (!cell || cell.type === "blank") return S.blank;
  if (cell.value === "") return S.emptyText;
  if (cell.type === "text" || cell.type === "boolean")
    return String(cell.value);
  return cell.raw ?? (cell.value === null ? S.blank : String(cell.value));
}
function mergeDescription(position: WorkbookPosition): string | undefined {
  const merge = position.merge;
  return merge
    ? [
        S.merged(
          cellAddress(merge.fromRow, merge.fromColumn),
          cellAddress(merge.toRow, merge.toColumn),
        ),
        position.partial && S.partialMerge,
        position.hiddenAnchor && S.hiddenMerge,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
}

/** A verified file-version snapshot; the parent stages refreshed contents. */
export function WorkbookFilePreview({
  file,
  active,
  interactionBlocked = false,
  readingPosition,
  prepared,
  onStatus,
  onOfficeTargetAvailability,
  onOfficeTargetConfirm,
  onOfficeTargetEditing,
}: {
  file: VerifiedFile;
  active: boolean;
  interactionBlocked?: boolean;
  readingPosition?: PreviewReadingPositionRef;
  prepared?: PreparedWorkbookPreview;
  onStatus?: (status: PreviewContentStatus) => void;
  onOfficeTargetAvailability?: (value: OfficeTargetAvailability) => void;
  onOfficeTargetConfirm?: (value: OfficeTargetConfirmation) => void;
  onOfficeTargetEditing?: (value: OfficeTargetEditing) => void;
}) {
  const capture = useRef<{ file: VerifiedFile; value: WorkbookCapture } | null>(
    null,
  );
  const status = useRef(onStatus);
  status.current = onStatus;
  const current = useRef<AbortController | null>(null);
  const retireSelection = useRef<(() => void) | null>(null);
  const captureReader = useRef(new PreviewCapture<WorkbookCapture>());
  const props = useRef({ file, active, interactionBlocked });
  props.current = { file, active, interactionBlocked };
  const [selection, setSelection] = useState<{
    file: VerifiedFile;
    id: string;
  } | null>(null);
  const sheetId = selection?.file === file ? selection.id : undefined;
  const [retry, setRetry] = useState(0);
  const attempt = useRef({ retry, prepared });
  attempt.current = { retry, prepared };
  const [state, setState] = useState<"loading" | "ready" | "failed" | "paused">(
    "loading",
  );
  const [message, setMessage] = useState<string>(S.loading);
  const [loaded, setLoaded] = useState<{
    file: VerifiedFile;
    value: WorkbookPreview;
    capture: WorkbookCapture;
    operation: AbortController;
  } | null>(null);
  const feedbackState = useRef({ state, loaded, sheetId });
  feedbackState.current = { state, loaded, sheetId };
  useLayoutEffect(() => {
    retireSelection.current?.();
    const operation = new AbortController();
    current.current = operation;
    const owns = () =>
      current.current === operation &&
      !operation.signal.aborted &&
      props.current.active &&
      props.current.file === file;
    if (!active) {
      status.current?.({ file, state: "paused" });
      setState("paused");
      setMessage(S.paused);
      return () => operation.abort();
    }
    setState("loading");
    setMessage(S.loading);
    status.current?.({ file, state: "loading" });
    void (async () => {
      // A replaced mount must not start an OS read. In development, StrictMode
      // replays effects synchronously; only the surviving owner crosses IPC.
      await Promise.resolve();
      if (!owns()) return;
      const staged =
        prepared &&
        samePreviewFile(prepared.file, file) &&
        samePreviewFile(prepared.capture.file, file)
          ? prepared
          : null;
      const stored =
        staged?.capture ??
        (capture.current?.file === file ? capture.current.value : null);
      const value = await (stored ??
        captureReader.current.read(file, retry, readWorkbookCapture));
      if (!owns()) return;
      capture.current = { file, value };
      let workbook =
        staged && (sheetId === undefined || staged.value.sheet?.id === sheetId)
          ? staged.value
          : await readWorkbookPreview(value, sheetId, operation.signal);
      if (!owns()) return;
      // Resolve a stored location against the new workbook's actual directory.
      // Never ask the parser to guess a removed or recycled sheet ID.
      if (sheetId === undefined) {
        const restored =
          restoredWorkbookSheet(file, workbook, readingPosition) ??
          (staged
            ? workbook.sheets.find((item) => item.state === "visible")?.id
            : undefined);
        if (restored && restored !== workbook.sheet?.id) {
          workbook = await readWorkbookPreview(
            value,
            restored,
            operation.signal,
          );
          if (!owns()) return;
        }
      }
      setLoaded({ file, value: workbook, capture: value, operation });
      setState("ready");
      status.current?.({ file, state: "ready" });
      setMessage(S.snapshot);
    })().catch((error) => {
      const code = error instanceof XlsxError ? error.code : undefined;
      if (
        props.current.file === file &&
        attempt.current.retry === retry &&
        attempt.current.prepared === prepared &&
        (owns() || code === "readPending" || code === "readBusy")
      )
        status.current?.({ file, state: "failed", ...(code ? { code } : {}) });
      if (!owns()) return;
      setState("failed");
      setMessage(workbookFailure(error));
    });
    return () => {
      retireSelection.current?.();
      operation.abort();
      if (current.current === operation) current.current = null;
    };
  }, [file, active, sheetId, retry, readingPosition, prepared]);
  const workbook = loaded?.file === file ? loaded.value : null;
  const selectedId = sheetId ?? workbook?.sheet?.id;
  const canInteract = () =>
    props.current.active &&
    !props.current.interactionBlocked &&
    props.current.file === file &&
    attempt.current.retry === retry &&
    attempt.current.prepared === prepared &&
    feedbackState.current.sheetId === sheetId;
  return (
    <section
      className="workbook-preview"
      aria-label={S.title}
      aria-busy={state === "loading"}
      inert={interactionBlocked}
    >
      <div className="workbook-controls">
        {workbook && (
          <label>
            {S.sheet}
            <select
              aria-label={S.sheet}
              value={selectedId}
              disabled={!active || state === "loading"}
              onChange={(event) => {
                if (!canInteract() || feedbackState.current.state !== "ready")
                  return;
                retireSelection.current?.();
                setSelection({ file, id: event.target.value });
              }}
            >
              {workbook.sheets.map((sheet) => (
                <option key={sheet.id} value={sheet.id}>
                  {sheet.name}
                  {sheet.state === "visible"
                    ? ""
                    : ` · ${sheet.state === "hidden" ? S.hidden : S.veryHidden}`}
                </option>
              ))}
            </select>
          </label>
        )}
        {state === "loading" && (
          <button
            className="btn btn-text"
            type="button"
            onClick={() => {
              if (!canInteract() || feedbackState.current.state !== "loading")
                return;
              retireSelection.current?.();
              current.current?.abort();
              setState("paused");
              setMessage(S.cancelled);
              status.current?.({ file, state: "paused" });
            }}
          >
            {S.cancel}
          </button>
        )}
        {(state === "failed" || state === "paused") && (
          <button
            className="btn btn-text"
            type="button"
            disabled={!active}
            onClick={() => {
              if (
                !canInteract() ||
                !["failed", "paused"].includes(feedbackState.current.state)
              )
                return;
              retireSelection.current?.();
              setRetry((value) => value + 1);
            }}
          >
            {S.retry}
          </button>
        )}
      </div>
      <p role={state === "failed" ? "alert" : "status"}>{message}</p>
      {state === "ready" &&
        active &&
        workbook?.sheet &&
        (sheetId === undefined || workbook.sheet.id === sheetId) && (
          <WorkbookGrid
            key={`${file.root}:${file.resolvedPath}:${file.version}:${file.sha256}:${workbook.sheet.id}`}
            workbook={workbook}
            file={file}
            explicitSheetSelection={sheetId === workbook.sheet.id}
            readingPosition={readingPosition}
            capture={loaded!.capture}
            interactionBlocked={interactionBlocked}
            retireSelection={retireSelection}
            isCurrent={() => {
              const now = feedbackState.current;
              return (
                props.current.active &&
                !props.current.interactionBlocked &&
                props.current.file === file &&
                now.state === "ready" &&
                now.loaded === loaded &&
                current.current === loaded!.operation &&
                !loaded!.operation.signal.aborted &&
                (now.sheetId === undefined ||
                  now.sheetId === workbook.sheet!.id)
              );
            }}
            onOfficeTargetAvailability={onOfficeTargetAvailability}
            onOfficeTargetConfirm={onOfficeTargetConfirm}
            onOfficeTargetEditing={onOfficeTargetEditing}
          />
        )}
    </section>
  );
}

function WorkbookGrid({
  file,
  workbook,
  readingPosition,
  explicitSheetSelection,
  capture,
  interactionBlocked,
  retireSelection,
  isCurrent,
  onOfficeTargetAvailability,
  onOfficeTargetConfirm,
  onOfficeTargetEditing,
}: {
  file: VerifiedFile;
  workbook: WorkbookPreview;
  explicitSheetSelection: boolean;
  readingPosition?: PreviewReadingPositionRef;
  capture: WorkbookCapture;
  interactionBlocked: boolean;
  retireSelection: { current: (() => void) | null };
  isCurrent: () => boolean;
  onOfficeTargetAvailability?: (value: OfficeTargetAvailability) => void;
  onOfficeTargetConfirm?: (value: OfficeTargetConfirmation) => void;
  onOfficeTargetEditing?: (value: OfficeTargetEditing) => void;
}) {
  const sheet = workbook.sheet!;
  const restored = restoredWorkbookWindow(file, workbook, readingPosition);
  const [start, setStart] = useState({
    row: restored.row,
    column: restored.column,
  });
  const [showHidden, setShowHidden] = useState(restored.showHidden);
  useLayoutEffect(() => {
    const info = workbook.sheets.find((item) => item.id === sheet.id);
    if (info)
      saveReadingPosition(readingPosition, file, {
        kind: "workbook",
        sheet: {
          id: info.id,
          name: info.name,
          hiddenSelected:
            info.state !== "visible" &&
            (explicitSheetSelection ||
              restoredWorkbookSheet(file, workbook, readingPosition) ===
                info.id),
        },
        ...start,
        showHidden,
      });
  }, [
    file,
    workbook,
    sheet,
    start,
    showHidden,
    readingPosition,
    explicitSheetSelection,
  ]);
  const [address, setAddress] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [selection, setSelection] = useState<WorkbookPosition | null>(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  const rangeActive = useRef(false);
  rangeActive.current = rangeOpen;
  const [range, setRange] = useState<WorkbookFeedbackRange | null>(null);
  const rangeRetire = useRef<(() => void) | null>(null);
  const rangeTrigger = useRef<HTMLButtonElement>(null);
  const wasRangeOpen = useRef(false);
  useLayoutEffect(() => {
    const was = wasRangeOpen.current;
    wasRangeOpen.current = rangeOpen;
    if (was && !rangeOpen && isCurrent())
      rangeTrigger.current?.focus({ preventScroll: true });
  }, [rangeOpen]);
  const grid = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (selection) {
      detail.current?.scrollIntoView({ block: "nearest" });
      detail.current?.focus({ preventScroll: true });
    }
  }, [selection]);
  const cells = useMemo(
    () => new Map(sheet.cells.map((cell) => [cell.reference, cell])),
    [sheet],
  );
  const window = useMemo(
    () => workbookWindow(sheet, cells, start, showHidden),
    [sheet, cells, start, showHidden],
  );
  const hiddenSheetSelected =
    explicitSheetSelection ||
    restoredWorkbookSheet(file, workbook, readingPosition) === sheet.id;
  const feedback = useRef<WorkbookFeedbackSource | null>(null);
  const [shownFeedback, setShownFeedback] =
    useState<WorkbookFeedbackSource | null>(null);
  const latest = useRef({
    selection,
    window,
    isCurrent,
    onOfficeTargetAvailability,
    onOfficeTargetConfirm,
    onOfficeTargetEditing,
  });
  latest.current = {
    selection,
    window,
    isCurrent,
    onOfficeTargetAvailability,
    onOfficeTargetConfirm,
    onOfficeTargetEditing,
  };
  const retire = () => {
    const previous = feedback.current;
    feedback.current = null;
    if (!previous) return;
    retireOfficeFeedbackSource(previous);
    setShownFeedback(null);
    latest.current.onOfficeTargetAvailability?.({
      source: previous,
      available: false,
    });
  };
  useLayoutEffect(() => {
    // Create within the effect, so StrictMode's replay cannot reuse a retired source.
    const retireAll = () => {
      retire();
      rangeRetire.current?.();
    };
    retireSelection.current = retireAll;
    if (
      !rangeOpen &&
      selection &&
      onOfficeTargetConfirm &&
      latest.current.isCurrent()
    ) {
      const source = createWorkbookFeedbackSource({
        capture,
        preview: workbook,
        window,
        position: selection,
        showHidden,
        hiddenSheetSelected,
        expectedFile: file,
      });
      if (source) {
        feedback.current = source;
        setShownFeedback(source);
        latest.current.onOfficeTargetAvailability?.({
          source,
          available: true,
        });
      }
    }
    return () => {
      retire();
      if (retireSelection.current === retireAll) retireSelection.current = null;
    };
  }, [
    capture,
    workbook,
    file,
    window,
    selection,
    showHidden,
    hiddenSheetSelected,
    interactionBlocked,
    rangeOpen,
    Boolean(onOfficeTargetConfirm),
    retireSelection,
  ]);
  const closeRange = () => {
    rangeActive.current = false;
    setRange(null);
    setRangeOpen(false);
    rangeRetire.current?.();
  };
  const chooseWindow = (next: typeof start) => {
    if (!latest.current.isCurrent()) return;
    const owner = latest.current;
    retire();
    if (latest.current !== owner || !owner.isCurrent()) return;
    closeRange();
    if (latest.current !== owner || !owner.isCurrent()) return;
    setStart(next);
    setSelection(null);
    if (grid.current) {
      grid.current.scrollTop = 0;
      grid.current.scrollLeft = 0;
    }
  };
  const warnings = [
    ...new Set(
      workbook.warnings
        .map(
          (code) => WORKBOOK_WARNINGS[code as keyof typeof WORKBOOK_WARNINGS],
        )
        .filter(Boolean),
    ),
  ];
  const hasHidden =
    sheet.rows.some((row) => row.hidden) ||
    sheet.columns.some((col) => col.hidden);
  const columnWidth = (column: number) =>
    Math.max(
      48,
      Math.min(480, (window.columnMetadata(column)?.width ?? 12) * 7 + 5),
    );
  return (
    <>
      <p>{S.layout}</p>
      {warnings.length > 0 && (
        <details className="workbook-warnings">
          <summary>
            {S.warnings} ({warnings.length})
          </summary>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      {onOfficeTargetConfirm && !rangeOpen && (
        <button
          className="btn btn-ghost"
          type="button"
          ref={rangeTrigger}
          onClick={() => {
            if (!latest.current.isCurrent() || rangeActive.current) return;
            retire();
            if (!latest.current.isCurrent()) return;
            setSelection(null);
            rangeActive.current = true;
            setRangeOpen(true);
          }}
        >
          {S.feedbackRangeOpen}
        </button>
      )}
      {rangeOpen && onOfficeTargetConfirm && (
        <WorkbookRangeSelection
          file={file}
          capture={capture}
          preview={workbook}
          hiddenSheetSelected={hiddenSheetSelected}
          interactionBlocked={interactionBlocked}
          window={window}
          retireSelection={rangeRetire}
          isCurrent={() => rangeActive.current && latest.current.isCurrent()}
          onOfficeTargetAvailability={onOfficeTargetAvailability}
          onOfficeTargetConfirm={onOfficeTargetConfirm}
          onOfficeTargetEditing={onOfficeTargetEditing}
          onRange={setRange}
          onClose={() => {
            if (!rangeActive.current || !latest.current.isCurrent()) return;
            closeRange();
            // Focus is restored after the entry button is mounted below.
          }}
        />
      )}
      <form
        className="workbook-controls"
        onSubmit={(event) => {
          event.preventDefault();
          if (!latest.current.isCurrent()) return;
          const next = parseCellAddress(address);
          setInvalid(!next);
          if (next) {
            chooseWindow(next);
            grid.current?.focus();
          }
        }}
      >
        <label>
          {S.address}
          <input
            aria-label={S.address}
            aria-invalid={invalid}
            value={address}
            placeholder="A1"
            maxLength={10}
            onChange={(event) => {
              if (!latest.current.isCurrent()) return;
              setAddress(event.target.value);
              setInvalid(false);
            }}
          />
        </label>
        <button type="submit" className="btn btn-ghost">
          {S.jump}
        </button>
        {hasHidden && (
          <label>
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(event) => {
                if (!latest.current.isCurrent()) return;
                const owner = latest.current;
                retire();
                if (latest.current !== owner || !owner.isCurrent()) return;
                closeRange();
                if (latest.current !== owner || !owner.isCurrent()) return;
                setShowHidden(event.target.checked);
                setSelection(null);
              }}
            />
            {S.showHidden}
          </label>
        )}
      </form>
      {invalid && <p role="alert">{S.invalidAddress}</p>}
      <div className="workbook-controls workbook-pagination">
        <button
          className="btn btn-text"
          type="button"
          disabled={start.row <= 1}
          onClick={() =>
            chooseWindow({
              ...start,
              row: Math.max(1, start.row - WORKBOOK_WINDOW.rows),
            })
          }
        >
          {S.previousRows}
        </button>
        <button
          className="btn btn-text"
          type="button"
          disabled={window.lastRow >= window.extent.rows}
          onClick={() => chooseWindow({ ...start, row: window.lastRow + 1 })}
        >
          {S.nextRows}
        </button>
        <button
          className="btn btn-text"
          type="button"
          disabled={start.column <= 1}
          onClick={() =>
            chooseWindow({
              ...start,
              column: Math.max(1, start.column - WORKBOOK_WINDOW.columns),
            })
          }
        >
          {S.previousColumns}
        </button>
        <button
          className="btn btn-text"
          type="button"
          disabled={window.lastColumn >= window.extent.columns}
          onClick={() =>
            chooseWindow({ ...start, column: window.lastColumn + 1 })
          }
        >
          {S.nextColumns}
        </button>
      </div>
      <p role="status">
        {S.range(
          cellAddress(window.firstRow, window.firstColumn),
          cellAddress(window.lastRow, window.lastColumn),
        )}
      </p>
      {selection && !rangeOpen && (
        <div
          className="workbook-cell-detail"
          aria-label={S.detail}
          ref={detail}
          tabIndex={-1}
        >
          <div className="workbook-controls">
            <strong>
              {S.selected(
                selection.cell?.reference ??
                  cellAddress(selection.row, selection.column),
              )}
            </strong>
            <button
              type="button"
              className="btn btn-text"
              onClick={() => {
                if (!latest.current.isCurrent()) return;
                retire();
                const address = cellAddress(selection.row, selection.column);
                setSelection(null);
                grid.current
                  ?.querySelector<HTMLButtonElement>(
                    `[data-cell="${address}"] button`,
                  )
                  ?.focus();
              }}
            >
              {S.closeDetail}
            </button>
            {shownFeedback && !selection.hiddenAnchor && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  const now = latest.current;
                  if (
                    rangeActive.current ||
                    feedback.current !== shownFeedback ||
                    now.selection !== selection ||
                    now.window !== window ||
                    !now.isCurrent() ||
                    !officeFeedbackSourceIsValid(shownFeedback)
                  )
                    return;
                  const anchor = workbookFeedbackTarget(shownFeedback);
                  if (anchor)
                    now.onOfficeTargetConfirm?.({
                      source: shownFeedback,
                      anchor,
                    });
                }}
              >
                {selection.merge ? S.feedbackMerge : S.feedbackCell}
              </button>
            )}
          </div>
          {selection.merge && <p>{mergeDescription(selection)}</p>}
          {!selection.hiddenAnchor && (
            <>
              <dl>
                <dt>{S.formatted}</dt>
                <dd>
                  <pre>{cellValue(selection.cell) || S.emptyDisplay}</pre>
                </dd>
                <dt>{S.value}</dt>
                <dd>
                  <pre>{savedValue(selection.cell)}</pre>
                </dd>
                {selection.cell?.formulaPresent && (
                  <>
                    <dt>{S.formula}</dt>
                    <dd>
                      <pre>{selection.cell.formula ?? S.noFormulaText}</pre>
                    </dd>
                  </>
                )}
              </dl>
              {selection.cell?.formatIssue && (
                <p>{workbookFormatIssue(selection.cell.formatIssue)}</p>
              )}
            </>
          )}
        </div>
      )}
      <div
        className="workbook-grid-scroll"
        ref={grid}
        tabIndex={0}
        aria-label={S.title}
      >
        {window.rows.length && window.columns.length ? (
          <table
            className="workbook-grid"
            style={{
              width:
                52 +
                window.columns.reduce(
                  (sum, column) => sum + columnWidth(column),
                  0,
                ),
            }}
          >
            <caption>
              {workbook.sheets.find((info) => info.id === sheet.id)?.name}
            </caption>
            <colgroup>
              <col style={{ width: 52 }} />
              {window.columns.map((column) => (
                <col
                  key={column}
                  style={{
                    width: columnWidth(column),
                  }}
                />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th aria-label={S.address} />
                {window.columns.map((column) => (
                  <th key={column} scope="col">
                    {columnLabel(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {window.positions.map((positions, index) => (
                <tr
                  key={window.rows[index]}
                  style={{
                    height: Math.min(
                      512,
                      Math.max(
                        24,
                        ((window.rowMetadata.get(window.rows[index])?.height ??
                          18) *
                          4) /
                          3,
                      ),
                    ),
                  }}
                >
                  <th scope="row">{window.rows[index]}</th>
                  {positions.map((position) => {
                    const cell = position.cell;
                    const issue = workbookFormatIssue(cell?.formatIssue);
                    const text = position.hiddenAnchor ? "" : cellValue(cell);
                    const description = mergeDescription(position);
                    const style =
                      workbook.styles[
                        cell?.styleId ??
                          window.rowMetadata.get(
                            position.merge?.fromRow ?? position.row,
                          )?.styleId ??
                          window.columnMetadata(
                            position.merge?.fromColumn ?? position.column,
                          )?.styleId ??
                          0
                      ];
                    const cellStyle = workbookCellStyle(style, cell);
                    const showRuns =
                      cell?.runs &&
                      cell.type === "text" &&
                      !cell.formatIssue &&
                      cell.display === cell.value &&
                      cell.display ===
                        cell.runs.map((run) => run.text).join("");
                    const displayed = position.merge ?? {
                      fromRow: position.row,
                      toRow: position.row,
                      fromColumn: position.column,
                      toColumn: position.column,
                    };
                    const intersects =
                      range &&
                      displayed.toRow >= range.fromRow &&
                      displayed.fromRow <= range.toRow &&
                      displayed.toColumn >= range.fromColumn &&
                      displayed.fromColumn <= range.toColumn;
                    const rangeState = intersects
                      ? range!.fromRow <= displayed.fromRow &&
                        range!.toRow >= displayed.toRow &&
                        range!.fromColumn <= displayed.fromColumn &&
                        range!.toColumn >= displayed.toColumn
                        ? "inside"
                        : "partial"
                      : undefined;
                    return (
                      <td
                        key={position.column}
                        rowSpan={position.rowSpan}
                        colSpan={position.colSpan}
                        style={{ ...cellStyle, textDecoration: undefined }}
                        data-cell={cellAddress(position.row, position.column)}
                        data-opinion-range={rangeState}
                      >
                        <button
                          type="button"
                          className="workbook-cell"
                          style={{
                            textDecoration: showRuns
                              ? undefined
                              : cellStyle.textDecoration,
                          }}
                          aria-label={`${S.selected(cellAddress(position.row, position.column))}${text ? `：${text.slice(0, 200)}` : ""}`}
                          title={
                            [
                              description,
                              issue,
                              rangeState === "partial" &&
                                S.feedbackRangeIntersection,
                            ]
                              .filter(Boolean)
                              .join(" · ") || undefined
                          }
                          onClick={() => {
                            if (!latest.current.isCurrent()) return;
                            if (position !== selection || rangeActive.current) {
                              const owner = latest.current;
                              retire();
                              if (
                                latest.current !== owner ||
                                !owner.isCurrent()
                              )
                                return;
                              closeRange();
                              if (
                                latest.current !== owner ||
                                !owner.isCurrent()
                              )
                                return;
                              setSelection(position);
                            }
                          }}
                        >
                          {showRuns
                            ? cell!.runs!.map((run, i) => (
                                <span
                                  key={i}
                                  style={workbookFont({
                                    ...style?.font,
                                    ...run.font,
                                  })}
                                >
                                  {run.text}
                                </span>
                              ))
                            : text}
                          {(issue ||
                            position.partial ||
                            position.hiddenAnchor) && (
                            <span
                              className="workbook-cell-note"
                              aria-label={issue ?? description}
                            >
                              *
                            </span>
                          )}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>{S.emptyWindow}</p>
        )}
      </div>
    </>
  );
}
