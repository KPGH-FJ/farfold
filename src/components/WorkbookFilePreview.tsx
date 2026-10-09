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

/** A file-version snapshot. Only an explicit refresh in the parent rereads disk. */
export function WorkbookFilePreview({
  file,
  active,
}: {
  file: VerifiedFile;
  active: boolean;
}) {
  const capture = useRef<{ file: VerifiedFile; value: WorkbookCapture } | null>(
    null,
  );
  const current = useRef<AbortController | null>(null);
  const props = useRef({ file, active });
  props.current = { file, active };
  const [sheetId, setSheetId] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "failed" | "paused">(
    "loading",
  );
  const [message, setMessage] = useState<string>(S.loading);
  const [loaded, setLoaded] = useState<{
    file: VerifiedFile;
    value: WorkbookPreview;
  } | null>(null);
  useLayoutEffect(() => {
    const operation = new AbortController();
    current.current = operation;
    const owns = () =>
      current.current === operation &&
      !operation.signal.aborted &&
      props.current.active &&
      props.current.file === file;
    if (!active) {
      setState("paused");
      setMessage(S.paused);
      return () => operation.abort();
    }
    setState("loading");
    setMessage(S.loading);
    void (async () => {
      // A replaced mount must not start an OS read. In development, StrictMode
      // replays effects synchronously; only the surviving owner crosses IPC.
      await Promise.resolve();
      if (!owns()) return;
      const stored =
        capture.current?.file === file ? capture.current.value : null;
      const value = await (stored ??
        readWorkbookCapture(file, operation.signal));
      if (!owns()) return;
      capture.current = { file, value };
      const workbook = await readWorkbookPreview(
        value,
        sheetId,
        operation.signal,
      );
      if (!owns()) return;
      setLoaded({ file, value: workbook });
      setState("ready");
      setMessage(S.snapshot);
    })().catch((error) => {
      if (!owns()) return;
      setState("failed");
      setMessage(workbookFailure(error));
    });
    return () => {
      operation.abort();
      if (current.current === operation) current.current = null;
    };
  }, [file, active, sheetId, retry]);
  const workbook = loaded?.file === file ? loaded.value : null;
  const selectedId = sheetId ?? workbook?.sheet?.id;
  return (
    <section
      className="workbook-preview"
      aria-label={S.title}
      aria-busy={state === "loading"}
    >
      <div className="workbook-controls">
        {workbook && (
          <label>
            {S.sheet}
            <select
              aria-label={S.sheet}
              value={selectedId}
              disabled={!active || state === "loading"}
              onChange={(event) => setSheetId(event.target.value)}
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
              current.current?.abort();
              setState("paused");
              setMessage(S.cancelled);
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
            onClick={() => setRetry((value) => value + 1)}
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
          <WorkbookGrid key={workbook.sheet.id} workbook={workbook} />
        )}
    </section>
  );
}

function WorkbookGrid({ workbook }: { workbook: WorkbookPreview }) {
  const sheet = workbook.sheet!;
  const [start, setStart] = useState({ row: 1, column: 1 });
  const [showHidden, setShowHidden] = useState(false);
  const [address, setAddress] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [selection, setSelection] = useState<WorkbookPosition | null>(null);
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
  const chooseWindow = (next: typeof start) => {
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
      <form
        className="workbook-controls"
        onSubmit={(event) => {
          event.preventDefault();
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
      {selection && (
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
                    return (
                      <td
                        key={position.column}
                        rowSpan={position.rowSpan}
                        colSpan={position.colSpan}
                        style={{ ...cellStyle, textDecoration: undefined }}
                        data-cell={cellAddress(position.row, position.column)}
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
                            [description, issue].filter(Boolean).join(" · ") ||
                            undefined
                          }
                          onClick={() => setSelection(position)}
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
