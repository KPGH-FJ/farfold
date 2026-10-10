import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  DocxBlock,
  DocxImage,
  DocxParagraph,
  DocxPreview,
  DocxRun,
  DocxTable,
} from "../runtime/docx_types";
import {
  createDocumentFeedbackSource,
  documentFeedbackBlockIsEligible,
  documentFeedbackTarget,
  retireDocumentFeedbackSource,
  type DocumentFeedbackSource,
} from "../runtime/docx_feedback_target";
import type {
  OfficeTargetAvailability,
  OfficeTargetConfirmation,
} from "../runtime/office_feedback_target";
import { DocumentImages } from "../runtime/document_images";
import {
  DOCUMENT_STRINGS as S,
  DOCUMENT_WARNINGS,
} from "../runtime/document_strings";
import {
  DOCUMENT_WINDOW,
  cellExcerpt,
  documentCellStyle,
  documentParagraphStyle,
  documentTableWindow,
  documentTextStyle,
  paragraphParts,
  type DocumentCellPosition,
} from "../runtime/document_view";

import {
  DocumentReadingWindows,
  restoredDocumentPosition,
  saveReadingPosition,
  type PreviewReadingPositionRef,
} from "../runtime/preview_reading_position";

type FeedbackBlock = DocxParagraph | DocxTable;
type FeedbackSelection = { owner: object; block: FeedbackBlock };
function useDocumentFeedback({
  document,
  reading,
  interactionBlocked,
  isCurrent,
  onOfficeTargetAvailability,
  onOfficeTargetConfirm,
}: {
  document: DocxPreview;
  reading: DocumentReadingWindows;
  interactionBlocked: boolean;
  isCurrent?: () => boolean;
  onOfficeTargetAvailability?: (value: OfficeTargetAvailability) => void;
  onOfficeTargetConfirm?: (value: OfficeTargetConfirmation) => void;
}) {
  const latest = useRef({
    document,
    interactionBlocked,
    isCurrent,
    onOfficeTargetAvailability,
    onOfficeTargetConfirm,
  });
  latest.current = {
    document,
    interactionBlocked,
    isCurrent,
    onOfficeTargetAvailability,
    onOfficeTargetConfirm,
  };
  const mounted = useRef(false);
  const selected = useRef<FeedbackSelection | null>(null);
  const [selection, setSelection] = useState<FeedbackSelection | null>(null);
  const live = useRef<{
    source: DocumentFeedbackSource;
    owner: object;
    block: FeedbackBlock;
  } | null>(null);
  const currentView = () =>
    latest.current.document === document &&
    !latest.current.interactionBlocked &&
    latest.current.isCurrent?.() !== false;
  const allowed = () => mounted.current && currentView();
  const retire = () => {
    const old = live.current;
    live.current = null;
    if (old) {
      retireDocumentFeedbackSource(old.source);
      latest.current.onOfficeTargetAvailability?.({
        source: old.source,
        available: false,
      });
    }
  };
  const withdraw = () => {
    selected.current = null;
    setSelection(null);
    retire();
  };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      retire();
    };
  }, [document]);
  return {
    document,
    reading,
    interactionBlocked,
    selection,
    integrated: !!onOfficeTargetConfirm,
    allowed,
    navigate: (action: () => void) => {
      if (!allowed()) return;
      withdraw();
      if (!allowed()) return;
      action();
    },
    choose: (owner: object, block: FeedbackBlock) => {
      if (!allowed() || !latest.current.onOfficeTargetConfirm) return;
      if (selected.current?.owner === owner && selected.current.block === block)
        return;
      retire();
      selected.current = { owner, block };
      setSelection(selected.current);
    },
    register: (owner: object, block: FeedbackBlock) => {
      // Child layout setup precedes the parent setup during an effect replay.
      // Registration is called only by a mounted control; events still require
      // the complete mounted/current guard above.
      if (
        !currentView() ||
        !latest.current.onOfficeTargetConfirm ||
        selected.current?.owner !== owner ||
        selected.current.block !== block
      )
        return null;
      const source = createDocumentFeedbackSource({
        preview: document,
        block,
        expectedFile: document.file,
      });
      if (!source) return null;
      retire();
      live.current = { source, owner, block };
      latest.current.onOfficeTargetAvailability?.({ source, available: true });
      return source;
    },
    unregister: (source: DocumentFeedbackSource) => {
      if (live.current?.source === source) retire();
      else retireDocumentFeedbackSource(source);
    },
    cancel: (source: DocumentFeedbackSource, owner: object) => {
      if (
        !allowed() ||
        live.current?.source !== source ||
        live.current.owner !== owner
      )
        return false;
      withdraw();
      return allowed() && selected.current === null;
    },
    confirm: (
      source: DocumentFeedbackSource,
      owner: object,
      block: FeedbackBlock,
    ) => {
      if (
        !allowed() ||
        live.current?.source !== source ||
        live.current.owner !== owner ||
        live.current.block !== block ||
        selected.current?.owner !== owner ||
        selected.current.block !== block
      )
        return;
      const anchor = documentFeedbackTarget(source);
      if (anchor) latest.current.onOfficeTargetConfirm?.({ source, anchor });
    },
  };
}
type Feedback = ReturnType<typeof useDocumentFeedback>;
function FeedbackControls({
  block,
  feedback,
}: {
  block: FeedbackBlock;
  feedback: Feedback;
}) {
  const owner = useRef({});
  const selectButton = useRef<HTMLButtonElement | null>(null);
  const mounted = useRef(false);
  const latest = useRef({ block, feedback });
  latest.current = { block, feedback };
  const [source, setSource] = useState<DocumentFeedbackSource | null>(null);
  const selected =
    feedback.selection?.owner === owner.current &&
    feedback.selection.block === block;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (!selected || !feedback.integrated || feedback.interactionBlocked) {
      setSource(null);
      return;
    }
    const value = feedback.register(owner.current, block);
    setSource(value);
    return () => {
      if (value) feedback.unregister(value);
      setSource(null);
    };
  }, [
    selected,
    block,
    feedback.document,
    feedback.integrated,
    feedback.interactionBlocked,
  ]);
  if (!feedback.integrated || !documentFeedbackBlockIsEligible(block))
    return null;
  const current = () =>
    mounted.current &&
    latest.current.block === block &&
    latest.current.feedback.allowed();
  return (
    <div
      className="document-feedback-controls"
      data-document-feedback={block.id}
    >
      <button
        type="button"
        className="btn btn-ghost"
        aria-pressed={selected}
        ref={selectButton}
        onClick={() => {
          if (current()) latest.current.feedback.choose(owner.current, block);
        }}
      >
        {block.kind === "paragraph" ? S.selectParagraph : S.selectTable}
      </button>
      {selected && source && !feedback.interactionBlocked && (
        <>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (current())
                latest.current.feedback.confirm(source, owner.current, block);
            }}
          >
            {block.kind === "paragraph" ? S.feedbackParagraph : S.feedbackTable}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (
                !current() ||
                !latest.current.feedback.cancel(source, owner.current)
              )
                return;
              // Withdrawal can synchronously leave or replace this display.
              if (current() && selectButton.current?.isConnected)
                selectButton.current.focus({ preventScroll: true });
            }}
          >
            {S.cancelSelection}
          </button>
          <span className="document-scope">
            {block.kind === "paragraph"
              ? S.feedbackParagraphScope
              : S.feedbackTableScope}
          </span>
        </>
      )}
    </div>
  );
}

type Images = DocumentImages;
function DocumentImage({
  image,
  run,
  images,
}: {
  image: DocxImage | undefined;
  run: Extract<DocxRun, { kind: "image" }>;
  images: Images;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!image) return;
    let resource: ReturnType<Images["acquire"]>;
    try {
      resource = images.acquire(image.id);
    } catch {
      setFailed(true);
      return;
    }
    if (!resource) return;
    setUrl(resource.url);
    return () => {
      resource.release();
      setUrl(null);
    };
  }, [image, images]);
  if (!image || failed)
    return (
      <span className="document-notice" role="alert">
        {S.imageFailed}
      </span>
    );
  return url ? (
    <img
      src={url}
      alt={run.alt || S.image}
      loading="lazy"
      decoding="async"
      style={{
        width: `${Math.min(1200, Math.max(1, run.widthPt))}pt`,
        maxWidth: "100%",
        height: "auto",
        aspectRatio: `${run.widthPt} / ${run.heightPt}`,
      }}
      onError={() => setFailed(true)}
    />
  ) : null;
}
function Runs({ runs, images }: { runs: DocxRun[]; images: Images }) {
  return runs.map((run, i) => {
    switch (run.kind) {
      case "text":
        return (
          <span key={i} style={documentTextStyle(run.style)}>
            {run.text}
          </span>
        );
      case "tab":
        return (
          <span key={i} className="document-tab">
            {"\t"}
          </span>
        );
      case "break":
        return run.page ? (
          <span
            key={i}
            className="document-page-break"
            role="separator"
            aria-label={S.manualBreak}
          >
            <span>{S.manualBreak}</span>
          </span>
        ) : (
          <br key={i} />
        );
      case "image":
        return (
          <DocumentImage
            key={`${i}:${run.imageId}`}
            image={images.get(run.imageId)}
            run={run}
            images={images}
          />
        );
      case "notice":
        return (
          <span key={i} className="document-notice">
            {DOCUMENT_WARNINGS[run.code]}
          </span>
        );
    }
  });
}
function Pagination({
  page,
  pages,
  onChange,
  label,
}: {
  page: number;
  pages: number;
  onChange: (n: number) => void;
  label: string;
}) {
  return pages > 1 ? (
    <div className="document-pagination">
      <button
        type="button"
        className="btn btn-ghost"
        disabled={!page}
        onClick={() => onChange(page - 1)}
      >
        {S.previous}
      </button>
      <span role="status">{label}</span>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={page >= pages - 1}
        onClick={() => onChange(page + 1)}
      >
        {S.next}
      </button>
    </div>
  ) : null;
}
function Paragraph({
  block,
  images,
  feedback,
}: {
  block: DocxParagraph;
  images: Images;
  feedback: Feedback;
}) {
  const [part, setPart] = useState(() => feedback.reading.paragraph(block));
  const parts = useMemo(() => paragraphParts(block.runs), [block]);
  const level = block.headingLevel;
  return (
    <div className="document-paragraph">
      <FeedbackControls block={block} feedback={feedback} />
      {parts.length > 1 && <p className="document-scope">{S.paragraphSplit}</p>}
      <Pagination
        page={part}
        pages={parts.length}
        onChange={(next) =>
          feedback.navigate(() => {
            feedback.reading.save(block, { kind: "paragraph", part: next });
            setPart(next);
          })
        }
        label={S.paragraphPart(part + 1, parts.length)}
      />
      <p
        style={documentParagraphStyle(block.style)}
        role={level ? "heading" : undefined}
        aria-level={level}
      >
        {part === 0 && block.list && (
          <span className="document-list-label">{block.list.label} </span>
        )}
        <Runs runs={parts[part] ?? []} images={images} />
      </p>
    </div>
  );
}

function Table({
  block,
  images,
  feedback,
}: {
  block: DocxTable;
  images: Images;
  feedback: Feedback;
}) {
  const [row, setRow] = useState(() => feedback.reading.table(block).row);
  const [column, setColumn] = useState(
    () => feedback.reading.table(block).column,
  );
  const move = (nextRow: number, nextColumn: number) =>
    feedback.navigate(() => {
      feedback.reading.save(block, {
        kind: "table",
        row: nextRow,
        column: nextColumn,
      });
      setRow(nextRow);
      setColumn(nextColumn);
    });
  const [selection, setSelection] = useState<DocumentCellPosition | null>(null);
  const focusTarget = useRef<string | null>(null);
  const detail = useRef<HTMLDivElement | null>(null);
  const grid = useRef<HTMLDivElement | null>(null);
  const window = useMemo(
    () => documentTableWindow(block, row, column),
    [block, row, column],
  );
  useEffect(() => {
    grid.current?.scrollTo({ top: 0, left: 0 });
  }, [row, column]);
  useEffect(() => {
    if (selection) detail.current?.focus();
  }, [selection]);
  useLayoutEffect(() => {
    if (!selection && focusTarget.current) {
      grid.current
        ?.querySelector<HTMLButtonElement>(
          `[data-document-cell="${focusTarget.current}"]`,
        )
        ?.focus();
      focusTarget.current = null;
    }
  }, [selection]);
  const widths = Array.from({ length: window.endColumn - column }, (_, i) =>
    Math.min(360, Math.max(18, block.columnsPt[column + i] ?? 90)),
  );
  return (
    <section className="document-table" aria-label={S.table}>
      {!selection && <FeedbackControls block={block} feedback={feedback} />}
      {selection?.cell && (
        <div className="document-cell-detail" tabIndex={-1} ref={detail}>
          <strong>
            {S.cell(selection.sourceRow + 1, selection.sourceColumn + 1)}
          </strong>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => feedback.navigate(() => setSelection(null))}
          >
            {S.backTable}
          </button>
          {(selection.cell.rowSpan > 1 || selection.cell.columnSpan > 1) && (
            <p>
              {S.merge(
                selection.sourceRow + 1,
                selection.sourceColumn + 1,
                selection.cell.rowSpan,
                selection.cell.columnSpan,
              )}
            </p>
          )}
          <BlockSequence
            blocks={selection.cell.blocks}
            images={images}
            feedback={feedback}
          />
        </div>
      )}
      {!selection && (
        <div>
          <p className="document-scope">{S.tableScope}</p>
          <div className="document-pagination">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!row}
              onClick={() =>
                move(Math.max(0, row - DOCUMENT_WINDOW.rows), column)
              }
            >
              {S.previousRows}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={window.endRow >= block.rows.length}
              onClick={() => move(row + DOCUMENT_WINDOW.rows, column)}
            >
              {S.nextRows}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!column}
              onClick={() =>
                move(row, Math.max(0, column - DOCUMENT_WINDOW.columns))
              }
            >
              {S.previousColumns}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={window.endColumn >= window.columns}
              onClick={() => move(row, column + DOCUMENT_WINDOW.columns)}
            >
              {S.nextColumns}
            </button>
          </div>
          <p role="status" className="document-scope">
            {S.tableRange(row + 1, window.endRow, column + 1, window.endColumn)}
          </p>
          <div
            ref={grid}
            className="document-table-scroll"
            tabIndex={0}
            aria-label={S.table}
          >
            <table
              style={{ width: `${widths.reduce((sum, n) => sum + n, 0)}pt` }}
            >
              <caption>{S.table}</caption>
              <colgroup>
                {widths.map((width, i) => (
                  <col key={column + i} style={{ width: `${width}pt` }} />
                ))}
              </colgroup>
              <tbody>
                {window.rows.map((cells, offset) => (
                  <tr key={row + offset}>
                    {cells.map((position) => {
                      const { cell } = position;
                      const excerpt = cell && cellExcerpt(cell.blocks);
                      const paragraph =
                        cell?.blocks.length === 1 &&
                        cell.blocks[0].kind === "paragraph"
                          ? cell.blocks[0]
                          : null;
                      return (
                        <td
                          key={position.column}
                          rowSpan={position.rowSpan}
                          colSpan={position.columnSpan}
                          style={cell ? documentCellStyle(cell) : undefined}
                        >
                          {cell && (
                            <button
                              type="button"
                              className="document-cell"
                              data-document-cell={`${position.row}:${position.column}`}
                              aria-label={S.openCell(
                                position.sourceRow + 1,
                                position.sourceColumn + 1,
                              )}
                              onClick={() =>
                                feedback.navigate(() => {
                                  focusTarget.current = `${position.row}:${position.column}`;
                                  setSelection(position);
                                })
                              }
                            >
                              <span
                                className="document-cell-excerpt"
                                style={
                                  paragraph
                                    ? documentParagraphStyle(paragraph.style)
                                    : undefined
                                }
                              >
                                {paragraph?.list && (
                                  <span>{paragraph.list.label} </span>
                                )}
                                {excerpt?.runs.length ? (
                                  <Runs runs={excerpt.runs} images={images} />
                                ) : (
                                  "\u00a0"
                                )}
                              </span>
                              {!excerpt?.complete && (
                                <span className="document-scope">
                                  {S.cellSummary}
                                </span>
                              )}
                              {position.clipped && (
                                <span className="document-scope">
                                  {S.clippedMerge}
                                </span>
                              )}
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function BlockSequence({
  blocks,
  images,
  initialSegment = 0,
  onPosition,
  feedback,
}: {
  blocks: DocxBlock[];
  images: Images;
  initialSegment?: number;
  onPosition?: (segment: number) => void;
  feedback: Feedback;
}) {
  const [page, setPage] = useState(initialSegment);
  useLayoutEffect(() => {
    onPosition?.(page);
  }, [page, onPosition]);
  const region = useRef<HTMLDivElement | null>(null);
  const pages = Math.max(1, Math.ceil(blocks.length / DOCUMENT_WINDOW.blocks));
  const show = (next: number) => {
    feedback.navigate(() => {
      setPage(next);
      region.current?.scrollTo({ top: 0, left: 0 });
    });
  };
  return (
    <div className="document-block-sequence">
      <Pagination
        page={page}
        pages={pages}
        onChange={show}
        label={S.part(page + 1, pages)}
      />
      <div className="document-surface" ref={region} tabIndex={0}>
        {!blocks.length && <p>{S.empty}</p>}
        {blocks
          .slice(
            page * DOCUMENT_WINDOW.blocks,
            (page + 1) * DOCUMENT_WINDOW.blocks,
          )
          .map((block) => {
            let node: ReactNode;
            switch (block.kind) {
              case "paragraph":
                node = (
                  <Paragraph
                    block={block}
                    images={images}
                    feedback={feedback}
                  />
                );
                break;
              case "table":
                node = (
                  <Table block={block} images={images} feedback={feedback} />
                );
                break;
              case "notice":
                node = (
                  <p className="document-notice">
                    {DOCUMENT_WARNINGS[block.code]}
                  </p>
                );
                break;
            }
            return <div key={block.id}>{node}</div>;
          })}
      </div>
    </div>
  );
}

export function DocxDocumentView({
  document,
  readingPosition,
  interactionBlocked = false,
  isCurrent,
  onOfficeTargetAvailability,
  onOfficeTargetConfirm,
}: {
  document: DocxPreview;
  readingPosition?: PreviewReadingPositionRef;
  interactionBlocked?: boolean;
  isCurrent?: () => boolean;
  onOfficeTargetAvailability?: (value: OfficeTargetAvailability) => void;
  onOfficeTargetConfirm?: (value: OfficeTargetConfirmation) => void;
}) {
  const reading = useMemo(
    () => new DocumentReadingWindows(document, readingPosition),
    [document, readingPosition],
  );
  useLayoutEffect(() => reading.activate(), [reading]);
  const renderOwner = useRef({ document, index: 0 });
  if (renderOwner.current.document !== document)
    renderOwner.current = { document, index: renderOwner.current.index + 1 };
  const feedback = useDocumentFeedback({
    document,
    reading,
    interactionBlocked,
    isCurrent,
    onOfficeTargetAvailability,
    onOfficeTargetConfirm,
  });
  const restored = restoredDocumentPosition(document, readingPosition);
  const [choice, setChoice] = useState<{
    source: DocxPreview;
    id: string;
  } | null>(null);
  const story =
    choice?.source === document ? choice.id : (restored.story?.id ?? "");
  const images = useMemo(() => new DocumentImages(document.images), [document]);
  const selected = document.stories.find((item) => item.id === story);
  return (
    <>
      <p className="document-scope">{S.snapshot}</p>
      <p className="document-scope">{S.layout}</p>
      {document.partial && (
        <p className="document-notice" role="status">
          {S.partial}
        </p>
      )}
      {document.warnings.length > 0 && (
        <details className="document-warnings">
          <summary>
            {S.warnings} ({document.warnings.length})
          </summary>
          <ul>
            {document.warnings.map((warning) => (
              <li key={warning.code}>
                {DOCUMENT_WARNINGS[warning.code]}
                {warning.count > 1 ? ` (${warning.count})` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      {document.stories.length > 0 && (
        <label className="document-region-select">
          {S.sections}
          <select
            aria-label={S.sections}
            value={story}
            onChange={(event) =>
              feedback.navigate(() =>
                setChoice({ source: document, id: event.target.value }),
              )
            }
          >
            <option value="">{S.body}</option>
            {document.stories.map((item, i) => (
              <option key={item.id} value={item.id}>
                {S[item.kind]}{" "}
                {item.noteId === undefined ? i + 1 : S.noteId(item.noteId)}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && <p className="document-scope">{S.separateStory}</p>}
      <BlockSequence
        key={`${document.file.root}:${document.file.resolvedPath}:${document.file.version}:${document.file.sha256}:${renderOwner.current.index}:${selected?.id ?? "body"}`}
        blocks={selected?.blocks ?? document.blocks}
        feedback={feedback}
        images={images}
        initialSegment={
          (selected?.id ?? "") === (restored.story?.id ?? "")
            ? restored.segment
            : 0
        }
        onPosition={(segment) =>
          saveReadingPosition(readingPosition, document.file, {
            kind: "document",
            story: selected
              ? {
                  id: selected.id,
                  kind: selected.kind,
                  ...(selected.noteId === undefined
                    ? {}
                    : { noteId: selected.noteId }),
                }
              : null,
            segment,
          })
        }
      />
    </>
  );
}
