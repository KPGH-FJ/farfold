import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  threads,
  useThreadsSnapshot,
  type SidebarRow,
} from "../runtime/sessions";
import {
  AttachmentSearch,
  attachmentSearch,
  validAttachmentSearchQuery,
} from "../runtime/attachment_search";
import {
  attachmentSearchCandidates,
  attachmentSearchIsDocx,
  attachmentSearchIsXlsx,
  attachmentSearchIsPdf,
  attachmentSearchIsPptx,
  attachmentSearchSourceCurrent,
  type AttachmentSearchCandidate,
  type SelectAttachmentSearch,
} from "../runtime/attachment_search_source";
import {
  ATTACHMENT_SEARCH_STRINGS as S,
  attachmentSearchLocationLabel,
  xlsxSearchWarningLabel,
  pdfSearchWarningLabel,
  pptxSearchWarningLabel,
} from "../runtime/attachment_search_strings";
import "./HistorySearchPanel.css";

export function SelectedAttachmentSearch({
  active,
  rows,
  query,
  scopeKey,
  onSelect,
  controller: provided,
}: {
  active: boolean;
  rows: SidebarRow[];
  query: string;
  scopeKey: string;
  onSelect?: SelectAttachmentSearch;
  controller?: AttachmentSearch;
}) {
  const snapshot = useThreadsSnapshot();
  const [controller] = useState(() => provided ?? attachmentSearch);
  const [selected, setSelected] = useState<AttachmentSearchCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const mounted = useRef(false),
    revision = useRef<object>({});
  const selectionFieldset = useRef<HTMLFieldSetElement>(null);
  const live = useRef({ active, rows, query, scopeKey, selected });
  live.current = { active, rows, query, scopeKey, selected };
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const keys = rows.map((r) => r.key),
    keySet = JSON.stringify([...keys].sort());
  const candidates = attachmentSearchCandidates(keys, snapshot.threads);
  const validSources = selected.every((s) =>
    attachmentSearchSourceCurrent(s, snapshot.threads, keys, snapshot.index),
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current = {};
      controller.retire();
    };
  }, [controller]);
  useEffect(() => {
    revision.current = {};
    controller.retire();
    setError(null);
  }, [controller, active, query, scopeKey, keySet, validSources]);
  const invalidate = () => {
    revision.current = {};
    controller.retire();
    setError(null);
  };
  const choose = (candidate: AttachmentSearchCandidate, checked: boolean) => {
    invalidate();
    setSelected((old) =>
      checked ? [...old, candidate] : old.filter((s) => s.id !== candidate.id),
    );
  };
  const clearInvalidSelection = (event?: {
    currentTarget: HTMLButtonElement;
  }) => {
    if (!live.current.active || controller.active()) return;
    const fieldset = selectionFieldset.current;
    if (
      fieldset &&
      event &&
      fieldset.ownerDocument.activeElement === event.currentTarget
    )
      fieldset.focus();
    invalidate();
    const current = threads.getSnapshot(),
      currentKeys = live.current.rows.map((row) => row.key);
    setSelected((old) =>
      old.filter((source) =>
        attachmentSearchSourceCurrent(
          source,
          current.threads,
          currentKeys,
          current.index,
        ),
      ),
    );
  };
  const captureOwner = () => {
    const token = revision.current,
      captured = selected;
    return () =>
      mounted.current &&
      revision.current === token &&
      live.current.active &&
      live.current.query === query &&
      live.current.scopeKey === scopeKey &&
      live.current.selected === captured &&
      captured.every((s) =>
        attachmentSearchSourceCurrent(
          s,
          threads.getSnapshot().threads,
          live.current.rows.map((r) => r.key),
          threads.getSnapshot().index,
        ),
      );
  };
  const start = () => {
    setError(null);
    void controller.start(query, selected, captureOwner());
  };
  const canStart =
    active &&
    validSources &&
    selected.length > 0 &&
    validAttachmentSearchQuery(query) &&
    !controller.active();
  const title = (key: string) => rows.find((r) => r.key === key)?.title || key;
  const visible = active && validSources && state.phase !== "idle";
  return (
    <section className="history-search-panel" aria-label={S.title}>
      <h2>{S.title}</h2>
      <p>{S.limits}</p>
      <p>
        {S.coverage(
          candidates.unloaded,
          candidates.unavailable,
          candidates.omitted,
        )}
      </p>
      <fieldset
        ref={selectionFieldset}
        tabIndex={-1}
        disabled={!active || controller.active()}
      >
        <legend>
          {S.choose} · {S.selected(selected.length)}
        </legend>
        {!candidates.candidates.length && <p>{S.emptyCandidates}</p>}
        <div className="history-search-candidates">
          {candidates.candidates.map((candidate) => {
            const checked = selected.some((s) => s.id === candidate.id);
            return (
              <label key={candidate.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={
                    !candidate.path ||
                    (!checked &&
                      !attachmentSearchSourceCurrent(
                        candidate,
                        snapshot.threads,
                        keys,
                        snapshot.index,
                      )) ||
                    (!checked && selected.length >= 20)
                  }
                  onChange={(e) => choose(candidate, e.target.checked)}
                />
                <span>
                  {candidate.name}
                  <small>
                    {title(candidate.threadKey)} ·{" "}
                    {candidate.role === "user" ? S.user : S.agent} ·{" "}
                    {S.received}
                  </small>
                  <small>
                    {candidate.path
                      ? `${S.currentFile} · ${candidate.path}`
                      : S.notLocal}
                  </small>
                  {candidate.path && (
                    <small>
                      {attachmentSearchIsDocx(candidate)
                        ? S.docxCandidate
                        : attachmentSearchIsXlsx(candidate)
                          ? S.xlsxCandidate
                          : attachmentSearchIsPdf(candidate)
                            ? S.pdfCandidate
                            : attachmentSearchIsPptx(candidate)
                              ? S.pptxCandidate
                              : S.textCandidate}
                    </small>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {active && validSources && selected.some(attachmentSearchIsPptx) && (
        <>
          <p>{S.pptxScope}</p>
          <details className="history-search-coverage">
            <summary>{S.pptxDetails}</summary>
            <p>{S.pptxFormatting}</p>
            <p>{S.pptxBarriers}</p>
          </details>
        </>
      )}
      {active && validSources && selected.some(attachmentSearchIsPdf) && (
        <div className="history-search-boundary">
          <p>{S.pdfScope}</p>
          <p>
            {S.pdfWarnings.decodedTextOnly} {S.pdfBarriers} {S.pdfLimits}
          </p>
        </div>
      )}
      <div className="history-search-actions">
        {!validSources && selected.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!active || controller.active()}
            onClick={clearInvalidSelection}
          >
            {S.clearInvalidSelection}
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canStart}
          onClick={start}
        >
          {state.phase === "pending" ? S.retry : S.start}
        </button>
        {state.phase === "reading" && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => controller.cancel()}
          >
            {S.cancel}
          </button>
        )}
      </div>
      <div role="status">
        {query.trim() && !validAttachmentSearchQuery(query) && (
          <p>{S.invalidQuery}</p>
        )}
        {state.previousPending && <p>{S.previousPending}</p>}
        {!validSources ? (
          <p>{S.stale}</p>
        ) : visible ? (
          <p>{S[state.phase as Exclude<typeof state.phase, "idle">]}</p>
        ) : (
          <p>{S.enter}</p>
        )}
        {visible && (
          <p>
            {S.summary(
              state.rows.filter((r) => r.state === "searched").length,
              state.rows.length,
              state.matches,
              state.hits.length,
            )}
          </p>
        )}
        {visible && state.matches > state.hits.length && (
          <p>{S.omittedHits(state.matches - state.hits.length)}</p>
        )}
        {visible &&
          (state.phase === "complete" || state.phase === "reading") &&
          state.rows.some(
            (row) => row.state === "searched" && row.document?.partial,
          ) && <p>{S.docxPartial}</p>}
        {visible &&
          (state.phase === "complete" || state.phase === "reading") &&
          state.rows.some(
            (row) => row.state === "searched" && row.workbook,
          ) && <p>{S.xlsxCache}</p>}
        {visible &&
          (state.phase === "complete" || state.phase === "reading") &&
          state.rows.some(
            (row) => row.state === "searched" && row.workbook?.partial,
          ) && <p>{S.xlsxPartial}</p>}
        {visible &&
          (state.phase === "complete" || state.phase === "reading") &&
          state.rows.some((row) => row.state === "searched" && row.pdf) && (
            <>
              <p>{S.pdfPartial}</p>
              {state.rows
                .filter((row) => row.state === "searched" && row.pdf)
                .map((row) => (
                  <p key={row.source.id}>
                    {row.source.name} · {S.pdfPages(row.pdf!.scope.pageCount)}
                  </p>
                ))}
            </>
          )}
        {visible &&
          (state.phase === "complete" || state.phase === "reading") &&
          state.rows.some(
            (row) => row.state === "searched" && row.presentation,
          ) && (
            <>
              <p>{S.pptxPartial}</p>
              {state.rows
                .filter((row) => row.state === "searched" && row.presentation)
                .map((row) => (
                  <p key={row.source.id}>
                    {row.source.name} ·{" "}
                    {S.pptxSlides(row.presentation!.slideCount)}
                  </p>
                ))}
            </>
          )}
        {visible &&
          (state.phase === "complete" || state.phase === "reading") &&
          state.rows.some((row) => row.code === "scopeEmpty") && (
            <p>{S.errors.scopeEmpty}</p>
          )}
        {visible &&
          (state.phase === "complete" || state.phase === "reading") &&
          state.rows.some((row) => row.code === "pdfNoText") && (
            <p>{S.errors.pdfNoText}</p>
          )}
      </div>
      {(error || state.error) && (
        <p role="alert">{error ?? S.errors[state.error!]}</p>
      )}
      {visible && (
        <details className="history-search-coverage">
          <summary>{S.details}</summary>
          <ul>
            {state.rows.map((row) => (
              <li key={row.source.id}>
                {row.source.name} · {S.rowStates[row.state]}
                {row.code && <small>{S.errors[row.code]}</small>}
                {row.document && (
                  <>
                    <small>{S.docxScope}</small>
                    {row.document.partial && <small>{S.docxPartial}</small>}
                    {!!row.document.imageReferences && (
                      <small>
                        {S.docxImages(row.document.imageReferences)}
                      </small>
                    )}
                    {row.document.warnings.map((warning) => (
                      <small key={warning.code}>
                        {S.docxWarnings[warning.code]}
                      </small>
                    ))}
                  </>
                )}
                {row.workbook && (
                  <>
                    <small>{S.xlsxScope}</small>
                    <small>{S.xlsxCache}</small>
                    {row.workbook.partial && <small>{S.xlsxPartial}</small>}
                    {row.workbook.warnings.map((warning) => (
                      <small key={warning.code}>
                        {xlsxSearchWarningLabel(warning)}
                      </small>
                    ))}
                  </>
                )}
                {row.pdf && (
                  <>
                    <small>{S.pdfPartial}</small>
                    <small>{S.pdfPages(row.pdf.scope.pageCount)}</small>
                    {row.pdf.warnings.map((warning) => (
                      <small key={warning.code}>
                        {pdfSearchWarningLabel(warning)}
                      </small>
                    ))}
                  </>
                )}
                {row.presentation && (
                  <>
                    <small>{S.pptxScope}</small>
                    <small>{S.pptxPartial}</small>
                    <small>{S.pptxFormatting}</small>
                    <small>{S.pptxBarriers}</small>
                    <small>{S.pptxSlides(row.presentation.slideCount)}</small>
                    {!!row.presentation.imageReferences && (
                      <small>
                        {S.pptxImages(row.presentation.imageReferences)}
                      </small>
                    )}
                    {row.presentation.warnings.map((warning, index) => (
                      <small
                        key={`${warning.code}:${warning.slideId ?? ""}:${index}`}
                      >
                        {pptxSearchWarningLabel(warning)}
                      </small>
                    ))}
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {visible && state.phase === "complete" && (
        <>
          <h3>{S.results}</h3>
          <p>{S.locationHint}</p>
          {!state.hits.length && <p>{S.empty}</p>}
          <ul className="history-search-hits">
            {state.hits.map((hit, index) => (
              <li key={index} className="history-search-hit">
                <strong>
                  {hit.source.name} · {title(hit.source.threadKey)}
                </strong>
                {hit.location && (
                  <small>{attachmentSearchLocationLabel(hit.location)}</small>
                )}
                <span className="history-search-excerpt">
                  {hit.before}
                  <mark>{hit.match}</mark>
                  {hit.after}
                </span>
                <button
                  type="button"
                  className="btn btn-text"
                  disabled={locating || !onSelect}
                  onClick={async () => {
                    if (locating) return;
                    const owner = captureOwner();
                    setLocating(true);
                    setError(null);
                    const ok = await controller.verifyHit(hit, owner);
                    setLocating(false);
                    if (!owner()) return;
                    if (!ok) {
                      setError(
                        S.errors[
                          controller.snapshot().error ??
                            (controller.snapshot().phase === "pending"
                              ? "pending"
                              : "changed")
                        ],
                      );
                      return;
                    }
                    onSelect?.(
                      hit.source,
                      owner,
                      hit.location &&
                        "kind" in hit.location &&
                        hit.location.kind === "pdf"
                        ? {
                            file: hit.file,
                            pageNumber: hit.location.pageNumber,
                          }
                        : undefined,
                    );
                  }}
                >
                  {locating ? S.checking : S.navigate}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
