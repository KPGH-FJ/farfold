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
}: {
  block: DocxParagraph;
  images: Images;
}) {
  const [part, setPart] = useState(0);
  const parts = useMemo(() => paragraphParts(block.runs), [block]);
  const level = block.headingLevel;
  return (
    <div className="document-paragraph">
      {parts.length > 1 && <p className="document-scope">{S.paragraphSplit}</p>}
      <Pagination
        page={part}
        pages={parts.length}
        onChange={setPart}
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

function Table({ block, images }: { block: DocxTable; images: Images }) {
  const [row, setRow] = useState(0);
  const [column, setColumn] = useState(0);
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
      {selection?.cell && (
        <div className="document-cell-detail" tabIndex={-1} ref={detail}>
          <strong>
            {S.cell(selection.sourceRow + 1, selection.sourceColumn + 1)}
          </strong>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => setSelection(null)}
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
          <BlockSequence blocks={selection.cell.blocks} images={images} />
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
              onClick={() => setRow(Math.max(0, row - DOCUMENT_WINDOW.rows))}
            >
              {S.previousRows}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={window.endRow >= block.rows.length}
              onClick={() => setRow(row + DOCUMENT_WINDOW.rows)}
            >
              {S.nextRows}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!column}
              onClick={() =>
                setColumn(Math.max(0, column - DOCUMENT_WINDOW.columns))
              }
            >
              {S.previousColumns}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={window.endColumn >= window.columns}
              onClick={() => setColumn(column + DOCUMENT_WINDOW.columns)}
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
                              onClick={() => {
                                focusTarget.current = `${position.row}:${position.column}`;
                                setSelection(position);
                              }}
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
}: {
  blocks: DocxBlock[];
  images: Images;
}) {
  const [page, setPage] = useState(0);
  const region = useRef<HTMLDivElement | null>(null);
  const pages = Math.max(1, Math.ceil(blocks.length / DOCUMENT_WINDOW.blocks));
  const show = (next: number) => {
    setPage(next);
    region.current?.scrollTo({ top: 0, left: 0 });
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
                node = <Paragraph block={block} images={images} />;
                break;
              case "table":
                node = <Table block={block} images={images} />;
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

export function DocxDocumentView({ document }: { document: DocxPreview }) {
  const [story, setStory] = useState("");
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
            onChange={(event) => setStory(event.target.value)}
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
        key={selected?.id ?? "body"}
        blocks={selected?.blocks ?? document.blocks}
        images={images}
      />
    </>
  );
}
